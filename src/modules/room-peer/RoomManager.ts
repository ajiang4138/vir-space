import type { AuthenticationMethod, Peer, Room } from '../../models/types';
import {
    AuthenticationError,
    InMemoryRoomPeerManager,
    MembershipEvent,
    MembershipEventHandler,
    RoomLogger,
    RoomMembership,
    type JoinRoomOptions,
    type RoomPeerManager,
} from './RoomPeerManager';

/**
 * RoomManager orchestrates room lifecycle and integrates with networking/UI.
 * It acts as the main facade for room operations.
 */
export class RoomManager {
  private roomPeerManager: RoomPeerManager;
  private unsubscribeFromEvents: (() => void) | null = null;
  private externalEventHandlers: MembershipEventHandler[] = [];

  constructor() {
    this.roomPeerManager = new InMemoryRoomPeerManager();
    this.setupEventListener();
  }

  /**
   * Sets up internal event listener that delegates to external handlers.
   */
  private setupEventListener(): void {
    this.unsubscribeFromEvents = this.roomPeerManager.onMembershipEvent((event) => {
      this.emitToExternalHandlers(event);
    });
  }

  /**
   * Creates a new room with optional authentication.
   */
  createRoom(
    name: string,
    owner: Peer,
    isPrivate: boolean = false,
    authMethod?: AuthenticationMethod,
  ): Room {
    try {
      const room = this.roomPeerManager.createRoom(
        name,
        owner,
        isPrivate,
        authMethod,
      );
      RoomLogger.info('Room created successfully', {
        roomId: room.id,
        roomName: name,
        ownerId: owner.id,
        authMethod: authMethod || 'none',
      });
      return room;
    } catch (error) {
      RoomLogger.error('Failed to create room', {
        error: error instanceof Error ? error.message : String(error),
        roomName: name,
      });
      throw error;
    }
  }

  async discoverRooms(): Promise<Room[]> {
    try {
      RoomLogger.debug('Room discovery is disabled');
      return [];
    } catch (error) {
      RoomLogger.error('Failed to discover rooms', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Joins a room with optional authentication credential.
   */
  async joinRoom(
    roomId: string,
    peer: Peer,
    options?: JoinRoomOptions,
  ): Promise<Room> {
    try {
      const room = await this.roomPeerManager.joinRoom(roomId, peer, options);
      RoomLogger.info('Successfully joined room', {
        roomId,
        peerId: peer.id,
        displayName: peer.displayName,
      });
      return room;
    } catch (error) {
      if (error instanceof AuthenticationError) {
        RoomLogger.warn('Authentication failed during room join', {
          roomId,
          peerId: peer.id,
          errorCode: error.code,
          lockout: error.remainingLockout,
        });
      } else {
        RoomLogger.error('Failed to join room', {
          error: error instanceof Error ? error.message : String(error),
          roomId,
          peerId: peer.id,
        });
      }
      throw error;
    }
  }

  /**
   * Leaves a room.
   */
  async leaveRoom(roomId: string, peerId: string): Promise<void> {
    try {
      await this.roomPeerManager.leaveRoom(roomId, peerId);
      RoomLogger.info('Successfully left room', { roomId, peerId });
    } catch (error) {
      RoomLogger.error('Failed to leave room', {
        error: error instanceof Error ? error.message : String(error),
        roomId,
        peerId,
      });
      throw error;
    }
  }

  /**
   * Sets a password for a room (room owner only).
   */
  setRoomPassword(roomId: string, password: string): void {
    try {
      this.roomPeerManager.setRoomPassword(roomId, password);
      RoomLogger.info('Room password set', { roomId });
    } catch (error) {
      RoomLogger.error('Failed to set room password', {
        error: error instanceof Error ? error.message : String(error),
        roomId,
      });
      throw error;
    }
  }

  /**
   * Generates and adds an invite token to a room.
   */
  addRoomInviteToken(roomId: string, expiresIn?: number): string {
    try {
      const token = this.roomPeerManager.addRoomInviteToken(roomId, expiresIn);
      RoomLogger.info('Invite token created', { roomId, expiresInMs: expiresIn });
      return token;
    } catch (error) {
      RoomLogger.error('Failed to create invite token', {
        error: error instanceof Error ? error.message : String(error),
        roomId,
      });
      throw error;
    }
  }

  /**
   * Authenticates a peer for a room.
   */
  authenticateForRoom(roomId: string, peerId: string, credential: string): boolean {
    try {
      const authorized = this.roomPeerManager.authenticateForRoom(
        roomId,
        peerId,
        credential,
      );
      if (authorized) {
        RoomLogger.info('Peer authenticated for room', { roomId, peerId });
      } else {
        RoomLogger.warn('Peer authentication failed', { roomId, peerId });
      }
      return authorized;
    } catch (error) {
      RoomLogger.error('Error during authentication', {
        error: error instanceof Error ? error.message : String(error),
        roomId,
        peerId,
      });
      return false;
    }
  }

  /**
   * Gets the authentication method for a room.
   */
  getRoomAuthMethod(roomId: string): string | null {
    return this.roomPeerManager.getRoomAuthMethod(roomId);
  }

  /**
   * Checks if a room is password protected.
   */
  isRoomPasswordProtected(roomId: string): boolean {
    return this.roomPeerManager.isRoomPasswordProtected(roomId);
  }

  /**
   * Gets local membership for a room.
   */
  getLocalMembership(roomId: string): RoomMembership | null {
    return this.roomPeerManager.getLocalMembership(roomId);
  }

  /**
   * Gets all local memberships.
   */
  getAllLocalMemberships(): RoomMembership[] {
    return this.roomPeerManager.getAllLocalMemberships();
  }

  /**
   * Gets peers in a room.
   */
  getRoomPeers(roomId: string): Peer[] {
    const membership = this.roomPeerManager.getLocalMembership(roomId);
    if (!membership) {
      return [];
    }
    return Array.from(membership.peers.values());
  }

  /**
   * Gets a specific peer in a room.
   */
  getRoomPeer(roomId: string, peerId: string): Peer | null {
    const membership = this.roomPeerManager.getLocalMembership(roomId);
    if (!membership) {
      return null;
    }
    return membership.peers.get(peerId) || null;
  }

  /**
   * Broadcasts peer presence to room.
   */
  async broadcastPeerPresence(roomId: string, peer: Peer): Promise<void> {
    try {
      await this.roomPeerManager.broadcastPeerPresence(roomId, peer);
      RoomLogger.debug('Peer presence broadcasted', {
        roomId,
        peerId: peer.id,
      });
    } catch (error) {
      RoomLogger.error('Failed to broadcast peer presence', {
        error: error instanceof Error ? error.message : String(error),
        roomId,
        peerId: peer.id,
      });
      throw error;
    }
  }

  /**
   * Handles event from networking layer.
   */
  handleMembershipEvent(event: MembershipEvent): void {
    try {
      this.roomPeerManager.handleMembershipEvent(event);
    } catch (error) {
      RoomLogger.error('Failed to handle membership event', {
        error: error instanceof Error ? error.message : String(error),
        eventType: event.type,
      });
    }
  }

  getMembershipSnapshot(roomId: string) {
    return this.roomPeerManager.getMembershipSnapshot(roomId);
  }

  applyMembershipSnapshot(snapshot: {
    roomId: string;
    ownerPeerId: string;
    peers: Peer[];
    statuses: Record<string, 'online' | 'idle' | 'offline' | 'disconnected'>;
    generatedAt: string;
  }): void {
    this.roomPeerManager.applyMembershipSnapshot(snapshot);
  }

  resynchronizeMembership(roomId: string, requesterPeerId: string): void {
    this.roomPeerManager.resynchronizeMembership(roomId, requesterPeerId);
  }

  /**
   * Simulates peer disconnection (for testing/recovery).
   */
  simulatePeerDisconnection(roomId: string, peerId: string): void {
    const manager = this.roomPeerManager as unknown as {
      simulatePeerDisconnection(roomId: string, peerId: string): void;
    };
    manager.simulatePeerDisconnection(roomId, peerId);
  }

  /**
   * Simulates peer reconnection (for testing/recovery).
   */
  simulatePeerReconnection(roomId: string, peerId: string, peer: Peer): void {
    const manager = this.roomPeerManager as unknown as {
      simulatePeerReconnection(roomId: string, peerId: string, peer: Peer): void;
    };
    manager.simulatePeerReconnection(roomId, peerId, peer);
  }

  /**
   * Subscribes to membership events.
   */
  onMembershipEvent(handler: MembershipEventHandler): () => void {
    this.externalEventHandlers.push(handler);
    RoomLogger.debug('External membership event handler registered', {
      handlerCount: this.externalEventHandlers.length,
    });

    return () => {
      const index = this.externalEventHandlers.indexOf(handler);
      if (index > -1) {
        this.externalEventHandlers.splice(index, 1);
        RoomLogger.debug('External membership event handler unregistered', {
          handlerCount: this.externalEventHandlers.length,
        });
      }
    };
  }

  /**
   * Gets room metadata.
   */
  getRoomMetadata(roomId: string): Room | null {
    return this.roomPeerManager.getRoomMetadata(roomId);
  }

  /**
   * Cleanup on destroy.
   */
  destroy(): void {
    if (this.unsubscribeFromEvents) {
      this.unsubscribeFromEvents();
      this.unsubscribeFromEvents = null;
    }
    this.externalEventHandlers = [];
    RoomLogger.info('RoomManager destroyed');
  }

  /**
   * Internal: Delegates event to external handlers.
   */
  private emitToExternalHandlers(event: MembershipEvent): void {
    for (const handler of this.externalEventHandlers) {
      try {
        handler(event);
      } catch (error) {
        RoomLogger.error('Error in external membership event handler', {
          error: error instanceof Error ? error.message : String(error),
          eventType: event.type,
        });
      }
    }
  }
}

// Global singleton instance for the application
let roomManagerInstance: RoomManager | null = null;

export function getRoomManager(): RoomManager {
  if (!roomManagerInstance) {
    roomManagerInstance = new RoomManager();
  }
  return roomManagerInstance;
}

export function destroyRoomManager(): void {
  if (roomManagerInstance) {
    roomManagerInstance.destroy();
    roomManagerInstance = null;
  }
}
