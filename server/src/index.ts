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
  | { type: "create-room"; roomId: string; displayName: string; roomPassword: string }
  | { type: "join-room"; roomId: string; displayName: string; roomPassword: string }
  | { type: "leave-room"; roomId: string }
  | { type: "end-room"; roomId: string }
  | { type: "chat-message"; roomId: string; text: string; senderDisplayName?: string }
  | { type: "whiteboard-update"; roomId: string; data: string; senderDisplayName?: string }
  | { type: "editor-update"; roomId: string; data: string; senderDisplayName?: string }
  | { type: "offer"; roomId: string; targetPeerId: string; sdp: SessionDescriptionPayload }
  | { type: "answer"; roomId: string; targetPeerId: string; sdp: SessionDescriptionPayload }
  | { type: "ice-candidate"; roomId: string; targetPeerId: string; candidate: IceCandidatePayload }
  | { type: "relay-room-register"; listing: RelayRoomListingInput }
  | { type: "relay-room-update"; listing: RelayRoomListingInput }
  | { type: "relay-room-remove"; roomId: string }
  | { type: "relay-room-list-request" }
  | { type: "relay-room-subscribe" }
  | { type: "relay-room-unsubscribe" };

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
      type: "whiteboard-update";
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
      data: string;
    }
  | {
      type: "editor-update";
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
      data: string;
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
    };

interface ClientContext {
  id: string;
  socket: WebSocket;
  roomId?: string;
  displayName?: string;
  role?: ParticipantRole;
  relayDiscoverySubscribed?: boolean;
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

const relayListingsByKey = new Map<string, RelayRoomListingRecord>();
const relayMutationWindows = new Map<string, { windowStartedAt: number; count: number }>();

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

function createRoom(client: ClientContext, roomId: string, displayName: string, roomPassword: string): void {
  const existingRoom = rooms.get(roomId);
  if (existingRoom?.status === "open") {
    sendError(client, "Room already exists", roomId, "ROOM_EXISTS");
    return;
  }

  leaveRoom(client, "leave-request");

  client.roomId = roomId;
  client.displayName = displayName;
  client.role = "host";

  const room: Room = {
    roomId,
    roomPassword,
    hostPeerId: client.id,
    hostDisplayName: displayName,
    guestPeerId: null,
    guestDisplayName: null,
    status: "open",
    participants: new Map([[client.id, client]]),
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

function joinRoom(client: ClientContext, roomId: string, displayName: string, roomPassword: string): void {
  const room = rooms.get(roomId);
  if (!room) {
    sendError(client, "Room does not exist", roomId, "ROOM_NOT_FOUND");
    return;
  }

  if (room.status !== "open") {
    sendError(client, "Room is closed", roomId, "ROOM_CLOSED");
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

  if (!roomId || !displayName || !roomPassword) {
    sendError(client, "roomId, displayName, and roomPassword are required", roomId, "BAD_REQUEST");
    return;
  }

  if (roomPassword.length < minimumRoomPasswordLength) {
    sendError(client, `roomPassword must be at least ${minimumRoomPasswordLength} characters`, roomId, "ROOM_PASSWORD_TOO_SHORT");
    return;
  }

  if (message.type === "create-room") {
    createRoom(client, roomId, displayName, roomPassword);
    return;
  }

  joinRoom(client, roomId, displayName, roomPassword);
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

function handleWhiteboardUpdate(
  client: ClientContext,
  message: Extract<ClientMessage, { type: "whiteboard-update" }>,
): void {
  const roomId = client.roomId;
  if (!roomId || roomId !== message.roomId) {
    return;
  }

  const room = rooms.get(roomId);
  if (!room || room.status !== "open") {
    return;
  }

  const senderDisplayName = client.displayName ?? message.senderDisplayName ?? "Peer";
  for (const member of room.participants.values()) {
    if (member.id === client.id) {
      continue;
    }

    sendTo(member, {
      type: "whiteboard-update",
      roomId,
      senderPeerId: client.id,
      senderDisplayName,
      data: message.data,
    });
  }
}

function handleEditorUpdate(
  client: ClientContext,
  message: Extract<ClientMessage, { type: "editor-update" }>,
): void {
  const roomId = client.roomId;
  if (!roomId || roomId !== message.roomId) {
    return;
  }

  const room = rooms.get(roomId);
  if (!room || room.status !== "open") {
    return;
  }

  const senderDisplayName = client.displayName ?? message.senderDisplayName ?? "Peer";
  for (const member of room.participants.values()) {
    if (member.id === client.id) {
      continue;
    }

    sendTo(member, {
      type: "editor-update",
      roomId,
      senderPeerId: client.id,
      senderDisplayName,
      data: message.data,
    });
  }
}

wss.on("connection", (socket) => {
  const client: ClientContext = {
    id: randomUUID(),
    socket,
    relayDiscoverySubscribed: false,
  };
  clientsById.set(client.id, client);

  let disconnected = false;
  const handleDisconnect = (): void => {
    if (disconnected) {
      return;
    }

    disconnected = true;
    clientsById.delete(client.id);
    removeRelayListingsForClient(client.id);
    leaveRoom(client, "disconnect");
  };

  socket.on("message", (data) => {
    try {
      const raw = JSON.parse(data.toString()) as ClientMessage;

      if (raw.type === "create-room" || raw.type === "join-room" || raw.type === "leave-room" || raw.type === "end-room") {
        handleRoomAction(client, raw);
        return;
      }

      if (raw.type === "chat-message") {
        handleChatMessage(client, raw);
        return;
      }

      if (raw.type === "whiteboard-update") {
        handleWhiteboardUpdate(client, raw);
        return;
      }

      if (raw.type === "editor-update") {
        handleEditorUpdate(client, raw);
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
