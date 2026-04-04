import { randomUUID } from "node:crypto";
import os from "node:os";
import { WebSocket, WebSocketServer } from "ws";
import type {
    ClientSignalMessage,
    HostServiceInfo,
    HostServiceStatus,
    LocalNetworkInfo,
    ParticipantRole,
    ParticipantSummary,
    RoomStatePayload,
    ServerSignalMessage,
} from "../src/shared/signaling.js";

interface ClientContext {
  id: string;
  socket: WebSocket;
  roomId?: string;
  displayName?: string;
  role?: ParticipantRole;
}

interface ActiveRoom {
  roomId: string;
  roomPassword: string;
  hostPeerId: string;
  hostDisplayName: string;
  guestPeerId: string | null;
  guestDisplayName: string | null;
  status: "open" | "closed";
  participants: Map<string, ClientContext>;
}

const minimumRoomPasswordLength = 4;
const maximumRoomParticipants = 6;
const maxPortFallbackAttempts = 30;

function normalizeRequestedPort(requestedPort: number): number {
  if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
    return 8787;
  }

  return requestedPort;
}

function isPortInUseError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: string };
  return candidate.code === "EADDRINUSE";
}

function resolveLocalNetworkInfo(): LocalNetworkInfo {
  const addresses = new Set<string>();

  for (const interfaces of Object.values(os.networkInterfaces())) {
    if (!interfaces) {
      continue;
    }

    for (const detail of interfaces) {
      if (detail.family !== "IPv4") {
        continue;
      }

      addresses.add(detail.address);
    }
  }

  if (addresses.size === 0) {
    addresses.add("127.0.0.1");
  } else {
    addresses.add("127.0.0.1");
  }

  const sortedAddresses = Array.from(addresses).sort((left, right) => {
    if (left === right) return 0;
    
    // Always put localhost at the very end
    if (left === "127.0.0.1") return 1;
    if (right === "127.0.0.1") return -1;

    // Prioritize Tailscale (100.x.x.x) and Hamachi (25.x.x.x) IP ranges for P2P VPNs
    const isVpn = (ip: string) => ip.startsWith("100.") || ip.startsWith("25.");
    const leftIsVpn = isVpn(left);
    const rightIsVpn = isVpn(right);

    if (leftIsVpn && !rightIsVpn) return -1;
    if (!leftIsVpn && rightIsVpn) return 1;

    return left.localeCompare(right);
  });

  const preferredAddress = sortedAddresses[0] ?? "127.0.0.1";

  return {
    hostname: os.hostname(),
    preferredAddress,
    addresses: sortedAddresses,
  };
}

function buildWsUrls(networkInfo: LocalNetworkInfo | null, port: number | null): string[] {
  if (!networkInfo || port === null) {
    return [];
  }

  return networkInfo.addresses.map((address) => `ws://${address}:${port}`);
}

export class HostRoomService {
  private server: WebSocketServer | null = null;
  private activeRoom: ActiveRoom | null = null;
  private status: HostServiceStatus = "stopped";
  private port: number | null = null;
  private localNetworkInfo: LocalNetworkInfo | null = null;
  private shutdownInProgress = false;

  private async createListeningServer(port: number): Promise<WebSocketServer> {
    const server = new WebSocketServer({
      host: "0.0.0.0",
      port,
    });

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        cleanup();
        resolve();
      };

      const onError = (error: unknown): void => {
        cleanup();
        server.close();
        reject(error);
      };

      const cleanup = (): void => {
        server.off("listening", onListening);
        server.off("error", onError);
      };

      server.once("listening", onListening);
      server.once("error", onError);
    });

    return server;
  }

  async start(requestedPort = 8787): Promise<HostServiceInfo> {
    if (this.server) {
      return this.getStatus();
    }

    this.status = "starting";
    this.localNetworkInfo = resolveLocalNetworkInfo();

    let server: WebSocketServer | null = null;
    const startPort = normalizeRequestedPort(requestedPort);

    for (let attempt = 0; attempt < maxPortFallbackAttempts; attempt += 1) {
      const candidatePort = startPort + attempt;
      if (candidatePort > 65535) {
        break;
      }

      try {
        server = await this.createListeningServer(candidatePort);
        break;
      } catch (error) {
        if (isPortInUseError(error)) {
          continue;
        }

        this.status = "stopped";
        this.port = null;
        this.localNetworkInfo = null;
        throw error;
      }
    }

    if (!server) {
      this.status = "stopped";
      this.port = null;
      this.localNetworkInfo = null;
      throw new Error(`failed to start host service; no free port found in range ${startPort}-${Math.min(65535, startPort + maxPortFallbackAttempts - 1)}`);
    }

    this.server = server;
    this.status = "running";

    const address = server.address();
    if (typeof address === "object" && address !== null) {
      this.port = address.port;
    } else {
      this.port = requestedPort;
    }

    this.bindServerEvents(server);
    return this.getStatus();
  }

  async stop(reason: "host-ended" | "host-disconnected" = "host-disconnected"): Promise<void> {
    if (!this.server && !this.activeRoom) {
      this.status = "stopped";
      this.port = null;
      this.localNetworkInfo = null;
      return;
    }

    if (this.shutdownInProgress) {
      return;
    }

    this.shutdownInProgress = true;

    try {
      this.closeActiveRoom(reason);
      await this.closeServer();
    } finally {
      this.server = null;
      this.activeRoom = null;
      this.status = "stopped";
      this.port = null;
      this.localNetworkInfo = null;
      this.shutdownInProgress = false;
    }
  }

  getStatus(): HostServiceInfo {
    return {
      status: this.status,
      port: this.port,
      roomId: this.activeRoom?.roomId ?? null,
      localNetworkInfo: this.localNetworkInfo,
      wsUrls: buildWsUrls(this.localNetworkInfo, this.port),
    };
  }

  private bindServerEvents(server: WebSocketServer): void {
    server.on("connection", (socket) => {
      const client: ClientContext = {
        id: randomUUID(),
        socket,
      };

      socket.on("message", (data) => {
        try {
          const raw = JSON.parse(data.toString()) as ClientSignalMessage;

          if (
            raw.type === "create-room" ||
            raw.type === "join-room" ||
            raw.type === "leave-room" ||
            raw.type === "end-room"
          ) {
            this.handleRoomAction(client, raw);
            return;
          }

          if (raw.type === "chat-message") {
            this.handleChatMessage(client, raw);
            return;
          }

          if (raw.type === "whiteboard-update") {
            this.handleWhiteboardUpdate(client, raw);
            return;
          }

          if (raw.type === "editor-update") {
            this.handleEditorUpdate(client, raw);
            return;
          }

          if (raw.type === "offer" || raw.type === "answer" || raw.type === "ice-candidate") {
            this.handleRelay(client, raw);
            return;
          }

          this.sendError(client, "Unsupported message type");
        } catch {
          this.sendError(client, "Invalid JSON payload");
        }
      });

      socket.on("close", () => {
        this.handleClientDisconnect(client);
      });

      socket.on("error", () => {
        socket.close();
      });
    });
  }

  private handleRoomAction(
    client: ClientContext,
    message: Extract<ClientSignalMessage, { type: "create-room" | "join-room" | "leave-room" | "end-room" }>,
  ): void {
    if (message.type === "leave-room") {
      if (client.roomId !== message.roomId) {
        this.sendError(client, "Cannot leave a room you have not joined", message.roomId);
        return;
      }

      if (client.role === "host") {
        void this.stop("host-ended");
        return;
      }

      this.leaveGuest(client);
      return;
    }

    if (message.type === "end-room") {
      const room = this.activeRoom;
      if (!room || room.roomId !== message.roomId || room.hostPeerId !== client.id || room.status !== "open") {
        this.sendError(client, "Only the active host can end the room", message.roomId);
        return;
      }

      void this.stop("host-ended");
      return;
    }

    const roomId = message.roomId.trim();
    const displayName = message.displayName.trim();
    const roomPassword = message.roomPassword.trim();

    if (!roomId || !displayName || !roomPassword) {
      this.sendError(client, "roomId, displayName, and roomPassword are required", roomId);
      return;
    }

    if (roomPassword.length < minimumRoomPasswordLength) {
      this.sendError(client, `roomPassword must be at least ${minimumRoomPasswordLength} characters`, roomId, "ROOM_PASSWORD_TOO_SHORT");
      return;
    }

    if (message.type === "create-room") {
      this.createRoom(client, roomId, displayName, roomPassword);
      return;
    }

    this.joinRoom(client, roomId, displayName, roomPassword);
  }

  private createRoom(client: ClientContext, roomId: string, displayName: string, roomPassword: string): void {
    if (this.activeRoom && this.activeRoom.status === "open") {
      this.sendError(client, "A room is already active", roomId, "ROOM_EXISTS");
      return;
    }

    client.roomId = roomId;
    client.displayName = displayName;
    client.role = "host";

    const room: ActiveRoom = {
      roomId,
      roomPassword,
      hostPeerId: client.id,
      hostDisplayName: displayName,
      guestPeerId: null,
      guestDisplayName: null,
      status: "open",
      participants: new Map([[client.id, client]]),
    };

    this.activeRoom = room;

    this.sendTo(client, {
      type: "room-created",
      roomId,
      senderPeerId: client.id,
      role: "host",
      room: this.getRoomStatePayload(room),
    });
  }

  private joinRoom(client: ClientContext, roomId: string, displayName: string, roomPassword: string): void {
    const room = this.activeRoom;

    if (!room || room.roomId !== roomId || room.status !== "open") {
      this.sendError(client, "Room does not exist", roomId, room ? "ROOM_CLOSED" : "ROOM_NOT_FOUND");
      return;
    }

    if (!room.participants.has(room.hostPeerId)) {
      this.sendError(client, "Room host is not active", roomId, "HOST_MISSING");
      return;
    }

    if (room.roomPassword !== roomPassword) {
      this.sendError(client, "Invalid room password", roomId, "ROOM_PASSWORD_INVALID");
      return;
    }

    if (room.participants.size >= maximumRoomParticipants) {
      this.sendError(client, `Room is full (max ${maximumRoomParticipants} peers)`, roomId, "ROOM_FULL");
      return;
    }

    client.roomId = roomId;
    client.displayName = displayName;
    client.role = "guest";
    room.participants.set(client.id, client);
    room.guestPeerId = client.id;
    room.guestDisplayName = displayName;

    const roomState = this.getRoomStatePayload(room);
    this.sendTo(client, {
      type: "room-joined",
      roomId,
      senderPeerId: client.id,
      role: "guest",
      room: roomState,
    });

    this.sendTo(room.participants.get(room.hostPeerId) ?? null, {
      type: "participant-joined",
      roomId,
      participant: {
        peerId: client.id,
        displayName,
        role: "guest",
      },
      room: roomState,
    });

    this.broadcastRoomState(room);
  }

  private handleRelay(
    client: ClientContext,
    message: Extract<ClientSignalMessage, { type: "offer" | "answer" | "ice-candidate" }>,
  ): void {
    const room = this.activeRoom;
    const roomId = client.roomId;

    if (!room || room.status !== "open" || roomId !== message.roomId) {
      this.sendError(client, "You must join the room before sending signaling messages", message.roomId);
      return;
    }

    const target = room.participants.get(message.targetPeerId);
    if (!target || target.id === client.id) {
      this.sendError(client, "Target peer is not available", roomId);
      return;
    }

    if (message.type === "offer" || message.type === "answer") {
      this.sendTo(target, {
        type: message.type,
        roomId,
        senderPeerId: client.id,
        sdp: message.sdp,
      });
      return;
    }

    this.sendTo(target, {
      type: "ice-candidate",
      roomId,
      senderPeerId: client.id,
      candidate: message.candidate,
    });
  }

  private handleChatMessage(
    client: ClientContext,
    message: Extract<ClientSignalMessage, { type: "chat-message" }>,
  ): void {
    const room = this.activeRoom;
    if (!room || room.status !== "open" || client.roomId !== message.roomId) {
      this.sendError(client, "You must join the room before sending chat", message.roomId, "NOT_IN_ROOM");
      return;
    }

    const senderDisplayName = client.displayName ?? message.senderDisplayName ?? "Peer";
    const text = message.text.trim();
    if (!text) {
      return;
    }

    for (const member of room.participants.values()) {
      if (member.id === client.id) {
        continue;
      }

      this.sendTo(member, {
        type: "chat-message",
        roomId: room.roomId,
        senderPeerId: client.id,
        senderDisplayName,
        text,
      });
    }
  }

  private handleWhiteboardUpdate(
    client: ClientContext,
    message: Extract<ClientSignalMessage, { type: "whiteboard-update" }>,
  ): void {
    const room = this.activeRoom;
    if (!room || room.status !== "open" || client.roomId !== message.roomId) {
      this.sendError(client, "You must join the room before sending whiteboard data", message.roomId, "NOT_IN_ROOM");
      return;
    }

    const senderDisplayName = client.displayName ?? message.senderDisplayName ?? "Peer";

    for (const member of room.participants.values()) {
      if (member.id === client.id) {
        continue;
      }

      this.sendTo(member, {
        type: "whiteboard-update",
        roomId: room.roomId,
        senderPeerId: client.id,
        senderDisplayName,
        data: message.data,
      });
    }
  }

  private handleEditorUpdate(
    client: ClientContext,
    message: Extract<ClientSignalMessage, { type: "editor-update" }>,
  ): void {
    const room = this.activeRoom;
    if (!room || room.status !== "open" || client.roomId !== message.roomId) {
      this.sendError(client, "You must join the room before sending editor data", message.roomId, "NOT_IN_ROOM");
      return;
    }

    const senderDisplayName = client.displayName ?? message.senderDisplayName ?? "Peer";

    for (const member of room.participants.values()) {
      if (member.id === client.id) {
        continue;
      }

      this.sendTo(member, {
        type: "editor-update",
        roomId: room.roomId,
        senderPeerId: client.id,
        senderDisplayName,
        data: message.data,
      });
    }
  }

  private handleClientDisconnect(client: ClientContext): void {
    if (this.shutdownInProgress) {
      return;
    }

    if (!client.roomId) {
      return;
    }

    const room = this.activeRoom;
    if (!room || room.roomId !== client.roomId) {
      return;
    }

    if (client.role === "host" || client.id === room.hostPeerId) {
      void this.stop("host-disconnected");
      return;
    }

    this.leaveGuest(client);
  }

  private leaveGuest(client: ClientContext): void {
    const room = this.activeRoom;
    if (!room || !room.participants.has(client.id)) {
      return;
    }

    room.participants.delete(client.id);
    if (room.guestPeerId === client.id) {
      room.guestPeerId = null;
      room.guestDisplayName = null;
    }

    client.roomId = undefined;
    client.displayName = undefined;
    client.role = undefined;

    const roomState = this.getRoomStatePayload(room);

    for (const member of room.participants.values()) {
      this.sendTo(member, {
        type: "participant-left",
        roomId: room.roomId,
        peerId: client.id,
        room: roomState,
      });

      this.sendTo(member, {
        type: "peer-left",
        roomId: room.roomId,
        peerId: client.id,
      });
    }

    this.broadcastRoomState(room);
  }

  private closeActiveRoom(reason: "host-ended" | "host-disconnected"): void {
    const room = this.activeRoom;
    if (!room) {
      return;
    }

    room.status = "closed";
    const roomState = this.getRoomStatePayload(room);

    for (const member of room.participants.values()) {
      this.sendTo(member, {
        type: "room-closed",
        roomId: room.roomId,
        reason,
        message: reason === "host-ended" ? "Host ended the room" : "Host disconnected, session ended",
      });

      this.sendTo(member, {
        type: "room-state",
        room: roomState,
      });
    }

    for (const member of room.participants.values()) {
      member.roomId = undefined;
      member.displayName = undefined;
      member.role = undefined;
    }

    room.participants.clear();
    this.activeRoom = null;
  }

  private broadcastRoomState(room: ActiveRoom): void {
    const roomState = this.getRoomStatePayload(room);
    for (const member of room.participants.values()) {
      this.sendTo(member, {
        type: "room-state",
        room: roomState,
      });
    }
  }

  private getRoomStatePayload(room: ActiveRoom): RoomStatePayload {
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

  private sendTo(client: ClientContext | null | undefined, message: ServerSignalMessage): void {
    if (!client || client.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    client.socket.send(JSON.stringify(message));
  }

  private sendError(client: ClientContext, message: string, roomId?: string, code?: string): void {
    this.sendTo(client, {
      type: "error",
      message,
      roomId,
      code,
    });
  }

  private async closeServer(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}