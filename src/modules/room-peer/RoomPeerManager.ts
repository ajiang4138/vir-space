import type { Peer, Room } from '../../models/types';

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

// ==================== Room Manager Interface ====================
export interface RoomPeerManager {
  createRoom(name: string, owner: Peer, isPrivate: boolean): Room;
  discoverRooms(): Promise<Room[]>;
  joinRoom(roomId: string, peer: Peer): Promise<Room>;
  leaveRoom(roomId: string, peerId: string): Promise<void>;
  getLocalMembership(roomId: string): RoomMembership | null;
  getAllLocalMemberships(): RoomMembership[];
  onMembershipEvent(handler: MembershipEventHandler): () => void; // Returns unsubscribe function
  broadcastPeerPresence(roomId: string, peer: Peer): Promise<void>;
  handleMembershipEvent(event: MembershipEvent): void;
  getRoomMetadata(roomId: string): Room | null;
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

  /**
   * Creates a new room with a unique identifier.
   * The owner is added as the first member.
   */
  createRoom(name: string, owner: Peer, isPrivate: boolean): Room {
    const roomId = crypto.randomUUID();
    const room: Room = {
      id: roomId,
      name,
      ownerPeerId: owner.id,
      peers: [owner],
      createdAt: new Date().toISOString(),
      isPrivate,
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
   * Joins a room and establishes local membership.
   * Broadcasts peer-joined event to other members.
   */
  async joinRoom(roomId: string, peer: Peer): Promise<Room> {
    const room = this.roomRegistry.get(roomId);
    if (!room) {
      RoomLogger.error('Room not found for join', { roomId, peerId: peer.id });
      throw new Error(`Room ${roomId} not found`);
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
}
