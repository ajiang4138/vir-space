import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { createServer } from "node:http";
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
  hostCandidateBootstrapUrl?: string;
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

function scorePreferredAddress(address: string): number {
  if (address === "127.0.0.1") {
    return 100;
  }

  if (address.startsWith("169.254.")) {
    return 90;
  }

  if (address.startsWith("192.168.56.")) {
    return 80;
  }

  if (address.startsWith("10.2.")) {
    return -1;
  }

  if (address.startsWith("10.")) {
    return 0;
  }

  if (address.startsWith("172.")) {
    return 1;
  }

  if (address.startsWith("192.168.")) {
    return 2;
  }

  if (address.startsWith("100.")) {
    return 5;
  }

  if (address.startsWith("25.")) {
    return 6;
  }

  return 10;
}

function resolveLocalNetworkInfo(): LocalNetworkInfo {
  const entries: Array<{ ip: string; ifaceName: string }> = [];

  for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
    if (!interfaces) {
      continue;
    }

    const lowerName = name.toLowerCase();
    if (
      (lowerName.includes("virtual") &&
        !lowerName.includes("pangp") &&
        !lowerName.includes("vpn")) ||
      lowerName.includes("vbox") ||
      lowerName.includes("wsl") ||
      lowerName.includes("loopback")
    ) {
      continue;
    }

    for (const detail of interfaces) {
      if (detail.family !== "IPv4" || detail.internal || !detail.address) {
        continue;
      }

      // Exclude known virtual/link-local IP ranges
      if (detail.address.startsWith("169.254.") || detail.address.startsWith("192.168.56.")) {
        continue;
      }

      entries.push({ ip: detail.address, ifaceName: name });
    }
  }

  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    if (seen.has(entry.ip)) {
      return false;
    }
    seen.add(entry.ip);
    return true;
  });

  // Ethernet/VPN adapters get priority over Wi-Fi.
  const ifaceScore = (ifaceName: string): number => {
    const lower = ifaceName.toLowerCase();
    if (
      lower.includes("pangp") ||
      lower.includes("vpn") ||
      lower.includes("cisco") ||
      lower.includes("anyconnect") ||
      lower.includes("globalprotect")
    ) {
      return -1;
    }
    if (lower.includes("wi-fi") || lower.includes("wifi") || lower.includes("wireless") || lower.includes("wlan")) {
      return 1;
    }
    return 0;
  };

  const sortedEntries = unique.sort((left, right) => {
    const ifaceDelta = ifaceScore(left.ifaceName) - ifaceScore(right.ifaceName);
    if (ifaceDelta !== 0) {
      return ifaceDelta;
    }

    const ipScoreDelta = scorePreferredAddress(left.ip) - scorePreferredAddress(right.ip);
    if (ipScoreDelta !== 0) {
      return ipScoreDelta;
    }

    return left.ip.localeCompare(right.ip);
  });

  // If a VPN is present (by name or by 10.2.x.x IP), we exclusively use the VPN
  // interface(s) to avoid exposing the relay on huge home/CGNAT subnets.
  const vpnOnly = sortedEntries.filter(
    (entry) => ifaceScore(entry.ifaceName) === -1 || entry.ip.startsWith("10.2."),
  );

  const finalEntries = vpnOnly.length > 0 ? vpnOnly : sortedEntries;
  const sortedAddresses = finalEntries.map((e) => e.ip);

  if (sortedAddresses.length === 0) {
    sortedAddresses.push("127.0.0.1");
  } else if (!sortedAddresses.includes("127.0.0.1")) {
    sortedAddresses.push("127.0.0.1");
  }

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
  private httpServer: HttpServer | null = null;
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

    const httpServer = createServer();

    // Attempt to bind with retry logic for port TIME_WAIT state
    await this.waitForPort(httpServer, requestedPort).catch((error) => {
      httpServer.close();
      this.status = "stopped";
      this.port = null;
      this.localNetworkInfo = null;
      throw error;
    });

    const server = new WebSocketServer({
      server: httpServer,
    });

    this.server = server;
    this.httpServer = httpServer;
    this.status = "running";

    const address = httpServer.address();
    if (typeof address === "object" && address !== null) {
      this.port = address.port;
    } else {
      this.port = requestedPort;
    }

    this.bindServerEvents(server);
    return this.getStatus();
  }

  private async waitForPort(httpServer: ReturnType<typeof createServer>, port: number): Promise<void> {
    const maxAttempts = 10;
    let currentPort = port;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onListening = () => {
            httpServer.removeListener("error", onError);
            resolve();
          };
          const onError = (error: any) => {
            httpServer.removeListener("listening", onListening);
            reject(error);
          };

          httpServer.once("listening", onListening);
          httpServer.once("error", onError);

          httpServer.listen(currentPort, "0.0.0.0");
        });
        return; // Success
      } catch (error: any) {
        const isAddressInUse = error && typeof error === "object" && (error.code === "EADDRINUSE" || error.message?.includes("EADDRINUSE"));
        if (isAddressInUse) {
          currentPort++;
        } else {
          throw error; // Rethrow other unexpected errors
        }
      }
    }

    throw new Error(`Failed to find an available port after ${maxAttempts} attempts starting from ${port}`);
  }

  async stop(reason: "host-ended" | "host-disconnected" | "host-migrated" = "host-disconnected"): Promise<void> {
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
      if (reason !== "host-migrated") {
        this.closeActiveRoom(reason);
      }
      await this.closeServer();
    } finally {
      this.server = null;
      this.httpServer = null;
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
            raw.type === "end-room" ||
            raw.type === "transfer-room-ownership"
          ) {
            this.handleRoomAction(client, raw);
            return;
          }

          if (raw.type === "kick-user") {
            this.handleKickUser(client, raw);
            return;
          }

          if (raw.type === "offer" || raw.type === "answer" || raw.type === "ice-candidate") {
            this.handleRelay(client, raw);
            return;
          }

          if (
            raw.type === "relay-room-register"
            || raw.type === "relay-room-update"
            || raw.type === "relay-room-remove"
            || raw.type === "relay-room-list-request"
            || raw.type === "relay-room-subscribe"
            || raw.type === "relay-room-unsubscribe"
          ) {
            // Local host service does not implement relay-directory features.
            // Ignore these messages so room create/join flows continue working.
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
    message: Extract<ClientSignalMessage, { type: "create-room" | "join-room" | "leave-room" | "end-room" | "transfer-room-ownership" }>,
  ): void {
    if (message.type === "leave-room") {
      if (client.roomId !== message.roomId) {
        this.sendError(client, "Cannot leave a room you have not joined", message.roomId);
        return;
      }

      if (client.role === "host") {
        const room = this.activeRoom;
        if (room && room.participants.size > 1) {
          this.transferRoomOwnership(client, room);
          this.leaveGuest(client);
        } else {
          void this.stop("host-ended");
        }
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

    if (message.type === "transfer-room-ownership") {
      const room = this.activeRoom;
      if (!room || room.roomId !== message.roomId || room.hostPeerId !== client.id || room.status !== "open") {
        this.sendError(client, "Only the active host can transfer ownership", message.roomId, "ONLY_HOST_CAN_TRANSFER");
        return;
      }

      this.transferRoomOwnership(client, room);
      return;
    }

    const roomId = message.roomId.trim();
    const displayName = message.displayName.trim();
    const roomPassword = message.roomPassword.trim();
    const hostCandidateBootstrapUrl = message.hostCandidateBootstrapUrl?.trim();

    if (!roomId || !displayName || !roomPassword) {
      this.sendError(client, "roomId, displayName, and roomPassword are required", roomId);
      return;
    }

    if (roomPassword.length < minimumRoomPasswordLength) {
      this.sendError(client, `roomPassword must be at least ${minimumRoomPasswordLength} characters`, roomId, "ROOM_PASSWORD_TOO_SHORT");
      return;
    }

    if (message.type === "create-room") {
      this.createRoom(client, roomId, displayName, roomPassword, hostCandidateBootstrapUrl);
      return;
    }

    this.joinRoom(client, roomId, displayName, roomPassword, hostCandidateBootstrapUrl);
  }

  private createRoom(
    client: ClientContext,
    roomId: string,
    displayName: string,
    roomPassword: string,
    hostCandidateBootstrapUrl?: string,
  ): void {
    if (this.activeRoom && this.activeRoom.status === "open") {
      this.sendError(client, "A room is already active", roomId, "ROOM_EXISTS");
      return;
    }

    client.roomId = roomId;
    client.displayName = displayName;
    client.role = "host";
    client.hostCandidateBootstrapUrl = hostCandidateBootstrapUrl;

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

  private joinRoom(
    client: ClientContext,
    roomId: string,
    displayName: string,
    roomPassword: string,
    hostCandidateBootstrapUrl?: string,
  ): void {
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
    client.hostCandidateBootstrapUrl = hostCandidateBootstrapUrl;
    room.participants.set(client.id, client);
    this.refreshLegacyGuestFields(room);

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

  private refreshLegacyGuestFields(room: ActiveRoom): void {
    const guestCandidate = Array.from(room.participants.values()).find((participant) => participant.id !== room.hostPeerId);
    room.guestPeerId = guestCandidate?.id ?? null;
    room.guestDisplayName = guestCandidate?.displayName ?? null;
  }

  private getNextHostBySeniority(room: ActiveRoom, currentHostPeerId: string): ClientContext | undefined {
    for (const participant of room.participants.values()) {
      if (participant.id === currentHostPeerId) {
        continue;
      }

      if (participant.socket.readyState !== WebSocket.OPEN) {
        continue;
      }

      return participant;
    }

    return undefined;
  }

  private transferRoomOwnership(currentHost: ClientContext, room: ActiveRoom): void {
    const nextHost = this.getNextHostBySeniority(room, currentHost.id);
    if (!nextHost) {
      this.sendError(currentHost, "No eligible participant available for transfer", room.roomId, "NO_TRANSFER_TARGET");
      return;
    }

    const previousHostPeerId = currentHost.id;
    const previousHostDisplayName = currentHost.displayName ?? room.hostDisplayName;
    const newHostBootstrapUrl = nextHost.hostCandidateBootstrapUrl ?? null;

    room.hostPeerId = nextHost.id;
    room.hostDisplayName = nextHost.displayName ?? "Peer";
    currentHost.role = "guest";
    nextHost.role = "host";

    this.refreshLegacyGuestFields(room);
    const roomState = this.getRoomStatePayload(room);

    for (const member of room.participants.values()) {
      this.sendTo(member, {
        type: "room-host-transferred",
        roomId: room.roomId,
        previousHostPeerId,
        previousHostDisplayName,
        newHostPeerId: nextHost.id,
        newHostDisplayName: room.hostDisplayName,
        newHostBootstrapUrl,
        room: roomState,
      });
    }

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

  private handleKickUser(
    client: ClientContext,
    message: Extract<ClientSignalMessage, { type: "kick-user" }>,
  ): void {
    const room = this.activeRoom;
    const roomId = message.roomId;

    if (!room || room.roomId !== roomId || room.status !== "open") {
      this.sendError(client, "Room is not active", roomId, "ROOM_CLOSED");
      return;
    }

    if (client.roomId !== roomId || room.hostPeerId !== client.id) {
      this.sendError(client, "Only host can kick users", roomId, "ONLY_HOST_CAN_KICK");
      return;
    }

    const targetClient = room.participants.get(message.targetPeerId);
    if (!targetClient) {
      this.sendError(client, "Target user not found", roomId, "USER_NOT_FOUND");
      return;
    }

    if (targetClient.id === room.hostPeerId) {
      this.sendError(client, "Cannot kick the host", roomId, "CANNOT_KICK_HOST");
      return;
    }

    this.sendTo(targetClient, {
      type: "user-kicked",
      roomId,
      message: "You have been kicked from the room",
    });

    this.leaveGuest(targetClient);
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
      const nextHost = this.getNextHostBySeniority(room, client.id);
      if (nextHost) {
        this.transferRoomOwnership(client, room);
        this.leaveGuest(client);
      } else {
        void this.stop("host-disconnected");
      }
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
    this.refreshLegacyGuestFields(room);

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
    const wsServer = this.server;
    const httpServer = this.httpServer;

    this.server = null;
    this.httpServer = null;

    if (wsServer) {
      for (const socket of wsServer.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        wsServer.close(() => resolve());
      });
    }

    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    }
  }
}