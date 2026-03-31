import type { Peer, Room } from '../../models/types';
import {
    InMemoryRoomPeerManager,
    MembershipEvent,
    MembershipEventHandler,
    RoomLogger,
    RoomMembership,
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
   * Creates a new room.
   */
  createRoom(name: string, owner: Peer, isPrivate: boolean = false): Room {
    try {
      const room = this.roomPeerManager.createRoom(name, owner, isPrivate);
      RoomLogger.info('Room created successfully', {
        roomId: room.id,
        roomName: name,
        ownerId: owner.id,
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

  /**
   * Discovers available rooms.
   */
  async discoverRooms(): Promise<Room[]> {
    try {
      const rooms = await this.roomPeerManager.discoverRooms();
      RoomLogger.debug('Rooms discovered', { count: rooms.length });
      return rooms;
    } catch (error) {
      RoomLogger.error('Failed to discover rooms', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Joins a room.
   */
  async joinRoom(roomId: string, peer: Peer): Promise<Room> {
    try {
      const room = await this.roomPeerManager.joinRoom(roomId, peer);
      RoomLogger.info('Successfully joined room', {
        roomId,
        peerId: peer.id,
        displayName: peer.displayName,
      });
      return room;
    } catch (error) {
      RoomLogger.error('Failed to join room', {
        error: error instanceof Error ? error.message : String(error),
        roomId,
        peerId: peer.id,
      });
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
