import type { AuthenticationMethod, Peer, Room } from '../../models/types';
import { AuthenticationService, getAuthenticationService } from '../security/AuthenticationService';

const ROOM_STATE_STORAGE_PREFIX = 'vir-space:room-state:';
const ROOM_STATE_EVENT_PREFIX = 'vir-space:room-state:event:';

interface SerializedAuthConfig {
  method: AuthenticationMethod;
  passwordHash?: string;
  inviteTokens?: Array<[
    string,
    { createdAt: string; expiresAt?: string; usedAt?: string; usedByPeerId?: string },
  ]>;
  requireAuthForJoin: boolean;
  maxAttempts?: number;
  lockoutDurationMs?: number;
}

interface SerializedRoom extends Omit<Room, 'authConfig'> {
  authConfig?: SerializedAuthConfig;
}

interface SerializedRoomMembership {
  roomId: string;
  peers: Peer[];
  peerStatuses: Record<string, 'online' | 'idle' | 'offline' | 'disconnected'>;
  ownerPeerId: string;
  joinedAt: string;
  localPeerId: string;
}

interface SerializedRoomState {
  room: SerializedRoom;
  membership: SerializedRoomMembership | null;
  version: number;
  updatedAt: string;
}

function serializeAuthConfig(authConfig?: Room['authConfig']): SerializedAuthConfig | undefined {
  if (!authConfig) {
    return undefined;
  }

  return {
    ...authConfig,
    inviteTokens: authConfig.inviteTokens ? Array.from(authConfig.inviteTokens.entries()) : undefined,
  };
}

function deserializeAuthConfig(authConfig?: SerializedAuthConfig): Room['authConfig'] | undefined {
  if (!authConfig) {
    return undefined;
  }

  return {
    ...authConfig,
    inviteTokens: authConfig.inviteTokens ? new Map(authConfig.inviteTokens) : undefined,
  };
}

function serializeRoom(room: Room): SerializedRoom {
  return {
    ...room,
    authConfig: serializeAuthConfig(room.authConfig),
  };
}

function deserializeRoom(room: SerializedRoom): Room {
  return {
    ...room,
    authConfig: deserializeAuthConfig(room.authConfig),
  };
}

function serializeMembership(membership: RoomMembership): SerializedRoomMembership {
  return {
    roomId: membership.roomId,
    peers: Array.from(membership.peers.values()),
    peerStatuses: Object.fromEntries(membership.peerStatuses.entries()) as SerializedRoomMembership['peerStatuses'],
    ownerPeerId: membership.ownerPeerId,
    joinedAt: membership.joinedAt,
    localPeerId: membership.localPeerId,
  };
}

// ==================== Event Types ====================
export type MembershipEventType =
  | 'peer-joined'
  | 'peer-left'
  | 'peer-disconnected'
  | 'peer-reconnected'
  | 'peer-status-changed'
  | 'room-created'
  | 'room-destroyed';

export interface MembershipEvent {
  type: MembershipEventType;
  roomId: string;
  peerId: string;
  peer?: Peer;
  timestamp: string;
  details?: Record<string, unknown>;
}

export type MembershipEventHandler = (event: MembershipEvent) => void;

// ==================== Local Membership Model ====================
export interface RoomMembership {
  roomId: string;
  peers: Map<string, Peer>; // peerId -> Peer
  peerStatuses: Map<string, 'online' | 'idle' | 'offline' | 'disconnected'>; // peerId -> Status
  ownerPeerId: string;
  joinedAt: string;
  localPeerId: string; // Current peer's ID
}

// ==================== Authentication Related Types ====================
export interface JoinRoomOptions {
  credential?: string; // Password, secret, or invite token
  attemptId?: string; // For tracking failed attempts
}

export type AuthenticationErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'EXPIRED_TOKEN'
  | 'ROOM_NOT_FOUND';

export class AuthenticationError extends Error {
  constructor(
    public code: AuthenticationErrorCode,
    message: string,
    public remainingLockout?: number,
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

// ==================== Room Manager Interface ====================
export interface RoomPeerManager {
  createRoom(
    name: string,
    owner: Peer,
    isPrivate: boolean,
    authMethod?: AuthenticationMethod,
  ): Room;
  joinRoom(roomId: string, peer: Peer, options?: JoinRoomOptions): Promise<Room>;
  authenticateForRoom(
    roomId: string,
    peerId: string,
    credential: string,
  ): boolean;
  leaveRoom(roomId: string, peerId: string): Promise<void>;
  getLocalMembership(roomId: string): RoomMembership | null;
  getAllLocalMemberships(): RoomMembership[];
  onMembershipEvent(handler: MembershipEventHandler): () => void; // Returns unsubscribe function
  broadcastPeerPresence(roomId: string, peer: Peer): Promise<void>;
  handleMembershipEvent(event: MembershipEvent): void;
  getMembershipSnapshot(roomId: string): {
    roomId: string;
    ownerPeerId: string;
    peers: Peer[];
    statuses: Record<string, 'online' | 'idle' | 'offline' | 'disconnected'>;
    generatedAt: string;
  } | null;
  applyMembershipSnapshot(snapshot: {
    roomId: string;
    ownerPeerId: string;
    peers: Peer[];
    statuses: Record<string, 'online' | 'idle' | 'offline' | 'disconnected'>;
    generatedAt: string;
  }): void;
  resynchronizeMembership(roomId: string, requesterPeerId: string): void;
  getRoomMetadata(roomId: string): Room | null;
  importRoom(room: Room): void;
  setRoomPassword(roomId: string, password: string): void;
  addRoomInviteToken(roomId: string, expiresIn?: number): string;
  getRoomAuthMethod(roomId: string): string | null;
  isRoomPasswordProtected(roomId: string): boolean;
}

// ==================== Logger Utility ====================
export class RoomLogger {
  static log(level: 'info' | 'debug' | 'warn' | 'error', message: string, context?: Record<string, unknown>) {
    const timestamp = new Date().toISOString();
    const contextStr = context ? ` | ${JSON.stringify(context)}` : '';
    console.log(`[${level.toUpperCase()}] [RoomPeerManager] ${timestamp} - ${message}${contextStr}`);
  }

  static info(message: string, context?: Record<string, unknown>) {
    this.log('info', message, context);
  }

  static debug(message: string, context?: Record<string, unknown>) {
    this.log('debug', message, context);
  }

  static warn(message: string, context?: Record<string, unknown>) {
    this.log('warn', message, context);
  }

  static error(message: string, context?: Record<string, unknown>) {
    this.log('error', message, context);
  }
}

// ==================== In-Memory Implementation ====================
export class InMemoryRoomPeerManager implements RoomPeerManager {
  private roomRegistry = new Map<string, Room>(); // Global room registry (simulating persistence)
  private localMemberships = new Map<string, RoomMembership>(); // Local peer's memberships
  private eventHandlers: MembershipEventHandler[] = [];
  private peerConnectionStates = new Map<string, 'connected' | 'disconnected'>(); // peerId -> connection state
  private roomVersions = new Map<string, number>();
  private authService: AuthenticationService | null = null; // Will be set lazily to avoid circular dependency
  private readonly hasWindow = typeof window !== 'undefined';
  private readonly roomChannels = new Map<string, BroadcastChannel>();
  private storageListenerRegistered = false;

  constructor() {
    this.setupStorageListener();
  }

  private getAuthService() {
    if (!this.authService) {
      this.authService = getAuthenticationService();
    }
    return this.authService;
  }

  private getRoomStorageKey(roomId: string): string {
    return `${ROOM_STATE_STORAGE_PREFIX}${roomId}`;
  }

  private getRoomEventChannel(roomId: string): BroadcastChannel | null {
    if (!this.hasWindow || typeof BroadcastChannel === 'undefined') {
      return null;
    }

    const existing = this.roomChannels.get(roomId);
    if (existing) {
      return existing;
    }

    const channel = new BroadcastChannel(`${ROOM_STATE_EVENT_PREFIX}${roomId}`);
    channel.onmessage = (event: MessageEvent<SerializedRoomState>) => {
      this.handleRemoteRoomState(event.data);
    };

    this.roomChannels.set(roomId, channel);
    return channel;
  }

  private setupStorageListener(): void {
    if (!this.hasWindow || this.storageListenerRegistered) {
      return;
    }

    window.addEventListener('storage', (event: StorageEvent) => {
      if (!event.key || !event.key.startsWith(ROOM_STATE_STORAGE_PREFIX) || !event.newValue) {
        if (event.key && event.key.startsWith(ROOM_STATE_STORAGE_PREFIX) && event.newValue === null) {
          const roomId = event.key.slice(ROOM_STATE_STORAGE_PREFIX.length);
          this.roomRegistry.delete(roomId);
          this.localMemberships.delete(roomId);
          this.roomVersions.delete(roomId);
          this.emitEvent({
            type: 'room-destroyed',
            roomId,
            peerId: '',
            timestamp: new Date().toISOString(),
          });
        }
        return;
      }

      try {
        const payload = JSON.parse(event.newValue) as SerializedRoomState;
        this.handleRemoteRoomState(payload);
      } catch {
        // Ignore malformed cross-tab room state.
      }
    });

    this.storageListenerRegistered = true;
  }

  private readRoomState(roomId: string): SerializedRoomState | null {
    if (!this.hasWindow) {
      return null;
    }

    try {
      const raw = window.localStorage.getItem(this.getRoomStorageKey(roomId));
      if (!raw) {
        return null;
      }

      return JSON.parse(raw) as SerializedRoomState;
    } catch {
      return null;
    }
  }

  private createRoomStatePayload(roomId: string): SerializedRoomState | null {
    const room = this.roomRegistry.get(roomId);
    if (!room) {
      return null;
    }

    return {
      room: serializeRoom(room),
      membership: this.localMemberships.has(roomId)
        ? serializeMembership(this.localMemberships.get(roomId)!)
        : null,
      version: this.roomVersions.get(roomId) || 0,
      updatedAt: new Date().toISOString(),
    };
  }

  private persistRoomState(roomId: string): void {
    const payload = this.createRoomStatePayload(roomId);
    if (!payload) {
      if (this.hasWindow) {
        try {
          window.localStorage.removeItem(this.getRoomStorageKey(roomId));
        } catch {
          // no-op
        }
      }
      return;
    }

    const nextVersion = (this.roomVersions.get(roomId) || 0) + 1;
    payload.version = nextVersion;
    this.roomVersions.set(roomId, nextVersion);

    if (this.hasWindow) {
      try {
        window.localStorage.setItem(this.getRoomStorageKey(roomId), JSON.stringify(payload));
      } catch {
        // no-op: localStorage might be unavailable in sandboxed contexts.
      }
    }

    this.getRoomEventChannel(roomId)?.postMessage(payload);
  }

  private syncLocalMembershipFromSnapshot(snapshot: SerializedRoomMembership): void {
    const existing = this.localMemberships.get(snapshot.roomId);
    if (!existing) {
      return;
    }

    const previousPeers = new Map(existing.peers);
    const previousStatuses = new Map(existing.peerStatuses);

    existing.peers.clear();
    existing.peerStatuses.clear();

    for (const peer of snapshot.peers) {
      existing.peers.set(peer.id, peer);
      existing.peerStatuses.set(peer.id, snapshot.peerStatuses[peer.id] ?? peer.status);
      this.peerConnectionStates.set(
        peer.id,
        (snapshot.peerStatuses[peer.id] ?? peer.status) === 'offline' ? 'disconnected' : 'connected',
      );
    }

    for (const [peerId, peer] of existing.peers.entries()) {
      const previousPeer = previousPeers.get(peerId);
      const previousStatus = previousStatuses.get(peerId);
      const nextStatus = existing.peerStatuses.get(peerId);

      if (!previousPeer) {
        this.emitEvent({
          type: 'peer-joined',
          roomId: snapshot.roomId,
          peerId,
          peer,
          timestamp: new Date().toISOString(),
        });
      } else if (previousStatus !== nextStatus) {
        this.emitEvent({
          type: 'peer-status-changed',
          roomId: snapshot.roomId,
          peerId,
          peer,
          timestamp: new Date().toISOString(),
          details: { previousStatus, nextStatus },
        });
      }
    }

    for (const [peerId, peer] of previousPeers.entries()) {
      if (!existing.peers.has(peerId)) {
        this.emitEvent({
          type: 'peer-left',
          roomId: snapshot.roomId,
          peerId,
          peer,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  private ensureRoomLoaded(roomId: string): Room | null {
    const existing = this.roomRegistry.get(roomId);
    if (existing) {
      return existing;
    }

    const persisted = this.readRoomState(roomId);
    if (!persisted) {
      return null;
    }

    const room = deserializeRoom(persisted.room);
    this.roomRegistry.set(roomId, room);
    this.roomVersions.set(roomId, persisted.version || 0);

    if (persisted.membership) {
      this.syncLocalMembershipFromSnapshot(persisted.membership);
    }

    return room;
  }

  private handleRemoteRoomState(payload: SerializedRoomState): void {
    if (!payload?.room?.id) {
      return;
    }

    const currentVersion = this.roomVersions.get(payload.room.id) || 0;
    if (payload.version <= currentVersion) {
      return;
    }

    const room = deserializeRoom(payload.room);
    this.roomRegistry.set(room.id, room);
    this.roomVersions.set(room.id, payload.version);

    if (payload.membership) {
      this.syncLocalMembershipFromSnapshot(payload.membership);
    }
  }

  /**
   * Creates a new room with a unique identifier.
   * The owner is added as the first member.
   */
  createRoom(
    name: string,
    owner: Peer,
    isPrivate: boolean,
    authMethod?: AuthenticationMethod,
  ): Room {
    const roomId = crypto.randomUUID();
    const authService = this.getAuthService();

    // Set up auth config based on method
    const authConfig = authMethod
      ? authService.createAuthConfig(authMethod)
      : undefined;

    const room: Room = {
      id: roomId,
      name,
      ownerPeerId: owner.id,
      peers: [owner],
      createdAt: new Date().toISOString(),
      isPrivate,
      authConfig,
    };

    this.roomRegistry.set(roomId, room);
    this.roomVersions.set(roomId, 0);

    // Create local membership for the owner
    const membership: RoomMembership = {
      roomId,
      peers: new Map([[owner.id, owner]]),
      peerStatuses: new Map([[owner.id, owner.status]]),
      ownerPeerId: owner.id,
      joinedAt: new Date().toISOString(),
      localPeerId: owner.id,
    };
    this.localMemberships.set(roomId, membership);

    this.peerConnectionStates.set(owner.id, 'connected');
    this.persistRoomState(roomId);

    RoomLogger.info('Room created', {
      roomId,
      name,
      ownerId: owner.id,
      isPrivate,
      authMethod: authConfig?.method || 'none',
    });

    // Emit event
    this.emitEvent({
      type: 'room-created',
      roomId,
      peerId: owner.id,
      peer: owner,
      timestamp: new Date().toISOString(),
    });

    return room;
  }

  async discoverRooms(): Promise<Room[]> {
    RoomLogger.debug('Room discovery is disabled');
    return [];
  }

  /**
   * Joins a room with optional authentication.
   * Validates credentials if room requires authentication.
   */
  async joinRoom(
    roomId: string,
    peer: Peer,
    options?: JoinRoomOptions,
  ): Promise<Room> {
    const room = this.ensureRoomLoaded(roomId);
    if (!room) {
      RoomLogger.error('Room not found for join', { roomId, peerId: peer.id });
      throw new AuthenticationError('ROOM_NOT_FOUND', `Room ${roomId} not found`);
    }

    const authService = this.getAuthService();

    // Check authentication if room requires it
    if (room.authConfig?.requireAuthForJoin) {
      const result = authService.authenticatePeerForRoom(
        room.authConfig,
        options?.credential,
        peer.id,
        roomId,
      );

      if (!result.authorized) {
        const remainingLockout = authService.getRemainingLockoutTime(
          peer.id,
          roomId,
        );

        RoomLogger.warn('Authentication failed for room join', {
          roomId,
          peerId: peer.id,
          errorCode: result.errorCode,
          lockoutRemaining: remainingLockout > 0 ? remainingLockout : undefined,
        });

        throw new AuthenticationError(
          result.errorCode as AuthenticationErrorCode,
          result.errorMessage || 'Authentication failed',
          remainingLockout > 0 ? remainingLockout : undefined,
        );
      }

      RoomLogger.info('Peer authenticated for room', {
        roomId,
        peerId: peer.id,
        method: room.authConfig.method,
      });
    }

    // Check if peer is already in room
    if (room.peers.find((p) => p.id === peer.id)) {
      RoomLogger.warn('Peer already in room', { roomId, peerId: peer.id });
      return room;
    }

    // Add peer to room
    room.peers.push(peer);
    this.roomRegistry.set(roomId, room);

    // Create or update local membership
    if (!this.localMemberships.has(roomId)) {
      const membership: RoomMembership = {
        roomId,
        peers: new Map(),
        peerStatuses: new Map(),
        ownerPeerId: room.ownerPeerId,
        joinedAt: new Date().toISOString(),
        localPeerId: peer.id,
      };
      this.localMemberships.set(roomId, membership);
    }

    const membership = this.localMemberships.get(roomId)!;
    membership.peers.set(peer.id, peer);
    membership.peerStatuses.set(peer.id, peer.status);
    this.peerConnectionStates.set(peer.id, 'connected');
    this.persistRoomState(roomId);

    RoomLogger.info('Peer joined room', {
      roomId,
      peerId: peer.id,
      displayName: peer.displayName,
      totalPeers: room.peers.length,
    });

    // Emit event
    this.emitEvent({
      type: 'peer-joined',
      roomId,
      peerId: peer.id,
      peer,
      timestamp: new Date().toISOString(),
    });

    return room;
  }

  /**
   * Authenticates a peer for a specific room.
   */
  authenticateForRoom(roomId: string, peerId: string, credential: string): boolean {
    const room = this.ensureRoomLoaded(roomId);
    if (!room || !room.authConfig) {
      return false;
    }

    const authService = this.getAuthService();
    const result = authService.authenticatePeerForRoom(
      room.authConfig,
      credential,
      peerId,
      roomId,
    );

    return result.authorized;
  }

  /**
   * Sets a password for a room.
   */
  setRoomPassword(roomId: string, password: string): void {
    const room = this.ensureRoomLoaded(roomId);
    if (!room) {
      RoomLogger.error('Room not found for setRoomPassword', { roomId });
      return;
    }

    const authService = this.getAuthService();

    if (!room.authConfig) {
      room.authConfig = authService.createAuthConfig('password');
    }

    room.authConfig.method = 'password';
    room.authConfig.passwordHash = authService.hashPassword(password);
    room.authConfig.requireAuthForJoin = true;

    this.roomRegistry.set(roomId, room);
    this.persistRoomState(roomId);
    RoomLogger.info('Room password set', { roomId });
  }

  /**
   * Adds an invite token to a room.
   */
  addRoomInviteToken(roomId: string, expiresIn?: number): string {
    const room = this.ensureRoomLoaded(roomId);
    if (!room) {
      RoomLogger.error('Room not found for addRoomInviteToken', { roomId });
      return '';
    }

    const authService = this.getAuthService();

    if (!room.authConfig) {
      room.authConfig = authService.createAuthConfig('invite-token');
    }

    room.authConfig.method = 'invite-token';
    room.authConfig.requireAuthForJoin = true;

    const token = authService.addInviteToken(room.authConfig, expiresIn);
    this.roomRegistry.set(roomId, room);
    this.persistRoomState(roomId);

    RoomLogger.info('Room invite token created', {
      roomId,
      expiresIn,
      token: token.slice(0, 4) + '****',
    });

    return token;
  }

  /**
   * Gets the auth method for a room.
   */
  getRoomAuthMethod(roomId: string): string | null {
    const room = this.ensureRoomLoaded(roomId);
    return room?.authConfig?.method || null;
  }

  /**
   * Checks if a room requires password authentication.
   */
  isRoomPasswordProtected(roomId: string): boolean {
    const room = this.ensureRoomLoaded(roomId);
    return room?.authConfig?.method === 'password' || false;
  }

  /**
   * Leaves a room and removes local membership.
   */
  async leaveRoom(roomId: string, peerId: string): Promise<void> {
    const room = this.ensureRoomLoaded(roomId);
    if (!room) {
      RoomLogger.warn('Room not found for leave', { roomId, peerId });
      return;
    }

    const peerIndex = room.peers.findIndex((p) => p.id === peerId);
    if (peerIndex > -1) {
      room.peers.splice(peerIndex, 1);
      this.roomRegistry.set(roomId, room);
    }

    // Remove local membership if it's the local peer
    const membership = this.localMemberships.get(roomId);
    if (membership && membership.localPeerId === peerId) {
      this.localMemberships.delete(roomId);

      // Clean up room if it's empty or only has owner
      if (room.peers.length === 0) {
        this.roomRegistry.delete(roomId);
        this.localMemberships.delete(roomId);
        this.roomVersions.delete(roomId);
        if (this.hasWindow) {
          try {
            window.localStorage.removeItem(this.getRoomStorageKey(roomId));
          } catch {
            // no-op
          }
        }
        RoomLogger.info('Room destroyed (empty)', { roomId });
        this.emitEvent({
          type: 'room-destroyed',
          roomId,
          peerId,
          timestamp: new Date().toISOString(),
        });
      }
    }

    RoomLogger.info('Peer left room', {
      roomId,
      peerId,
      remainingPeers: room.peers.length,
    });

    // Emit event
    this.emitEvent({
      type: 'peer-left',
      roomId,
      peerId,
      timestamp: new Date().toISOString(),
    });

    this.persistRoomState(roomId);
  }

  /**
   * Gets the local membership model for a room.
   */
  getLocalMembership(roomId: string): RoomMembership | null {
    return this.localMemberships.get(roomId) || null;
  }

  /**
   * Gets all local room memberships.
   */
  getAllLocalMemberships(): RoomMembership[] {
    return Array.from(this.localMemberships.values());
  }

  /**
   * Gets room metadata from registry.
   */
  getRoomMetadata(roomId: string): Room | null {
    return this.ensureRoomLoaded(roomId);
  }

  importRoom(room: Room): void {
    this.roomRegistry.set(room.id, room);
    if (!this.roomVersions.has(room.id)) {
      this.roomVersions.set(room.id, 0);
    }

    if (!this.localMemberships.has(room.id)) {
      return;
    }

    const membership = this.localMemberships.get(room.id)!;
    membership.ownerPeerId = room.ownerPeerId;
    for (const peer of room.peers) {
      membership.peers.set(peer.id, peer);
      membership.peerStatuses.set(peer.id, peer.status);
    }
  }

  /**
   * Subscribes to membership events.
   * Returns an unsubscribe function.
   */
  onMembershipEvent(handler: MembershipEventHandler): () => void {
    this.eventHandlers.push(handler);
    RoomLogger.debug('Membership event handler registered', {
      handlerCount: this.eventHandlers.length,
    });

    // Return unsubscribe function
    return () => {
      const index = this.eventHandlers.indexOf(handler);
      if (index > -1) {
        this.eventHandlers.splice(index, 1);
        RoomLogger.debug('Membership event handler unregistered', {
          handlerCount: this.eventHandlers.length,
        });
      }
    };
  }

  /**
   * Broadcasts peer presence to other peers in the room.
   */
  async broadcastPeerPresence(roomId: string, peer: Peer): Promise<void> {
    const membership = this.localMemberships.get(roomId);
    if (!membership) {
      RoomLogger.warn('Membership not found for presence broadcast', {
        roomId,
        peerId: peer.id,
      });
      return;
    }

    // Update local peer status
    membership.peerStatuses.set(peer.id, peer.status);
    membership.peers.set(peer.id, peer);

    RoomLogger.debug('Peer presence broadcasted', {
      roomId,
      peerId: peer.id,
      status: peer.status,
    });

    // In a real system, this would send to a signaling server
    this.emitEvent({
      type: 'peer-status-changed',
      roomId,
      peerId: peer.id,
      peer,
      timestamp: new Date().toISOString(),
      details: { newStatus: peer.status },
    });

    this.persistRoomState(roomId);
  }

  /**
   * Handles incoming membership events.
   * This would be called when receiving events from other peers via the networking layer.
   */
  handleMembershipEvent(event: MembershipEvent): void {
    const membership = this.localMemberships.get(event.roomId);
    if (!membership) {
      RoomLogger.warn('Membership not found for event handling', {
        roomId: event.roomId,
        eventType: event.type,
      });
      return;
    }

    switch (event.type) {
      case 'peer-joined': {
        if (event.peer) {
          membership.peers.set(event.peerId, event.peer);
          membership.peerStatuses.set(event.peerId, event.peer.status);
          this.peerConnectionStates.set(event.peerId, 'connected');
          RoomLogger.info('Member event processed: peer-joined', {
            roomId: event.roomId,
            peerId: event.peerId,
            displayName: event.peer.displayName,
          });
        }
        break;
      }

      case 'peer-left': {
        membership.peers.delete(event.peerId);
        membership.peerStatuses.delete(event.peerId);
        this.peerConnectionStates.delete(event.peerId);
        RoomLogger.info('Member event processed: peer-left', {
          roomId: event.roomId,
          peerId: event.peerId,
          remainingPeers: membership.peers.size,
        });
        break;
      }

      case 'peer-disconnected': {
        this.peerConnectionStates.set(event.peerId, 'disconnected');
        membership.peerStatuses.set(event.peerId, 'offline');
        RoomLogger.warn('Member event processed: peer-disconnected', {
          roomId: event.roomId,
          peerId: event.peerId,
        });
        break;
      }

      case 'peer-reconnected': {
        this.peerConnectionStates.set(event.peerId, 'connected');
        if (event.peer) {
          membership.peerStatuses.set(event.peerId, event.peer.status);
        }
        RoomLogger.info('Member event processed: peer-reconnected', {
          roomId: event.roomId,
          peerId: event.peerId,
        });
        break;
      }

      case 'peer-status-changed': {
        if (event.peer) {
          membership.peers.set(event.peerId, event.peer);
          membership.peerStatuses.set(event.peerId, event.peer.status);
          RoomLogger.debug('Member event processed: peer-status-changed', {
            roomId: event.roomId,
            peerId: event.peerId,
            newStatus: event.peer.status,
          });
        }
        break;
      }

      default:
        RoomLogger.warn('Unknown membership event type', {
          eventType: event.type,
        });
    }

    // Emit to subscribers
    this.emitEvent(event);

    this.persistRoomState(event.roomId);
  }

  /**
   * Simulates peer disconnection (could be called by networking layer on connection loss).
   */
  simulatePeerDisconnection(roomId: string, peerId: string): void {
    RoomLogger.warn('Simulating unexpected disconnection for churn recovery', {
      roomId,
      peerId,
    });
    this.handleMembershipEvent({
      type: 'peer-disconnected',
      roomId,
      peerId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Simulates peer reconnection recovery.
   */
  simulatePeerReconnection(roomId: string, peerId: string, peer: Peer): void {
    RoomLogger.info('Simulating peer reconnection for recovery validation', {
      roomId,
      peerId,
    });
    this.handleMembershipEvent({
      type: 'peer-reconnected',
      roomId,
      peerId,
      peer,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Internal: Emits event to all subscribers.
   */
  private emitEvent(event: MembershipEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        RoomLogger.error('Error in membership event handler', {
          error: error instanceof Error ? error.message : String(error),
          eventType: event.type,
        });
      }
    }
  }

  getMembershipSnapshot(roomId: string): {
    roomId: string;
    ownerPeerId: string;
    peers: Peer[];
    statuses: Record<string, 'online' | 'idle' | 'offline' | 'disconnected'>;
    generatedAt: string;
  } | null {
    const membership = this.localMemberships.get(roomId);
    if (!membership) {
      return null;
    }

    const statuses: Record<string, 'online' | 'idle' | 'offline' | 'disconnected'> = {};
    for (const [peerId, status] of membership.peerStatuses.entries()) {
      statuses[peerId] = status;
    }

    return {
      roomId,
      ownerPeerId: membership.ownerPeerId,
      peers: Array.from(membership.peers.values()),
      statuses,
      generatedAt: new Date().toISOString(),
    };
  }

  applyMembershipSnapshot(snapshot: {
    roomId: string;
    ownerPeerId: string;
    peers: Peer[];
    statuses: Record<string, 'online' | 'idle' | 'offline' | 'disconnected'>;
    generatedAt: string;
  }): void {
    const existing = this.localMemberships.get(snapshot.roomId);
    if (!existing) {
      return;
    }

    const previous = new Map(existing.peers);

    existing.peers.clear();
    existing.peerStatuses.clear();

    for (const peer of snapshot.peers) {
      existing.peers.set(peer.id, peer);
      existing.peerStatuses.set(peer.id, snapshot.statuses[peer.id] ?? peer.status);
      this.peerConnectionStates.set(
        peer.id,
        (snapshot.statuses[peer.id] ?? peer.status) === 'offline' ? 'disconnected' : 'connected',
      );
    }

    RoomLogger.info('Applied membership snapshot', {
      roomId: snapshot.roomId,
      peerCount: snapshot.peers.length,
      generatedAt: snapshot.generatedAt,
    });

    for (const [peerId, peer] of existing.peers.entries()) {
      if (!previous.has(peerId)) {
        this.emitEvent({
          type: 'peer-joined',
          roomId: snapshot.roomId,
          peerId,
          peer,
          timestamp: new Date().toISOString(),
        });
      }
    }

    for (const [peerId, peer] of previous.entries()) {
      if (!existing.peers.has(peerId)) {
        this.emitEvent({
          type: 'peer-left',
          roomId: snapshot.roomId,
          peerId,
          peer,
          timestamp: new Date().toISOString(),
        });
      }
    }

    this.persistRoomState(snapshot.roomId);
  }

  resynchronizeMembership(roomId: string, requesterPeerId: string): void {
    const snapshot = this.getMembershipSnapshot(roomId);
    if (!snapshot) {
      RoomLogger.warn('Membership resync requested for unknown room', {
        roomId,
        requesterPeerId,
      });
      return;
    }

    RoomLogger.info('Membership resync requested', {
      roomId,
      requesterPeerId,
      peerCount: snapshot.peers.length,
    });

    this.emitEvent({
      type: 'peer-status-changed',
      roomId,
      peerId: requesterPeerId,
      timestamp: new Date().toISOString(),
      details: {
        recovery: 'membership-resync',
        snapshotPeerCount: snapshot.peers.length,
      },
    });
  }
}
