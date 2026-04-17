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

type RelayRoomStatus = "open" | "closed";

interface RelayRoomListingInput {
  roomId: string;
  hostDisplayName: string;
  hostIp: string;
  hostPort: number;
  participantCount: number;
  maxParticipants: number;
  isJoinable: boolean;
  status: RelayRoomStatus;
}

interface RelayRoomListing extends RelayRoomListingInput {
  updatedAt: number;
}

interface RelayRoomListingRecord {
  ownerClientId: string;
  listing: RelayRoomListing;
}

type ClientMessage =
  | { type: "create-room"; roomId: string; displayName: string; roomPassword: string; userHash: string; hostCandidateBootstrapUrl?: string }
  | { type: "join-room"; roomId: string; displayName: string; roomPassword: string; userHash: string; hostCandidateBootstrapUrl?: string }
  | { type: "leave-room"; roomId: string }
  | { type: "end-room"; roomId: string }
  | { type: "transfer-room-ownership"; roomId: string }
  | { type: "kick-user"; roomId: string; targetPeerId: string }
  | { type: "chat-message"; roomId: string; text: string; senderDisplayName?: string }
  | { type: "offer"; roomId: string; targetPeerId: string; sdp: SessionDescriptionPayload }
  | { type: "answer"; roomId: string; targetPeerId: string; sdp: SessionDescriptionPayload }
  | { type: "ice-candidate"; roomId: string; targetPeerId: string; candidate: IceCandidatePayload }
  | { type: "relay-room-register"; listing: RelayRoomListingInput }
  | { type: "relay-room-update"; listing: RelayRoomListingInput }
  | { type: "relay-room-remove"; roomId: string }
  | { type: "relay-room-list-request" }
  | { type: "relay-room-subscribe" }
  | { type: "relay-room-unsubscribe" }
  | { type: "relay-server-status-request" };

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
      type: "room-host-transferred";
      roomId: string;
      previousHostPeerId: string;
      previousHostDisplayName: string;
      newHostPeerId: string;
      newHostDisplayName: string;
      newHostBootstrapUrl: string | null;
      room: RoomStatePayload;
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
    }
  | {
      type: "relay-room-upserted";
      listing: RelayRoomListing;
    }
  | {
      type: "relay-room-removed";
      roomId: string;
      hostIp: string;
      hostPort: number;
    }
  | {
      type: "relay-room-snapshot";
      listings: RelayRoomListing[];
      timestamp: number;
    }
  | {
      type: "relay-server-status";
      serverStartedAt: number;
      serverNow: number;
      connectedClients: number;
      relayListings: number;
    };

interface ClientContext {
  id: string;
  socket: WebSocket;
  roomId?: string;
  displayName?: string;
  role?: ParticipantRole;
  relayDiscoverySubscribed?: boolean;
  userHash?: string;
  hostCandidateBootstrapUrl?: string;
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

const PORT = 8787;
const minimumRoomPasswordLength = 4;
const maximumRoomParticipants = 6;
const rooms = new Map<string, Room>();
const clientsById = new Map<string, ClientContext>();

const relayListingTtlMs = 20_000;
const relayCleanupIntervalMs = 2_000;
const relayMutationWindowMs = 10_000;
const relayMutationMaxPerWindow = 80;
const relayMaxListings = 500;

const relayMaxRoomIdLength = 80;
const relayMaxHostDisplayNameLength = 64;
const relayMaxHostIpLength = 128;
const relayMaxParticipants = 64;
const relayIdleShutdownMs = Number(process.env.RELAY_IDLE_SHUTDOWN_MS ?? 60_000);
const relayIdleShutdownEnabled = Number.isFinite(relayIdleShutdownMs) && relayIdleShutdownMs > 0;

const relayListingsByKey = new Map<string, RelayRoomListingRecord>();
const relayMutationWindows = new Map<string, { windowStartedAt: number; count: number }>();
let relayNoConnectionsSinceAt = Date.now();
const relayServerStartedAt = Date.now();
let relayShutdownRequested = false;

function shutdownRelayProcess(reason: string): void {
  if (relayShutdownRequested) {
    return;
  }

  relayShutdownRequested = true;
  console.log(reason);
  setTimeout(() => {
    process.exit(0);
  }, 0);
}

function noteRelayClientConnected(): void {
  relayNoConnectionsSinceAt = 0;
}

function noteRelayClientDisconnected(): void {
  if (clientsById.size === 0) {
    relayNoConnectionsSinceAt = Date.now();
  }
}

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`Vir Space bootstrap signaling server is running. Use ws://localhost:${PORT} from clients.\n`);
});

const wss = new WebSocketServer({ noServer: true });

function relayListingKey(ownerClientId: string, roomId: string): string {
  return `${ownerClientId}:${roomId}`;
}

function relayListingContentEquals(left: RelayRoomListingInput, right: RelayRoomListingInput): boolean {
  return (
    left.roomId === right.roomId
    && left.hostDisplayName === right.hostDisplayName
    && left.hostIp === right.hostIp
    && left.hostPort === right.hostPort
    && left.participantCount === right.participantCount
    && left.maxParticipants === right.maxParticipants
    && left.isJoinable === right.isJoinable
    && left.status === right.status
  );
}

function snapshotRelayListings(): RelayRoomListing[] {
  return Array.from(relayListingsByKey.values())
    .map((record) => record.listing)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function broadcastRelayUpsert(listing: RelayRoomListing): void {
  for (const client of clientsById.values()) {
    if (!client.relayDiscoverySubscribed) {
      continue;
    }

    sendTo(client, {
      type: "relay-room-upserted",
      listing,
    });
  }
}

function broadcastRelayRemoved(listing: Pick<RelayRoomListing, "roomId" | "hostIp" | "hostPort">): void {
  for (const client of clientsById.values()) {
    if (!client.relayDiscoverySubscribed) {
      continue;
    }

    sendTo(client, {
      type: "relay-room-removed",
      roomId: listing.roomId,
      hostIp: listing.hostIp,
      hostPort: listing.hostPort,
    });
  }
}

function sendRelaySnapshot(client: ClientContext): void {
  pruneStaleRelayListings();

  sendTo(client, {
    type: "relay-room-snapshot",
    listings: snapshotRelayListings(),
    timestamp: Date.now(),
  });
}

function sendRelayServerStatus(client: ClientContext): void {
  sendTo(client, {
    type: "relay-server-status",
    serverStartedAt: relayServerStartedAt,
    serverNow: Date.now(),
    connectedClients: clientsById.size,
    relayListings: relayListingsByKey.size,
  });
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength;
}

function toValidatedRelayListingInput(value: unknown): RelayRoomListingInput | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<RelayRoomListingInput>;
  if (
    !isNonEmptyBoundedString(candidate.roomId, relayMaxRoomIdLength)
    || !isNonEmptyBoundedString(candidate.hostDisplayName, relayMaxHostDisplayNameLength)
    || !isNonEmptyBoundedString(candidate.hostIp, relayMaxHostIpLength)
    || !isFiniteInteger(candidate.hostPort)
    || !isFiniteInteger(candidate.participantCount)
    || !isFiniteInteger(candidate.maxParticipants)
    || (candidate.status !== "open" && candidate.status !== "closed")
    || typeof candidate.isJoinable !== "boolean"
  ) {
    return null;
  }

  if (
    candidate.hostPort < 1
    || candidate.hostPort > 65535
    || candidate.maxParticipants < 1
    || candidate.maxParticipants > relayMaxParticipants
    || candidate.participantCount < 0
    || candidate.participantCount > candidate.maxParticipants
  ) {
    return null;
  }

  const expectedJoinable = candidate.status === "open" && candidate.participantCount < candidate.maxParticipants;
  if (candidate.isJoinable !== expectedJoinable) {
    return null;
  }

  return {
    roomId: candidate.roomId.trim(),
    hostDisplayName: candidate.hostDisplayName.trim(),
    hostIp: candidate.hostIp.trim(),
    hostPort: candidate.hostPort,
    participantCount: candidate.participantCount,
    maxParticipants: candidate.maxParticipants,
    isJoinable: candidate.isJoinable,
    status: candidate.status,
  };
}

function isRelayMutationRateLimited(client: ClientContext): boolean {
  const nowMs = Date.now();
  const current = relayMutationWindows.get(client.id);
  if (!current || nowMs - current.windowStartedAt >= relayMutationWindowMs) {
    relayMutationWindows.set(client.id, {
      windowStartedAt: nowMs,
      count: 1,
    });
    return false;
  }

  current.count += 1;
  relayMutationWindows.set(client.id, current);

  return current.count > relayMutationMaxPerWindow;
}

function upsertRelayListing(ownerClientId: string, input: RelayRoomListingInput): { listing: RelayRoomListing; changed: boolean } | null {
  const key = relayListingKey(ownerClientId, input.roomId);
  const existing = relayListingsByKey.get(key);
  if (!existing && relayListingsByKey.size >= relayMaxListings) {
    return null;
  }

  if (existing && relayListingContentEquals(existing.listing, input)) {
    existing.listing.updatedAt = Date.now();
    relayListingsByKey.set(key, existing);
    return {
      listing: existing.listing,
      changed: false,
    };
  }

  const listing: RelayRoomListing = {
    ...input,
    updatedAt: Date.now(),
  };

  relayListingsByKey.set(key, {
    ownerClientId,
    listing,
  });

  return {
    listing,
    changed: true,
  };
}

function removeRelayListing(ownerClientId: string, roomId: string): RelayRoomListing | null {
  const key = relayListingKey(ownerClientId, roomId);
  const record = relayListingsByKey.get(key);
  if (!record) {
    return null;
  }

  relayListingsByKey.delete(key);
  return record.listing;
}

function removeRelayListingsForClient(ownerClientId: string): void {
  const keysToDelete: string[] = [];
  for (const [key, record] of relayListingsByKey.entries()) {
    if (record.ownerClientId === ownerClientId) {
      keysToDelete.push(key);
    }
  }

  for (const key of keysToDelete) {
    const record = relayListingsByKey.get(key);
    relayListingsByKey.delete(key);
    if (record) {
      broadcastRelayRemoved(record.listing);
    }
  }

  relayMutationWindows.delete(ownerClientId);
}

function pruneStaleRelayListings(): void {
  const nowMs = Date.now();
  for (const [key, record] of relayListingsByKey.entries()) {
    if (nowMs - record.listing.updatedAt <= relayListingTtlMs) {
      continue;
    }

    relayListingsByKey.delete(key);
    broadcastRelayRemoved(record.listing);
  }

  for (const [clientId, windowInfo] of relayMutationWindows.entries()) {
    if (nowMs - windowInfo.windowStartedAt > relayMutationWindowMs * 3) {
      relayMutationWindows.delete(clientId);
    }
  }

  if (
    relayIdleShutdownEnabled
    && clientsById.size === 0
    && relayNoConnectionsSinceAt > 0
    && nowMs - relayNoConnectionsSinceAt >= relayIdleShutdownMs
  ) {
    shutdownRelayProcess(`Relay idle timeout reached (${relayIdleShutdownMs}ms) with no active connections; shutting down.`);
  }
}

function handleRelayDirectoryAction(
  client: ClientContext,
  message: Extract<
    ClientMessage,
    {
      type:
        | "relay-room-register"
        | "relay-room-update"
        | "relay-room-remove"
        | "relay-room-list-request"
        | "relay-room-subscribe"
        | "relay-room-unsubscribe";
    }
  >,
): void {
  pruneStaleRelayListings();

  if (message.type === "relay-room-subscribe") {
    client.relayDiscoverySubscribed = true;
    sendRelaySnapshot(client);
    return;
  }

  if (message.type === "relay-room-unsubscribe") {
    client.relayDiscoverySubscribed = false;
    return;
  }

  if (message.type === "relay-room-list-request") {
    sendRelaySnapshot(client);
    return;
  }

  if (isRelayMutationRateLimited(client)) {
    sendError(client, "relay discovery mutation rate limit exceeded", undefined, "RELAY_RATE_LIMIT");
    return;
  }

  if (message.type === "relay-room-remove") {
    const roomId = message.roomId.trim();
    if (!roomId || roomId.length > relayMaxRoomIdLength) {
      sendError(client, "relay room remove requires valid roomId", undefined, "RELAY_BAD_REQUEST");
      return;
    }

    const removed = removeRelayListing(client.id, roomId);
    if (removed) {
      broadcastRelayRemoved(removed);
    }

    return;
  }

  const listing = toValidatedRelayListingInput(message.listing);
  if (!listing) {
    sendError(client, "invalid relay room listing payload", undefined, "RELAY_BAD_REQUEST");
    return;
  }

  const upsertResult = upsertRelayListing(client.id, listing);
  if (!upsertResult) {
    sendError(client, "relay room listing capacity exceeded", undefined, "RELAY_CAPACITY_EXCEEDED");
    return;
  }

  broadcastRelayUpsert(upsertResult.listing);
}

const relayCleanupTimer = setInterval(() => {
  pruneStaleRelayListings();
}, relayCleanupIntervalMs);

relayCleanupTimer.unref();

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

function refreshLegacyGuestFields(room: Room): void {
  const guestCandidate = Array.from(room.participants.values()).find((participant) => participant.id !== room.hostPeerId);
  room.guestPeerId = guestCandidate?.id ?? null;
  room.guestDisplayName = guestCandidate?.displayName ?? null;
}

function getNextHostBySeniority(room: Room, currentHostPeerId: string): ClientContext | undefined {
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
  refreshLegacyGuestFields(room);

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

function createRoom(
  client: ClientContext,
  roomId: string,
  displayName: string,
  roomPassword: string,
  userHash: string,
  hostCandidateBootstrapUrl?: string,
): void {
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
  client.hostCandidateBootstrapUrl = hostCandidateBootstrapUrl;

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

function joinRoom(
  client: ClientContext,
  roomId: string,
  displayName: string,
  roomPassword: string,
  userHash: string,
  hostCandidateBootstrapUrl?: string,
): void {
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
  client.hostCandidateBootstrapUrl = hostCandidateBootstrapUrl;
  room.participants.set(client.id, client);
  refreshLegacyGuestFields(room);

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

function transferRoomOwnership(client: ClientContext, room: Room): void {
  const nextHost = getNextHostBySeniority(room, client.id);
  if (!nextHost) {
    sendError(client, "No eligible participant available for transfer", room.roomId, "NO_TRANSFER_TARGET");
    return;
  }

  const previousHostPeerId = client.id;
  const previousHostDisplayName = client.displayName ?? room.hostDisplayName;

  room.hostPeerId = nextHost.id;
  room.hostDisplayName = nextHost.displayName ?? "Peer";
  client.role = "guest";
  nextHost.role = "host";

  refreshLegacyGuestFields(room);
  const roomState = getRoomStatePayload(room);

  for (const member of room.participants.values()) {
    sendTo(member, {
      type: "room-host-transferred",
      roomId: room.roomId,
      previousHostPeerId,
      previousHostDisplayName,
      newHostPeerId: nextHost.id,
      newHostDisplayName: room.hostDisplayName,
      newHostBootstrapUrl: null,
      room: roomState,
    });
  }

  broadcastRoomState(room);
}

function handleRoomAction(
  client: ClientContext,
  message: Extract<ClientMessage, { type: "create-room" | "join-room" | "leave-room" | "end-room" | "transfer-room-ownership" }>,
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

  if (message.type === "transfer-room-ownership") {
    const room = rooms.get(message.roomId);
    if (!room) {
      sendError(client, "Room does not exist", message.roomId, "ROOM_NOT_FOUND");
      return;
    }

    if (room.hostPeerId !== client.id || room.status !== "open") {
      sendError(client, "Only host can transfer ownership", message.roomId, "ONLY_HOST_CAN_TRANSFER");
      return;
    }

    transferRoomOwnership(client, room);
    return;
  }

  const roomId = message.roomId.trim();
  const displayName = message.displayName.trim();
  const roomPassword = message.roomPassword.trim();
  const userHash = message.userHash.trim();
  const hostCandidateBootstrapUrl = message.hostCandidateBootstrapUrl?.trim();

  if (!roomId || !displayName || !roomPassword || !userHash) {
    sendError(client, "roomId, displayName, roomPassword, and userHash are required", roomId, "BAD_REQUEST");
    return;
  }

  if (roomPassword.length < minimumRoomPasswordLength) {
    sendError(client, `roomPassword must be at least ${minimumRoomPasswordLength} characters`, roomId, "ROOM_PASSWORD_TOO_SHORT");
    return;
  }

  if (message.type === "create-room") {
    createRoom(client, roomId, displayName, roomPassword, userHash, hostCandidateBootstrapUrl);
    return;
  }

  joinRoom(client, roomId, displayName, roomPassword, userHash, hostCandidateBootstrapUrl);
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
    relayDiscoverySubscribed: false,
  };
  clientsById.set(client.id, client);
  noteRelayClientConnected();

  let disconnected = false;
  const handleDisconnect = (): void => {
    if (disconnected) {
      return;
    }

    disconnected = true;
    clientsById.delete(client.id);
    noteRelayClientDisconnected();
    removeRelayListingsForClient(client.id);
    leaveRoom(client, "disconnect");
  };

  socket.on("message", (data) => {
    try {
      const raw = JSON.parse(data.toString()) as ClientMessage;

      if (
        raw.type === "create-room" ||
        raw.type === "join-room" ||
        raw.type === "leave-room" ||
        raw.type === "end-room" ||
        raw.type === "transfer-room-ownership"
      ) {
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

      if (
        raw.type === "relay-room-register"
        || raw.type === "relay-room-update"
        || raw.type === "relay-room-remove"
        || raw.type === "relay-room-list-request"
        || raw.type === "relay-room-subscribe"
        || raw.type === "relay-room-unsubscribe"
      ) {
        handleRelayDirectoryAction(client, raw);
        return;
      }

      if (raw.type === "relay-server-status-request") {
        sendRelayServerStatus(client);
        return;
      }

      sendError(client, "Unsupported message type", undefined, "BAD_REQUEST");
    } catch {
      sendError(client, "Invalid JSON payload", undefined, "BAD_JSON");
    }
  });

  socket.on("close", () => {
    handleDisconnect();
  });

  socket.on("error", () => {
    handleDisconnect();
  });
});

httpServer.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

httpServer.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Bootstrap signaling server failed: port ${PORT} is already in use.`);
    process.exit(1);
  }

  console.error("Failed to start bootstrap signaling server", error);
  process.exit(1);
});

httpServer.listen(PORT, () => {
  console.log(`Bootstrap signaling server listening on ws://localhost:${PORT}`);
});
