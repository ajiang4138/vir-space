/**
 * WorkspaceSyncIntegrationExample.ts
 *
 * Complete integration example showing:
 * - Workspace sync service initialization
 * - Network message routing
 * - Room lifecycle management
 * - Multi-peer synchronization
 * - Metrics reporting
 *
 * This demonstrates how to integrate the decentralized workspace sync
 * with the P2P networking layer and room management.
 */

import type {
    CanvasElement,
    Peer,
    PeerPresenceMetadata,
    Room,
    SyncMessage,
    WorkspaceStateV2,
} from '../../models/types';
import {
  LibP2PNetworkingLayer,
  type INetworkingLayer,
  type NetworkingEvent,
  type NetworkingEventType,
  type NetworkingStats,
  type P2PMessage,
  type PeerConnectionState,
  type RoomPeerConnection,
  type SignalingMessage,
} from '../networking/NetworkingLayer';
import { DecentralizedWorkspaceSyncService } from './WorkspaceSyncService';

interface WorkspaceNetworkEnvelope {
  type?: string;
  payload?: unknown;
  snapshot?: unknown;
}

// ==================== Integration Manager ====================
export class WorkspaceSyncIntegrationManager {
  private syncService: DecentralizedWorkspaceSyncService;
  private networkingLayer: INetworkingLayer;
  private localPeer: Peer;
  private currentRoom: Room | null = null;
  private unsubscribes: (() => void)[] = [];
  private messageSequence = 0;

  // Sync scheduling
  private syncIntervals = new Map<string, ReturnType<typeof window.setInterval>>();
  private readonly SYNC_INTERVAL_MS = 500; // Send sync messages every 500ms
  private readonly SNAPSHOT_INTERVAL_MS = 5000; // Send snapshots every 5s

  constructor(networkingLayer: INetworkingLayer, localPeer: Peer) {
    this.networkingLayer = networkingLayer;
    this.localPeer = localPeer;
    this.syncService = new DecentralizedWorkspaceSyncService(localPeer.id);
  }

  /**
   * Initialize sync service
   */
  async initialize(): Promise<void> {
    console.log(`[WorkspaceSyncIntegration] Initializing sync service for peer ${this.localPeer.id}`);
  }

  /**
   * Join a room and set up synchronization
   */
  async joinRoom(room: Room): Promise<void> {
    console.log(`[WorkspaceSyncIntegration] Joining room ${room.id}`);
    this.currentRoom = room;

    // Signal peer connections in sync service
    for (const peer of room.peers) {
      if (peer.id !== this.localPeer.id) {
        this.syncService.setPeerConnected(room.id, peer.id, true);
      }
    }

    // Request snapshot from an existing peer if available
    if (room.peers.length > 1) {
      await this.requestSnapshot(room.id);
    }

    // Set up network message routing
    this.setupNetworkReceivers(room.id);

    // Start periodic sync
    this.startPeriodicSync(room.id);

    console.log(`[WorkspaceSyncIntegration] Successfully joined room ${room.id}`);
  }

  /**
   * Leave current room
   */
  async leaveRoom(): Promise<void> {
    if (!this.currentRoom) return;

    const roomId = this.currentRoom.id;
    console.log(`[WorkspaceSyncIntegration] Leaving room ${roomId}`);

    // Unsubscribe from all listeners
    for (const unsub of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes = [];

    // Stop periodic sync
    const id = this.syncIntervals.get(roomId);
    if (id) {
      clearInterval(id);
      this.syncIntervals.delete(roomId);
    }

    // Clear room state
    this.syncService.clearRoom(roomId);
    this.currentRoom = null;
  }

  /**
   * Request snapshot from peer (for late joiner support)
   */
  private async requestSnapshot(roomId: string): Promise<void> {
    try {
      // Create a snapshot request message
      const message: SyncMessage = {
        id: crypto.randomUUID(),
        type: 'sync',
        roomId,
        fromPeerId: this.localPeer.id,
        payload: {},
        timestamp: new Date().toISOString(),
        sequenceNumber: this.messageSequence++,
      };

      // Broadcast to room (any peer can respond)
      await this.networkingLayer.broadcastToRoom(roomId, {
        type: 'workspace-sync-request',
        message,
      });
    } catch (error) {
      console.error(`[WorkspaceSyncIntegration] Failed to request snapshot: ${error}`);
    }
  }

  /**
   * Set up network message receivers
   */
  private setupNetworkReceivers(roomId: string): void {
    if (!(this.networkingLayer instanceof LibP2PNetworkingLayer)) {
      return;
    }

    // Listen for sync messages from network
    const unsubscribe = this.networkingLayer.registerMessageHandler(
      roomId,
      async (message: P2PMessage) => {
        const payload = message.data as WorkspaceNetworkEnvelope;
        if (payload.type === 'workspace-sync') {
          try {
            await this.syncService.receiveSyncMessage(payload.payload as SyncMessage);
          } catch (error) {
            console.error(`[WorkspaceSyncIntegration] Error processing sync message: ${error}`);
          }
        } else if (payload.type === 'workspace-snapshot') {
          try {
            await this.syncService.restoreFromSnapshot(roomId, payload.snapshot);
          } catch (error) {
            console.error(`[WorkspaceSyncIntegration] Error restoring snapshot: ${error}`);
          }
        }
      },
    );

    this.unsubscribes.push(unsubscribe);
  }

  /**
   * Start periodic synchronization
   */
  private startPeriodicSync(roomId: string): void {
    // Clear existing interval if any
    const existingId = this.syncIntervals.get(roomId);
    if (existingId) {
      clearInterval(existingId);
    }

    // Periodic sync of delta messages
    const syncIntervalId = window.setInterval(async () => {
      try {
        if (!this.currentRoom) return;

        // Send delta message with pending operations
        const message = await this.syncService.createSyncMessage(roomId, 'delta');

        // Broadcast to room
        await this.networkingLayer.broadcastToRoom(roomId, {
          type: 'workspace-sync',
          payload: message,
        });
      } catch (error) {
        console.error(`[WorkspaceSyncIntegration] Error in periodic sync: ${error}`);
      }
    }, this.SYNC_INTERVAL_MS);

    this.syncIntervals.set(roomId, syncIntervalId);

    // Periodic snapshot sharing (every 5s)
    const snapshotIntervalId = window.setInterval(async () => {
      try {
        if (!this.currentRoom) return;

        // Create and share snapshot
        const snapshot = await this.syncService.createSnapshot(roomId);

        // Broadcast to room (helpful for late joiners)
        await this.networkingLayer.broadcastToRoom(roomId, {
          type: 'workspace-snapshot',
          snapshot,
        });
      } catch (error) {
        console.error(`[WorkspaceSyncIntegration] Error sharing snapshot: ${error}`);
      }
    }, this.SNAPSHOT_INTERVAL_MS);

    this.unsubscribes.push(() => clearInterval(snapshotIntervalId));
  }

  /**
   * Add canvas element (with sync)
   */
  async addCanvasElement(element: CanvasElement): Promise<void> {
    if (!this.currentRoom) throw new Error('Not in a room');

    await this.syncService.addCanvasElement(this.currentRoom.id, element);

    // Element is now in local state
    // It will be broadcast via periodic sync
    console.log(`[WorkspaceSyncIntegration] Added canvas element ${element.id}`);
  }

  /**
   * Update canvas element (with sync)
   */
  async updateCanvasElement(
    elementId: string,
    updates: Partial<CanvasElement>,
  ): Promise<void> {
    if (!this.currentRoom) throw new Error('Not in a room');

    const operation = await this.syncService.updateCanvasElement(
      this.currentRoom.id,
      elementId,
      updates,
    );

    if (!operation) {
      console.warn(`[WorkspaceSyncIntegration] Element ${elementId} not found`);
      return;
    }

    console.log(`[WorkspaceSyncIntegration] Updated canvas element ${elementId}`);
  }

  /**
   * Delete canvas element (with sync)
   */
  async deleteCanvasElement(elementId: string): Promise<void> {
    if (!this.currentRoom) throw new Error('Not in a room');

    const operation = await this.syncService.deleteCanvasElement(
      this.currentRoom.id,
      elementId,
    );

    if (!operation) {
      console.warn(`[WorkspaceSyncIntegration] Element ${elementId} not found`);
      return;
    }

    console.log(`[WorkspaceSyncIntegration] Deleted canvas element ${elementId}`);
  }

  /**
   * Update peer presence (cursor, status, etc.)
   */
  async updatePresence(presence: Partial<PeerPresenceMetadata>): Promise<void> {
    if (!this.currentRoom) throw new Error('Not in a room');

    const fullPresence: PeerPresenceMetadata = {
      peerId: this.localPeer.id,
      color: presence.color ?? '#000000',
      displayName: this.localPeer.displayName,
      cursorPosition: presence.cursorPosition,
      lastActivity: new Date().toISOString(),
      status: presence.status ?? 'active',
    };

    await this.syncService.updatePeerPresence(this.currentRoom.id, fullPresence);
  }

  /**
   * Subscribe to workspace state changes
   */
  subscribeToState(handler: (state: WorkspaceStateV2) => void): () => void {
    if (!this.currentRoom) throw new Error('Not in a room');

    return this.syncService.subscribe(this.currentRoom.id, handler);
  }

  /**
   * Get current workspace state
   */
  async getState() {
    if (!this.currentRoom) return null;
    return this.syncService.getState(this.currentRoom.id);
  }

  /**
   * Get synchronization metrics
   */
  async getMetrics() {
    if (!this.currentRoom) return null;
    return this.syncService.getMetrics(this.currentRoom.id);
  }

  /**
   * Handle peer joining room
   */
  async onPeerJoined(peer: Peer): Promise<void> {
    if (!this.currentRoom) return;

    console.log(`[WorkspaceSyncIntegration] Peer ${peer.id} joined room`);
    this.syncService.setPeerConnected(this.currentRoom.id, peer.id, true);

    // Send snapshot to new peer to help them catch up
    const snapshot = await this.syncService.createSnapshot(this.currentRoom.id);

    await this.networkingLayer.sendDirectMessage(this.currentRoom.id, peer.id, {
      type: 'workspace-snapshot',
      snapshot,
    });
  }

  /**
   * Handle peer leaving room
   */
  async onPeerLeft(peerId: string): Promise<void> {
    if (!this.currentRoom) return;

    console.log(`[WorkspaceSyncIntegration] Peer ${peerId} left room`);
    this.syncService.setPeerConnected(this.currentRoom.id, peerId, false);
  }

  /**
   * Get sync service for advanced operations
   */
  getSyncService(): DecentralizedWorkspaceSyncService {
    return this.syncService;
  }
}

// ==================== Usage Example ====================
export async function exampleUnifyingWorkspaceSyncWithNetworking() {
  console.log('\n=== Workspace Sync Integration Example ===\n');

  // Mock networking layer
  class MockNetworkingLayer implements INetworkingLayer {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    async sendMessage(message: SignalingMessage): Promise<void> {
      void message;
    }
    async sendDirectMessage(roomId: string, toPeerId: string, data: unknown): Promise<void> {
      const envelope = data as WorkspaceNetworkEnvelope;
      console.log(`Sending to peer ${toPeerId} in room ${roomId}:`, envelope.type);
    }
    async broadcastToRoom(roomId: string, data: unknown, excludePeerId?: string): Promise<void> {
      void excludePeerId;
      const envelope = data as WorkspaceNetworkEnvelope;
      console.log(`Broadcasting to room ${roomId}:`, envelope.type);
    }
    getPeerConnectionState(peerId: string): PeerConnectionState | null {
      void peerId;
      return null;
    }
    getRoomConnections(roomId: string): RoomPeerConnection[] {
      void roomId;
      return [];
    }
    on(event: NetworkingEventType, listener: (event: NetworkingEvent) => void): void {
      void event;
      void listener;
    }
    off(event: NetworkingEventType, listener: (event: NetworkingEvent) => void): void {
      void event;
      void listener;
    }
    getLocalPeerId(): string {
      return 'mock-peer';
    }
    getConnectedPeers(): string[] {
      return [];
    }
    getNetworkingStats(): NetworkingStats {
      return {
        connectedPeers: 0,
        totalBytesReceived: 0,
        totalBytesSent: 0,
        activeRenderConnections: 0,
        averageLatency: 0,
        reconnectionAttempts: 0,
      };
    }
  }

  const mockNetworkingLayer: INetworkingLayer = new MockNetworkingLayer();

  // Create peers
  const peer1: Peer = {
    id: 'peer-1',
    displayName: 'Alice',
    status: 'online',
    capabilities: ['canvas', 'presence'],
    lastSeenAt: new Date().toISOString(),
  };

  const peer2: Peer = {
    id: 'peer-2',
    displayName: 'Bob',
    status: 'online',
    capabilities: ['canvas', 'presence'],
    lastSeenAt: new Date().toISOString(),
  };

  // Create room
  const room: Room = {
    id: 'room-1',
    name: 'Collaboration Space',
    ownerPeerId: peer1.id,
    peers: [peer1, peer2],
    createdAt: new Date().toISOString(),
    isPrivate: false,
  };

  // Initialize sync managers for both peers
  const manager1 = new WorkspaceSyncIntegrationManager(mockNetworkingLayer, peer1);
  const manager2 = new WorkspaceSyncIntegrationManager(mockNetworkingLayer, peer2);

  await manager1.initialize();
  await manager2.initialize();

  // Both peers join room
  await manager1.joinRoom(room);
  console.log('Peer 1 joined room');

  // Peer 2 joins (late joiner)
  await manager2.joinRoom(room);
  console.log('Peer 2 joined room (late joiner)');

  // Peer 1 creates elements
  const element1: CanvasElement = {
    id: 'shape-1',
    type: 'shape',
    x: 100,
    y: 200,
    width: 100,
    height: 100,
    data: { color: '#FF0000' },
    createdBy: peer1.id,
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    modifiedBy: peer1.id,
  };

  await manager1.addCanvasElement(element1);
  console.log('Peer 1 created element', element1.id);

  // Peer 2 updates presence
  await manager2.updatePresence({
    color: '#0000FF',
    cursorPosition: { x: 250, y: 350 },
    status: 'active',
  });
  console.log('Peer 2 updated presence');

  // Peer 1 subscribes to state changes
  manager1.subscribeToState((state) => {
    console.log('State changed:', {
      elementsCount: state.canvas.elements.size,
      activePeers: state.activePeers.length,
      version: state.version,
    });
  });

  // Simulate some time passing
  await new Promise(r => setTimeout(r, 100));

  // Get metrics
  const metrics1 = await manager1.getMetrics();
  console.log('\nPeer 1 Metrics:', {
    updateLatency: `${metrics1?.updateLatencyMs?.toFixed(2)}ms`,
    syncsPerSecond: metrics1?.syncsPerSecond?.toFixed(2),
    pendingOperations: metrics1?.pendingOperations,
    totalPeers: metrics1?.totalPeers,
  });

  // Cleanup
  await manager1.leaveRoom();
  await manager2.leaveRoom();

  console.log('\n=== Example Complete ===\n');
}
