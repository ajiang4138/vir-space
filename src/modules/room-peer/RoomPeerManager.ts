import type { AuthenticationMethod, Peer, Room } from '../../models/types';
import { AuthenticationService, getAuthenticationService } from '../security/AuthenticationService';

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
  discoverRooms(): Promise<Room[]>;
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
  setRoomPassword(roomId: string, password: string): void;
  setRoomSharedSecret(roomId: string, secret: string): void;
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
  private authService: AuthenticationService | null = null; // Will be set lazily to avoid circular dependency

  private getAuthService() {
    if (!this.authService) {
      this.authService = getAuthenticationService();
    }
    return this.authService;
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
    const authConfig = authMethod && authMethod !== 'public'
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

  /**
   * Discovers available rooms (simulated - returns all non-private rooms or rooms with known peers).
   */
  async discoverRooms(): Promise<Room[]> {
    RoomLogger.debug('Discovering rooms', { totalRooms: this.roomRegistry.size });

    return Array.from(this.roomRegistry.values()).filter(
      (room) => !room.isPrivate || room.peers.length > 0, // Simple filter: non-private or has peers
    );
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
    const room = this.roomRegistry.get(roomId);
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
    const room = this.roomRegistry.get(roomId);
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
    const room = this.roomRegistry.get(roomId);
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
    RoomLogger.info('Room password set', { roomId });
  }

  /**
   * Sets a shared secret for a room.
   */
  setRoomSharedSecret(roomId: string, secret: string): void {
    const room = this.roomRegistry.get(roomId);
    if (!room) {
      RoomLogger.error('Room not found for setRoomSharedSecret', { roomId });
      return;
    }

    const authService = this.getAuthService();

    if (!room.authConfig) {
      room.authConfig = authService.createAuthConfig('shared-secret');
    }

    room.authConfig.method = 'shared-secret';
    room.authConfig.secretHash = authService.hashSharedSecret(secret);
    room.authConfig.requireAuthForJoin = true;

    this.roomRegistry.set(roomId, room);
    RoomLogger.info('Room shared secret set', { roomId });
  }

  /**
   * Adds an invite token to a room.
   */
  addRoomInviteToken(roomId: string, expiresIn?: number): string {
    const room = this.roomRegistry.get(roomId);
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
    const room = this.roomRegistry.get(roomId);
    return room?.authConfig?.method || null;
  }

  /**
   * Checks if a room requires password authentication.
   */
  isRoomPasswordProtected(roomId: string): boolean {
    const room = this.roomRegistry.get(roomId);
    return room?.authConfig?.method === 'password' || false;
  }

  /**
   * Leaves a room and removes local membership.
   */
  async leaveRoom(roomId: string, peerId: string): Promise<void> {
    const room = this.roomRegistry.get(roomId);
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
    return this.roomRegistry.get(roomId) || null;
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
