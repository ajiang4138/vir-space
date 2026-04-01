/**
 * NetworkingIntegration.ts
 *
 * Integration layer combining:
 * - P2P Networking Layer (libp2p)
 * - Peer Discovery
 * - Connection Management
 * - Quality Monitoring
 *
 * This file demonstrates how to integrate all networking components
 * with the RoomManager for a complete peer-to-peer communication system.
 */

import type { Peer, Room } from '../../models/types';
import { ConnectionManager } from './ConnectionManager';
import { LibP2PNetworkingLayer, type INetworkingLayer } from './NetworkingLayer';
import {
    ConnectionQualityTracker,
    NetworkingDiagnosticsUtil,
    NetworkStateMonitor,
} from './NetworkingUtils';

// ==================== Integrated Networking Manager ====================
export class IntegratedNetworkingManager {
  private networkingLayer: INetworkingLayer;
  private connectionManager: ConnectionManager;
  private qualityTracker = new ConnectionQualityTracker();
  private stateMonitor = new NetworkStateMonitor();

  private roomEventHandlers = new Map<
    string,
    (event: {
      type: string;
      data: unknown;
    }) => void
  >();

  constructor(networkingLayer?: INetworkingLayer) {
    this.networkingLayer = networkingLayer || new LibP2PNetworkingLayer();
    this.connectionManager = new ConnectionManager();
  }

  /**
   * Initializes the integrated networking manager
   */
  async initialize(): Promise<void> {
    try {
      console.log('Initializing integrated networking manager...');

      // Start the networking layer
      await this.networkingLayer.start();

      // Set up event listeners
      this.setupNetworkingEventListeners();

      console.log('Integrated networking manager initialized successfully');
    } catch (error) {
      console.error('Failed to initialize networking manager:', error);
      throw error;
    }
  }

  /**
   * Joins a room and establishes peer connections
   */
  async joinRoom(room: Room, localPeer: Peer): Promise<void> {
    try {
      console.log(`Joining room ${room.id} as peer ${localPeer.id}`);

      // Establish connections to all other peers in the room
      for (const peer of room.peers) {
        if (peer.id !== localPeer.id) {
          try {
            const connInfo = await this.connectionManager.openConnection(room.id, peer.id);
            if (this.networkingLayer instanceof LibP2PNetworkingLayer) {
              this.networkingLayer.addRoomPeerConnection(room.id, peer.id);
            }
            console.log(`Connected to peer ${peer.id}`, connInfo);
          } catch (error) {
            console.warn(`Failed to connect to peer ${peer.id}:`, error);
          }
        }
      }

      // Register message handler for this room
      if (this.networkingLayer instanceof LibP2PNetworkingLayer) {
        this.networkingLayer.registerMessageHandler(room.id, (msg) => {
          this.handleRoomMessage(room.id, {
            fromPeerId: msg.fromPeerId,
            data: msg.data,
          });
        });
      }

      console.log(`Successfully joined room ${room.id}`);
    } catch (error) {
      console.error(`Failed to join room ${room.id}:`, error);
      throw error;
    }
  }

  /**
   * Leaves a room and closes all related connections
   */
  async leaveRoom(roomId: string): Promise<void> {
    try {
      console.log(`Leaving room ${roomId}`);

      // Close all connections in the room
      await this.connectionManager.closeRoomConnections(roomId);

      // Remove message handler
      this.roomEventHandlers.delete(roomId);

      console.log(`Successfully left room ${roomId}`);
    } catch (error) {
      console.error(`Failed to leave room ${roomId}:`, error);
      throw error;
    }
  }

  /**
   * Sends a message to a specific peer in a room
   */
  async sendMessageToPeer(roomId: string, toPeerId: string, data: unknown): Promise<void> {
    try {
      await this.networkingLayer.sendDirectMessage(roomId, toPeerId, data);
    } catch (error) {
      console.error(`Failed to send message to ${toPeerId}:`, error);
      throw error;
    }
  }

  /**
   * Broadcasts a message to all peers in a room
   */
  async broadcastToRoom(roomId: string, data: unknown, excludeSelf?: boolean): Promise<void> {
    try {
      const excludePeerId = excludeSelf ? this.networkingLayer.getLocalPeerId() : undefined;
      await this.networkingLayer.broadcastToRoom(roomId, data, excludePeerId);
    } catch (error) {
      console.error(`Failed to broadcast to room ${roomId}:`, error);
      throw error;
    }
  }

  /**
   * Sets up networking event listeners
   */
  private setupNetworkingEventListeners(): void {
    this.networkingLayer.on('peer-discovered', (event) => {
      console.log('Peer discovered:', event.peerId);
    });

    this.networkingLayer.on('connection-opened', (event) => {
      console.log('Connection opened to:', event.peerId);
    });

    this.networkingLayer.on('connection-closed', (event) => {
      console.log('Connection closed to:', event.peerId);
    });

    this.networkingLayer.on('message-received', (event) => {
      console.log('Message received from:', event.peerId);
    });

    this.networkingLayer.on('reconnect-attempt', (event) => {
      console.log('Reconnection attempt to:', event.peerId);
    });

    this.networkingLayer.on('error', (event) => {
      console.error('Networking error:', event.error);
    });
  }

  /**
   * Handles incoming message for a room
   */
  private handleRoomMessage(
    roomId: string,
    msg: {
      fromPeerId: string;
      data: unknown;
    },
  ): void {
    const handler = this.roomEventHandlers.get(roomId);
    if (handler) {
      handler({ type: 'message', data: msg });
    }
  }

  /**
   * Registers a room event handler
   */
  registerRoomEventHandler(
    roomId: string,
    handler: (event: { type: string; data: unknown }) => void,
  ): () => void {
    this.roomEventHandlers.set(roomId, handler);

    return () => {
      this.roomEventHandlers.delete(roomId);
    };
  }

  onNetworkingEvent(eventType: Parameters<INetworkingLayer['on']>[0], listener: Parameters<INetworkingLayer['on']>[1]): () => void {
    this.networkingLayer.on(eventType, listener);
    return () => this.networkingLayer.off(eventType, listener);
  }

  getConnectedPeers(): string[] {
    return this.networkingLayer.getConnectedPeers();
  }

  /**
   * Gets networking statistics
   */
  getNetworkingStats() {
    return this.networkingLayer.getNetworkingStats();
  }

  /**
   * Gets connection manager stats
   */
  getConnectionStats() {
    return this.connectionManager.getStats();
  }

  /**
   * Gets quality metrics for a peer
   */
  getPeerQualityMetrics(peerId: string) {
    return this.qualityTracker.getQualityMetrics(peerId);
  }

  /**
   * Records latency measurement
   */
  recordLatency(peerId: string, latencyMs: number, success: boolean = true): void {
    this.qualityTracker.recordLatency(peerId, latencyMs, success);
  }

  /**
   * Gets comprehensive diagnostics
   */
  getDiagnostics() {
    const peerConnections = new Map();
    const roomConnections = new Map();

    // Gather peer connection states
    for (const peer of this.networkingLayer.getConnectedPeers()) {
      const state = this.networkingLayer.getPeerConnectionState(peer);
      if (state) {
        peerConnections.set(peer, state);
      }
    }

    // Gather room connections
    const allConnections = this.connectionManager.getAllConnections();
    for (const conn of allConnections) {
      if (!roomConnections.has(conn.roomId)) {
        roomConnections.set(conn.roomId, []);
      }
      roomConnections.get(conn.roomId).push({
        peerId: conn.peerId,
        connected: conn.established,
        bytesReceived: conn.bytesReceived,
        bytesSent: conn.bytesSent,
      });
    }

    return NetworkingDiagnosticsUtil.generateDiagnostics(
      this.networkingLayer.getLocalPeerId(),
      peerConnections,
      roomConnections,
      this.qualityTracker,
    );
  }

  /**
   * Gets formatted diagnostics for debugging
   */
  getDiagnosticsReport(): string {
    const diagnostics = this.getDiagnostics();
    this.stateMonitor.recordDiagnostics(diagnostics);
    return NetworkingDiagnosticsUtil.formatDiagnosticsForLog(diagnostics);
  }

  /**
   * Prints networking diagnostics to console
   */
  printDiagnostics(): void {
    console.log(this.getDiagnosticsReport());
  }

  /**
   * Shutdown and cleanup
   */
  async shutdown(): Promise<void> {
    try {
      console.log('Shutting down networking manager...');

      this.connectionManager.cleanup();
      await this.networkingLayer.stop();

      console.log('Networking manager shutdown complete');
    } catch (error) {
      console.error('Error during shutdown:', error);
      throw error;
    }
  }
}

// ==================== Usage Example ====================
/*
 * Example of how to use the IntegratedNetworkingManager:
 *
 * // Initialize
 * const networkingManager = new IntegratedNetworkingManager();
 * await networkingManager.initialize();
 *
 * // Join a room
 * const room: Room = { ... };
 * const localPeer: Peer = { ... };
 * await networkingManager.joinRoom(room, localPeer);
 *
 * // Send message to specific peer
 * await networkingManager.sendMessageToPeer(
 *   room.id,
 *   targetPeerId,
 *   { type: 'workspace-update', data: {...} }
 * );
 *
 * // Broadcast to all peers in room
 * await networkingManager.broadcastToRoom(
 *   room.id,
 *   { type: 'peer-presence', data: {...} },
 *   true // exclude self
 * );
 *
 * // Register event handler
 * networkingManager.registerRoomEventHandler(room.id, (event) => {
 *   if (event.type === 'message') {
 *     console.log('Received:', event.data);
 *   }
 * });
 *
 * // Get diagnostics
 * console.log(networkingManager.getDiagnosticsReport());
 *
 * // Leave room
 * await networkingManager.leaveRoom(room.id);
 *
 * // Shutdown
 * await networkingManager.shutdown();
 */
