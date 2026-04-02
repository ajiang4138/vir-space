import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

type ClientMessage =
  | { type: "create-room"; roomId: string; displayName: string }
  | { type: "join-room"; roomId: string; displayName: string }
  | { type: "leave-room"; roomId: string }
  | { type: "end-room"; roomId: string }
  | { type: "offer"; roomId: string; targetId: string; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; roomId: string; targetId: string; sdp: RTCSessionDescriptionInit }
  | { type: "ice-candidate"; roomId: string; targetId: string; candidate: RTCIceCandidateInit };

type ParticipantRole = "host" | "guest";

interface ParticipantSummary {
  peerId: string;
  displayName: string;
  role: ParticipantRole;
}

interface RoomStatePayload {
  roomId: string;
  hostPeerId: string;
  hostDisplayName: string;
  status: "active" | "closed";
  participants: ParticipantSummary[];
}

type ServerMessage =
  | {
      type: "room-created";
      roomId: string;
      peerId: string;
      role: ParticipantRole;
      room: RoomStatePayload;
    }
  | {
      type: "room-joined";
      roomId: string;
      peerId: string;
      role: ParticipantRole;
      room: RoomStatePayload;
    }
  | {
      type: "room-state";
      room: RoomStatePayload;
    }
  | {
      type: "participant-joined";
      roomId: string;
      participant: ParticipantSummary;
      room: RoomStatePayload;
    }
  | {
      type: "participant-left";
      roomId: string;
      peerId: string;
      room: RoomStatePayload;
    }
  | {
      type: "offer" | "answer";
      roomId: string;
      senderId: string;
      sdp: RTCSessionDescriptionInit;
    }
  | {
      type: "ice-candidate";
      roomId: string;
      senderId: string;
      candidate: RTCIceCandidateInit;
    }
  | {
      type: "peer-left";
      roomId: string;
      peerId: string;
    }
  | {
      type: "room-closed";
      roomId: string;
      reason: "host-ended" | "host-disconnected";
      message: string;
    }
  | {
      type: "error";
      message: string;
      roomId?: string;
      code?: string;
    };

interface ClientContext {
  id: string;
  socket: WebSocket;
  roomId?: string;
  displayName?: string;
  role?: ParticipantRole;
}

interface Room {
  roomId: string;
  hostPeerId: string;
  hostDisplayName: string;
  status: "active" | "closed";
  participants: Map<string, ClientContext>;
}

const PORT = Number(process.env.PORT ?? 8787);
const MAX_ROOM_PARTICIPANTS = 2;
const rooms = new Map<string, Room>();

const httpServer = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Vir Space signaling server is running. Use ws://localhost:8787 from the client.\n");
});

const wss = new WebSocketServer({ noServer: true });

function sendTo(client: ClientContext, message: ServerMessage): void {
  if (client.socket.readyState === WebSocket.OPEN) {
    client.socket.send(JSON.stringify(message));
  }
}

function sendError(client: ClientContext, message: string, roomId?: string): void {
  sendTo(client, { type: "error", message, roomId });
}

function getRoomStatePayload(room: Room): RoomStatePayload {
  const participants: ParticipantSummary[] = Array.from(room.participants.values()).map((member) => ({
    peerId: member.id,
    displayName: member.displayName ?? "Peer",
    role: member.role ?? "guest",
  }));

  return {
    roomId: room.roomId,
    hostPeerId: room.hostPeerId,
    hostDisplayName: room.hostDisplayName,
    status: room.status,
    participants,
  };
}

function broadcastRoomState(room: Room): void {
  const roomState = getRoomStatePayload(room);
  for (const member of room.participants.values()) {
    sendTo(member, {
      type: "room-state",
      room: roomState,
    });
  }
}

function getTargetInRoom(room: Room, targetId: string): ClientContext | undefined {
  return room.participants.get(targetId);
}

function closeRoom(room: Room, reason: "host-ended" | "host-disconnected"): void {
  // Host is the room owner; ending/disconnecting host terminates the room for every participant.
  room.status = "closed";
  const roomState = getRoomStatePayload(room);

  for (const member of room.participants.values()) {
    sendTo(member, {
      type: "room-closed",
      roomId: room.roomId,
      reason,
      message:
        reason === "host-ended" ? "Host ended the room" : "Host disconnected, session ended",
    });
    sendTo(member, {
      type: "room-state",
      room: roomState,
    });
  }

  for (const member of room.participants.values()) {
    member.roomId = undefined;
    member.role = undefined;
  }

  room.participants.clear();
}

function leaveRoom(client: ClientContext, reason: "leave-request" | "disconnect"): void {
  const { roomId } = client;
  if (!roomId) {
    return undefined;
  }

  const room = rooms.get(roomId);
  if (!room) {
    client.roomId = undefined;
    client.role = undefined;
    return;
  }

  const wasHost = client.id === room.hostPeerId;

  if (wasHost && room.status === "active") {
    // Unexpected host socket close and explicit host leave both use the same shutdown path.
    closeRoom(room, reason === "leave-request" ? "host-ended" : "host-disconnected");
    client.roomId = undefined;
    client.role = undefined;
    return;
  }

  if (!room.participants.has(client.id)) {
    client.roomId = undefined;
    client.role = undefined;
    return;
  }

  room.participants.delete(client.id);
  client.roomId = undefined;
  client.role = undefined;

  const roomState = getRoomStatePayload(room);
  for (const member of room.participants.values()) {
    sendTo(member, {
      type: "participant-left",
      roomId: room.roomId,
      peerId: client.id,
      room: roomState,
    });

    sendTo(member, {
      type: "peer-left",
      roomId: room.roomId,
      peerId: client.id,
    });
  }

  if (room.participants.size > 0) {
    broadcastRoomState(room);
  }
}

function createRoom(client: ClientContext, roomId: string, displayName: string): void {
  const existingRoom = rooms.get(roomId);
  if (existingRoom?.status === "active") {
    sendTo(client, {
      type: "error",
      roomId,
      code: "ROOM_EXISTS",
      message: "Room already exists",
    });
    return;
  }

  // A closed room is considered terminated and can be recreated with the same ID.
  if (existingRoom?.status === "closed") {
    rooms.delete(roomId);
  }

  leaveRoom(client, "leave-request");

  client.roomId = roomId;
  client.displayName = displayName;
  client.role = "host";

  const room: Room = {
    roomId,
    hostPeerId: client.id,
    hostDisplayName: displayName,
    status: "active",
    participants: new Map([[client.id, client]]),
  };

  rooms.set(roomId, room);

  sendTo(client, {
    type: "room-created",
    roomId,
    peerId: client.id,
    role: "host",
    room: getRoomStatePayload(room),
  });
}

function joinRoom(client: ClientContext, roomId: string, displayName: string): void {
  const room = rooms.get(roomId);
  if (!room) {
    sendTo(client, {
      type: "error",
      roomId,
      code: "ROOM_NOT_FOUND",
      message: "Room does not exist",
    });
    return;
  }

  if (room.status === "closed") {
    sendTo(client, {
      type: "error",
      roomId,
      code: "ROOM_CLOSED",
      message: "Room is closed",
    });
    return;
  }

  if (!room.participants.has(room.hostPeerId)) {
    sendTo(client, {
      type: "error",
      roomId,
      code: "HOST_MISSING",
      message: "Room host is not active",
    });
    return;
  }

  if (room.participants.size >= MAX_ROOM_PARTICIPANTS) {
    sendTo(client, {
      type: "error",
      roomId,
      code: "ROOM_FULL",
      message: "Room is full (max 2 peers)",
    });
    return;
  }

  leaveRoom(client, "leave-request");

  client.roomId = roomId;
  client.displayName = displayName;
  client.role = "guest";
  room.participants.set(client.id, client);

  const roomState = getRoomStatePayload(room);
  sendTo(client, {
    type: "room-joined",
    roomId,
    peerId: client.id,
    role: "guest",
    room: roomState,
  });

  for (const member of room.participants.values()) {
    if (member.id === client.id) {
      continue;
    }

    sendTo(member, {
      type: "participant-joined",
      roomId,
      participant: {
        peerId: client.id,
        displayName,
        role: "guest",
      },
      room: roomState,
    });
  }

  broadcastRoomState(room);
}

function handleRoomAction(
  client: ClientContext,
  message: Extract<ClientMessage, { type: "create-room" | "join-room" | "leave-room" | "end-room" }>,
): void {
  if (message.type === "leave-room") {
    if (client.roomId !== message.roomId) {
      const requestedRoom = rooms.get(message.roomId);
      if (requestedRoom && requestedRoom.hostPeerId === client.id && requestedRoom.status === "active") {
        // Defensive path: host requested leave with stale local room state, still terminate room.
        closeRoom(requestedRoom, "host-ended");
        client.roomId = undefined;
        client.role = undefined;
        return;
      }

      sendError(client, "Cannot leave a room you have not joined", message.roomId);
      return;
    }

    leaveRoom(client, "leave-request");
    return;
  }

  if (message.type === "end-room") {
    const room = rooms.get(message.roomId);
    if (!room) {
      sendTo(client, {
        type: "error",
        roomId: message.roomId,
        code: "ROOM_NOT_FOUND",
        message: "Room does not exist",
      });
      return;
    }

    if (room.hostPeerId !== client.id || room.status !== "active") {
      sendTo(client, {
        type: "error",
        roomId: message.roomId,
        code: "ONLY_HOST_CAN_END",
        message: "Only the active host can end the room",
      });
      return;
    }

    // Explicit host control for graceful room shutdown.
    closeRoom(room, "host-ended");
    return;
  }

  const roomId = message.roomId.trim();
  const displayName = message.displayName.trim();

  if (!roomId || !displayName) {
    sendError(client, "roomId and displayName are required", roomId);
    return;
  }

  if (message.type === "create-room") {
    createRoom(client, roomId, displayName);
    return;
  }

  joinRoom(client, roomId, displayName);
}

function handleRelay(
  client: ClientContext,
  message: Extract<ClientMessage, { type: "offer" | "answer" | "ice-candidate" }>,
): void {
  const roomId = client.roomId;
  if (!roomId || roomId !== message.roomId) {
    sendError(client, "You must join the room before sending signaling messages", message.roomId);
    return;
  }

  const room = rooms.get(roomId);
  if (!room || room.status !== "active") {
    sendError(client, "Room is not active", roomId);
    return;
  }

  const target = getTargetInRoom(room, message.targetId);
  if (!target || target.id === client.id) {
    sendError(client, "Target peer is not available", roomId);
    return;
  }

  if (message.type === "offer" || message.type === "answer") {
    sendTo(target, {
      type: message.type,
      roomId,
      senderId: client.id,
      sdp: message.sdp,
    });
    return;
  }

  sendTo(target, {
    type: "ice-candidate",
    roomId,
    senderId: client.id,
    candidate: message.candidate,
  });
}

wss.on("connection", (socket) => {
  const client: ClientContext = {
    id: randomUUID(),
    socket,
  };

  socket.on("message", (data) => {
    try {
      const raw = JSON.parse(data.toString()) as ClientMessage;
      if (
        raw.type === "create-room" ||
        raw.type === "join-room" ||
        raw.type === "leave-room" ||
        raw.type === "end-room"
      ) {
        handleRoomAction(client, raw);
        return;
      }

      if (raw.type === "offer" || raw.type === "answer" || raw.type === "ice-candidate") {
        handleRelay(client, raw);
        return;
      }

      sendError(client, "Unsupported message type");
    } catch {
      sendError(client, "Invalid JSON payload");
    }
  });

  socket.on("close", () => {
    leaveRoom(client, "disconnect");
  });

  socket.on("error", () => {
    leaveRoom(client, "disconnect");
  });
});

httpServer.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Signaling server listening on ws://localhost:${PORT}`);
});
