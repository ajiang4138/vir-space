import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

type SessionDescriptionPayload = {
  type?: string;
  sdp?: string;
};

type IceCandidatePayload = {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

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
  guestPeerId: string | null;
  guestDisplayName: string | null;
  status: "open" | "closed";
  participants: ParticipantSummary[];
}

type ClientMessage =
  | { type: "create-room"; roomId: string; displayName: string; roomPassword: string; userHash: string }
  | { type: "join-room"; roomId: string; displayName: string; roomPassword: string; userHash: string }
  | { type: "leave-room"; roomId: string }
  | { type: "end-room"; roomId: string }
  | { type: "kick-user"; roomId: string; targetPeerId: string }
  | { type: "chat-message"; roomId: string; text: string; senderDisplayName?: string }
  | { type: "offer"; roomId: string; targetPeerId: string; sdp: SessionDescriptionPayload }
  | { type: "answer"; roomId: string; targetPeerId: string; sdp: SessionDescriptionPayload }
  | { type: "ice-candidate"; roomId: string; targetPeerId: string; candidate: IceCandidatePayload };

type ServerMessage =
  | {
      type: "room-created";
      roomId: string;
      senderPeerId: string;
      role: ParticipantRole;
      room: RoomStatePayload;
    }
  | {
      type: "room-joined";
      roomId: string;
      senderPeerId: string;
      role: ParticipantRole;
      room: RoomStatePayload;
    }
  | { type: "room-state"; room: RoomStatePayload }
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
      type: "chat-message";
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
      text: string;
    }
  | {
      type: "offer" | "answer";
      roomId: string;
      senderPeerId: string;
      sdp: SessionDescriptionPayload;
    }
  | {
      type: "ice-candidate";
      roomId: string;
      senderPeerId: string;
      candidate: IceCandidatePayload;
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
      type: "user-kicked";
      roomId: string;
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
  userHash?: string;
}

interface Room {
  roomId: string;
  roomPassword: string;
  hostPeerId: string;
  hostDisplayName: string;
  guestPeerId: string | null;
  guestDisplayName: string | null;
  status: "open" | "closed";
  participants: Map<string, ClientContext>;
  bannedHashes: Set<string>;
}

const PORT = Number(process.env.PORT ?? 8787);
const minimumRoomPasswordLength = 4;
const maximumRoomParticipants = 6;
const rooms = new Map<string, Room>();

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Vir Space bootstrap signaling server is running. Use ws://localhost:8787 from clients.\n");
});

const wss = new WebSocketServer({ noServer: true });

function sendTo(client: ClientContext | undefined, message: ServerMessage): void {
  if (!client || client.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  client.socket.send(JSON.stringify(message));
}

function sendError(client: ClientContext, message: string, roomId?: string, code?: string): void {
  sendTo(client, { type: "error", message, roomId, code });
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
    guestPeerId: room.guestPeerId,
    guestDisplayName: room.guestDisplayName,
    status: room.status,
    participants,
  };
}

function broadcastRoomState(room: Room): void {
  const roomState = getRoomStatePayload(room);
  for (const member of room.participants.values()) {
    sendTo(member, { type: "room-state", room: roomState });
  }
}

function closeRoom(room: Room, reason: "host-ended" | "host-disconnected"): void {
  room.status = "closed";
  const roomState = getRoomStatePayload(room);

  for (const member of room.participants.values()) {
    sendTo(member, {
      type: "room-closed",
      roomId: room.roomId,
      reason,
      message: reason === "host-ended" ? "Host ended the room" : "Host disconnected",
    });
    sendTo(member, {
      type: "room-state",
      room: roomState,
    });

    member.roomId = undefined;
    member.role = undefined;
  }

  room.participants.clear();
  rooms.delete(room.roomId);
}

function leaveRoom(client: ClientContext, reason: "leave-request" | "disconnect"): void {
  const roomId = client.roomId;
  if (!roomId) {
    return;
  }

  const room = rooms.get(roomId);
  client.roomId = undefined;

  if (!room) {
    client.role = undefined;
    return;
  }

  const isHost = room.hostPeerId === client.id;
  if (isHost && room.status === "open") {
    closeRoom(room, reason === "leave-request" ? "host-ended" : "host-disconnected");
    client.role = undefined;
    return;
  }

  if (!room.participants.has(client.id)) {
    client.role = undefined;
    return;
  }

  room.participants.delete(client.id);
  if (room.guestPeerId === client.id) {
    room.guestPeerId = null;
    room.guestDisplayName = null;
  }

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

function createRoom(client: ClientContext, roomId: string, displayName: string, roomPassword: string, userHash: string): void {
  const existingRoom = rooms.get(roomId);
  if (existingRoom?.status === "open") {
    sendError(client, "Room already exists", roomId, "ROOM_EXISTS");
    return;
  }

  leaveRoom(client, "leave-request");

  client.roomId = roomId;
  client.displayName = displayName;
  client.role = "host";
  client.userHash = userHash;

  const room: Room = {
    roomId,
    roomPassword,
    hostPeerId: client.id,
    hostDisplayName: displayName,
    guestPeerId: null,
    guestDisplayName: null,
    status: "open",
    participants: new Map([[client.id, client]]),
    bannedHashes: new Set(),
  };

  rooms.set(roomId, room);

  sendTo(client, {
    type: "room-created",
    roomId,
    senderPeerId: client.id,
    role: "host",
    room: getRoomStatePayload(room),
  });
}

function joinRoom(client: ClientContext, roomId: string, displayName: string, roomPassword: string, userHash: string): void {
  const room = rooms.get(roomId);
  if (!room) {
    sendError(client, "Room does not exist", roomId, "ROOM_NOT_FOUND");
    return;
  }

  if (room.status !== "open") {
    sendError(client, "Room is closed", roomId, "ROOM_CLOSED");
    return;
  }

  if (room.bannedHashes.has(userHash)) {
    sendError(client, "You have been banned from this room", roomId, "USER_BANNED");
    return;
  }

  if (!room.participants.has(room.hostPeerId)) {
    sendError(client, "Host is not connected", roomId, "HOST_MISSING");
    return;
  }

  if (room.roomPassword !== roomPassword) {
    sendError(client, "Invalid room password", roomId, "ROOM_PASSWORD_INVALID");
    return;
  }

  if (room.participants.size >= maximumRoomParticipants) {
    sendError(client, `Room is full (max ${maximumRoomParticipants} peers)`, roomId, "ROOM_FULL");
    return;
  }

  leaveRoom(client, "leave-request");

  client.roomId = roomId;
  client.displayName = displayName;
  client.role = "guest";
  client.userHash = userHash;
  room.participants.set(client.id, client);
  room.guestPeerId = client.id;
  room.guestDisplayName = displayName;

  const roomState = getRoomStatePayload(room);

  sendTo(client, {
    type: "room-joined",
    roomId,
    senderPeerId: client.id,
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
      sendError(client, "Cannot leave a room you have not joined", message.roomId, "NOT_IN_ROOM");
      return;
    }

    leaveRoom(client, "leave-request");
    return;
  }

  if (message.type === "end-room") {
    const room = rooms.get(message.roomId);
    if (!room) {
      sendError(client, "Room does not exist", message.roomId, "ROOM_NOT_FOUND");
      return;
    }

    if (room.hostPeerId !== client.id || room.status !== "open") {
      sendError(client, "Only host can end room", message.roomId, "ONLY_HOST_CAN_END");
      return;
    }

    closeRoom(room, "host-ended");
    return;
  }

  const roomId = message.roomId.trim();
  const displayName = message.displayName.trim();
  const roomPassword = message.roomPassword.trim();
  const userHash = message.userHash.trim();

  if (!roomId || !displayName || !roomPassword || !userHash) {
    sendError(client, "roomId, displayName, roomPassword, and userHash are required", roomId, "BAD_REQUEST");
    return;
  }

  if (roomPassword.length < minimumRoomPasswordLength) {
    sendError(client, `roomPassword must be at least ${minimumRoomPasswordLength} characters`, roomId, "ROOM_PASSWORD_TOO_SHORT");
    return;
  }

  if (message.type === "create-room") {
    createRoom(client, roomId, displayName, roomPassword, userHash);
    return;
  }

  joinRoom(client, roomId, displayName, roomPassword, userHash);
}

function handleRelay(
  client: ClientContext,
  message: Extract<ClientMessage, { type: "offer" | "answer" | "ice-candidate" }>,
): void {
  const roomId = client.roomId;
  if (!roomId || roomId !== message.roomId) {
    sendError(client, "You must join room before signaling", message.roomId, "NOT_IN_ROOM");
    return;
  }

  const room = rooms.get(roomId);
  if (!room || room.status !== "open") {
    sendError(client, "Room is not active", roomId, "ROOM_CLOSED");
    return;
  }

  const target = room.participants.get(message.targetPeerId);
  if (!target || target.id === client.id) {
    sendError(client, "Target peer is not available", roomId, "TARGET_UNAVAILABLE");
    return;
  }

  if (message.type === "offer" || message.type === "answer") {
    sendTo(target, {
      type: message.type,
      roomId,
      senderPeerId: client.id,
      sdp: message.sdp,
    });
    return;
  }

  sendTo(target, {
    type: "ice-candidate",
    roomId,
    senderPeerId: client.id,
    candidate: message.candidate,
  });
}

function handleChatMessage(
  client: ClientContext,
  message: Extract<ClientMessage, { type: "chat-message" }>,
): void {
  const roomId = client.roomId;
  if (!roomId || roomId !== message.roomId) {
    sendError(client, "You must join room before sending chat", message.roomId, "NOT_IN_ROOM");
    return;
  }

  const room = rooms.get(roomId);
  if (!room || room.status !== "open") {
    sendError(client, "Room is not active", roomId, "ROOM_CLOSED");
    return;
  }

  const text = message.text.trim();
  if (!text) {
    return;
  }

  const senderDisplayName = client.displayName ?? message.senderDisplayName ?? "Peer";
  for (const member of room.participants.values()) {
    if (member.id === client.id) {
      continue;
    }

    sendTo(member, {
      type: "chat-message",
      roomId,
      senderPeerId: client.id,
      senderDisplayName,
      text,
    });
  }
}

function handleKickUser(client: ClientContext, message: Extract<ClientMessage, { type: "kick-user" }>): void {
  const roomId = client.roomId;
  if (!roomId || roomId !== message.roomId) {
    sendError(client, "You must join room before kicking", message.roomId, "NOT_IN_ROOM");
    return;
  }

  const room = rooms.get(roomId);
  if (!room || room.status !== "open") {
    sendError(client, "Room is not active", roomId, "ROOM_CLOSED");
    return;
  }

  if (room.hostPeerId !== client.id) {
    sendError(client, "Only host can kick users", message.roomId, "ONLY_HOST_CAN_KICK");
    return;
  }

  const targetClient = room.participants.get(message.targetPeerId);
  if (!targetClient) {
    sendError(client, "Target user not found", message.roomId, "USER_NOT_FOUND");
    return;
  }

  if (targetClient.id === room.hostPeerId) {
    sendError(client, "Cannot kick the host", message.roomId, "CANNOT_KICK_HOST");
    return;
  }

  // Ban the user's hash
  if (targetClient.userHash) {
    room.bannedHashes.add(targetClient.userHash);
  }

  // Send kick notification to the target user
  sendTo(targetClient, {
    type: "user-kicked",
    roomId,
    message: "You have been kicked from the room",
  });

  // Remove the kicked user from the room
  leaveRoom(targetClient, "leave-request");
}

wss.on("connection", (socket) => {
  const client: ClientContext = {
    id: randomUUID(),
    socket,
  };

  socket.on("message", (data) => {
    try {
      const raw = JSON.parse(data.toString()) as ClientMessage;

      if (raw.type === "create-room" || raw.type === "join-room" || raw.type === "leave-room" || raw.type === "end-room") {
        handleRoomAction(client, raw);
        return;
      }

      if (raw.type === "kick-user") {
        handleKickUser(client, raw);
        return;
      }

      if (raw.type === "chat-message") {
        handleChatMessage(client, raw);
        return;
      }

      if (raw.type === "offer" || raw.type === "answer" || raw.type === "ice-candidate") {
        handleRelay(client, raw);
        return;
      }

      sendError(client, "Unsupported message type", undefined, "BAD_REQUEST");
    } catch {
      sendError(client, "Invalid JSON payload", undefined, "BAD_JSON");
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
  console.log(`Bootstrap signaling server listening on ws://localhost:${PORT}`);
});
