import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

type ClientMessage =
  | { type: "join"; roomId: string; displayName: string }
  | { type: "offer"; roomId: string; targetId: string; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; roomId: string; targetId: string; sdp: RTCSessionDescriptionInit }
  | { type: "ice-candidate"; roomId: string; targetId: string; candidate: RTCIceCandidateInit };

type ServerMessage =
  | {
      type: "joined";
      roomId: string;
      senderId: string;
      existingPeers: Array<{ senderId: string; displayName: string }>;
    }
  | {
      type: "peer-joined";
      roomId: string;
      senderId: string;
      displayName: string;
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
      senderId: string;
    }
  | {
      type: "error";
      message: string;
      roomId?: string;
    };

interface ClientContext {
  id: string;
  socket: WebSocket;
  roomId?: string;
  displayName?: string;
}

const PORT = Number(process.env.PORT ?? 8787);
const rooms = new Map<string, Set<ClientContext>>();

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

function getPeerInRoom(roomId: string, currentClientId: string): ClientContext | undefined {
  const members = rooms.get(roomId);
  if (!members) {
    return undefined;
  }

  for (const member of members) {
    if (member.id !== currentClientId) {
      return member;
    }
  }

  return undefined;
}

function leaveRoom(client: ClientContext): void {
  const { roomId } = client;
  if (!roomId) {
    return;
  }

  const roomMembers = rooms.get(roomId);
  if (!roomMembers) {
    client.roomId = undefined;
    return;
  }

  roomMembers.delete(client);

  if (roomMembers.size === 0) {
    rooms.delete(roomId);
  } else {
    for (const peer of roomMembers) {
      sendTo(peer, {
        type: "peer-left",
        roomId,
        senderId: client.id,
      });
    }
  }

  client.roomId = undefined;
}

function handleJoin(client: ClientContext, message: Extract<ClientMessage, { type: "join" }>): void {
  const roomId = message.roomId.trim();
  const displayName = message.displayName.trim();

  if (!roomId || !displayName) {
    sendError(client, "roomId and displayName are required");
    return;
  }

  leaveRoom(client);

  const room = rooms.get(roomId) ?? new Set<ClientContext>();
  if (room.size >= 2) {
    sendError(client, "Room is full (max 2 peers)", roomId);
    return;
  }

  client.roomId = roomId;
  client.displayName = displayName;
  room.add(client);
  rooms.set(roomId, room);

  const existingPeers = Array.from(room)
    .filter((member) => member.id !== client.id)
    .map((peer) => ({
      senderId: peer.id,
      displayName: peer.displayName ?? "Peer",
    }));

  sendTo(client, {
    type: "joined",
    roomId,
    senderId: client.id,
    existingPeers,
  });

  for (const peer of room) {
    if (peer.id !== client.id) {
      sendTo(peer, {
        type: "peer-joined",
        roomId,
        senderId: client.id,
        displayName,
      });
    }
  }
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

  const target = getPeerInRoom(roomId, client.id);
  if (!target || target.id !== message.targetId) {
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
      if (raw.type === "join") {
        handleJoin(client, raw);
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
    leaveRoom(client);
  });

  socket.on("error", () => {
    leaveRoom(client);
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
