import { identify } from '@libp2p/identify';
import { kadDHT } from '@libp2p/kad-dht';
import { mplex } from '@libp2p/mplex';
import { noise } from '@libp2p/noise';
import { ping } from '@libp2p/ping';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import all from 'it-all';
import type { Libp2p } from 'libp2p';
import { createLibp2p } from 'libp2p';
import { concat as concatUint8Arrays } from 'uint8arrays/concat';
import {
    TransportEncryptionManager,
    type EncryptedPayloadEnvelope,
    type TransportSecurityReport,
} from '../security/TransportEncryption';

// ==================== Networking Events ====================
export type NetworkingEventType =
  | 'security-initialized'
  | 'peer-discovered'
  | 'connection-opened'
  | 'connection-closed'
  | 'message-sent'
  | 'message-received'
  | 'reconnect-attempt'
  | 'reconnect-success'
  | 'reconnect-failed'
  | 'error';

export interface NetworkingEvent {
  type: NetworkingEventType;
  peerId?: string;
  roomId?: string;
  message?: SignalingMessage;
  error?: Error | string;
  timestamp: string;
  details?: Record<string, unknown>;
}

// ==================== Core Message Types ====================
export interface SignalingMessage {
  type: string;
  payload: unknown;
  fromPeerId?: string;
  roomId?: string;
  messageId?: string;
}

export interface P2PMessage {
  roomId: string;
  fromPeerId: string;
  toPeerId: string;
  data: unknown;
  messageId: string;
  timestamp: string;
}

// ==================== Peer Connection State ====================
export interface PeerConnectionState {
  peerId: string;
  connected: boolean;
  lastSeen: string;
  connectionAttempts: number;
  lastError?: string;
  multiaddrs: string[];
}

export interface RoomPeerConnection {
  roomId: string;
  peerId: string;
  connected: boolean;
  protocol: 'tcp' | 'webrtc' | 'unknown';
  latency?: number;
  bytesReceived: number;
  bytesSent: number;
}

// ==================== Networking Layer Interface ====================
export interface INetworkingLayer {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(message: SignalingMessage): Promise<void>;
  sendDirectMessage(roomId: string, toPeerId: string, data: unknown): Promise<void>;
  broadcastToRoom(roomId: string, data: unknown, excludePeerId?: string): Promise<void>;
  getPeerConnectionState(peerId: string): PeerConnectionState | null;
  getRoomConnections(roomId: string): RoomPeerConnection[];
  on(event: NetworkingEventType, listener: (event: NetworkingEvent) => void): void;
  off(event: NetworkingEventType, listener: (event: NetworkingEvent) => void): void;
  getLocalPeerId(): string;
  getConnectedPeers(): string[];
  getNetworkingStats(): NetworkingStats;
}

export interface NetworkingStats {
  connectedPeers: number;
  totalBytesReceived: number;
  totalBytesSent: number;
  activeRenderConnections: number;
  averageLatency: number;
  reconnectionAttempts: number;
}

type NetworkingEventListener = (event: NetworkingEvent) => void;

class BrowserEventBus {
  private listeners = new Map<NetworkingEventType, Set<NetworkingEventListener>>();

  on(event: NetworkingEventType, listener: NetworkingEventListener): void {
    const existing = this.listeners.get(event);
    if (existing) {
      existing.add(listener);
      return;
    }

    this.listeners.set(event, new Set([listener]));
  }

  off(event: NetworkingEventType, listener: NetworkingEventListener): void {
    const existing = this.listeners.get(event);
    if (!existing) {
      return;
    }

    existing.delete(listener);
    if (existing.size === 0) {
      this.listeners.delete(event);
    }
  }

  emit(event: NetworkingEventType, payload: NetworkingEvent): void {
    const existing = this.listeners.get(event);
    if (!existing) {
      return;
    }

    for (const listener of existing) {
      listener(payload);
    }
  }
}

// ==================== Libp2p-based Networking Layer ====================
export class LibP2PNetworkingLayer implements INetworkingLayer {
  private eventEmitter = new BrowserEventBus();
  private node: Libp2p | null = null;
  private localPeerId: string = '';
  private peerConnections = new Map<string, PeerConnectionState>();
  private roomPeerConnections = new Map<string, RoomPeerConnection[]>();
  private messageHandlers = new Map<string, (msg: P2PMessage) => void>();
  private reconnectionIntervals = new Map<string, NodeJS.Timeout>();
  private totalBytesReceived = 0;
  private totalBytesSent = 0;
  private reconnectionAttempts = 0;
  private isStarted = false;
  private transportEncryption = new TransportEncryptionManager();

  private static readonly PROTOCOL_PREFIX = '/vir-space/1.0.0';
  private static readonly MESSAGE_PROTOCOL = '/vir-space/messages/1.0.0';
  private static readonly RECONNECT_INTERVAL = 5000; // 5 seconds
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly STUN_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['stun:stun1.l.google.com:19302'] },
  ];

  constructor() {}

  /**
   * Configures a shared per-room secret used for payload encryption.
   */
  setRoomTransportSecret(roomId: string, secret: string): void {
    this.transportEncryption.setRoomSecret(roomId, secret);
    NetworkingLogger.info('Configured encrypted transport secret for room', { roomId });
  }

  /**
   * Returns current transport security configuration diagnostics.
   */
  getTransportSecurityReport(): TransportSecurityReport {
    return this.transportEncryption.getSecurityReport();
  }

  /**
   * Utility to validate whether a payload is an encrypted transport envelope.
   */
  validateCapturedPayload(payload: unknown): boolean {
    return this.transportEncryption.isEncryptedEnvelope(payload);
  }

  /**
   * Initializes and starts the libp2p node
   */
  async start(): Promise<void> {
    try {
      NetworkingLogger.info('Initializing P2P networking layer...');
      this.initializeTransportSecurity();

      // Create libp2p node with comprehensive configuration
      this.node = await createLibp2p({
        addresses: {
          listen: ['/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/tcp/0/ws'],
        },
        transports: [tcp(), webSockets()],
        streamMuxers: [mplex()],
        connectionEncryption: [noise()],
        peerDiscovery: [],
        services: {
          identify: identify(),
          ping: ping(),
          dht: kadDHT(),
        },
      });

      // Start the node
      await this.node.start();

      this.localPeerId = this.node.peerId.toString();
      this.isStarted = true;

      NetworkingLogger.info('P2P node started successfully', {
        peerId: this.localPeerId,
        multiaddrs: this.node.getMultiaddrs().map((m) => m.toString()),
        transportEncryption: 'noise+aes-gcm',
      });

      // Set up event listeners
      this.setupNodeEventListeners();

      // Handle incoming messages
      await this.setupMessageHandler();
    } catch (error) {
      NetworkingLogger.error('Failed to start P2P networking', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Stops the libp2p node
   */
  async stop(): Promise<void> {
    try {
      if (!this.node) {
        return;
      }

      NetworkingLogger.info('Stopping P2P networking layer...');

      // Clear all reconnection intervals
      for (const timeout of this.reconnectionIntervals.values()) {
        clearTimeout(timeout);
      }
      this.reconnectionIntervals.clear();

      // Stop the node
      await this.node.stop();
      this.node = null;
      this.isStarted = false;

      NetworkingLogger.info('P2P node stopped successfully');
    } catch (error) {
      NetworkingLogger.error('Error stopping P2P node', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Sends a signaling message (compatibility interface)
   */
  async sendMessage(message: SignalingMessage): Promise<void> {
    try {
      if (!this.node) {
        throw new Error('P2P node not initialized');
      }

      const payload =
        message.roomId && message.payload !== undefined
          ? await this.transportEncryption.encryptPayload(message.roomId, message.payload)
          : message.payload;

      const outboundMessage: SignalingMessage = {
        ...message,
        payload,
      };

      NetworkingLogger.debug('Sending signaling message', {
        type: message.type,
        toPeerId: message.fromPeerId,
        encrypted: this.transportEncryption.isEncryptedEnvelope(payload),
      });

      // Emit event for message sent
      this.emitNetworkingEvent({
        type: 'message-sent',
        message: outboundMessage,
        timestamp: new Date().toISOString(),
      });

      this.totalBytesSent += JSON.stringify(outboundMessage).length;
    } catch (error) {
      NetworkingLogger.error('Failed to send message', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Sends a direct message to a specific peer in a room
   */
  async sendDirectMessage(roomId: string, toPeerId: string, data: unknown): Promise<void> {
    try {
      if (!this.node) {
        throw new Error('P2P node not initialized');
      }

      const message: P2PMessage = {
        roomId,
        fromPeerId: this.localPeerId,
        toPeerId,
        data: await this.transportEncryption.encryptPayload(roomId, data),
        messageId: this.generateMessageId(),
        timestamp: new Date().toISOString(),
      };

      NetworkingLogger.debug('Sending direct message to peer', {
        roomId,
        fromPeerId: this.localPeerId,
        toPeerId,
        messageId: message.messageId,
      });

      // In a real implementation, this would establish a stream and send the message
      // For now, we simulate it
      const messageSize = JSON.stringify(message).length;
      this.totalBytesSent += messageSize;

      // Emit message sent event
      this.emitNetworkingEvent({
        type: 'message-sent',
        peerId: toPeerId,
        roomId,
        timestamp: new Date().toISOString(),
        details: { messageId: message.messageId, bytes: messageSize, encrypted: true },
      });
    } catch (error) {
      NetworkingLogger.error('Failed to send direct message', {
        error: error instanceof Error ? error.message : String(error),
        toPeerId,
        roomId,
      });
      throw error;
    }
  }

  /**
   * Broadcasts a message to all peers in a room
   */
  async broadcastToRoom(roomId: string, data: unknown, excludePeerId?: string): Promise<void> {
    try {
      if (!this.node) {
        throw new Error('P2P node not initialized');
      }

      const connections = this.roomPeerConnections.get(roomId) || [];
      NetworkingLogger.debug('Broadcasting to room', {
        roomId,
        recipientCount: connections.length - (excludePeerId ? 1 : 0),
      });

      for (const conn of connections) {
        if (excludePeerId && conn.peerId === excludePeerId) {
          continue;
        }

        try {
          await this.sendDirectMessage(roomId, conn.peerId, data);
        } catch (error) {
          NetworkingLogger.warn('Failed to send broadcast to peer', {
            error: error instanceof Error ? error.message : String(error),
            peerId: conn.peerId,
            roomId,
          });
        }
      }
    } catch (error) {
      NetworkingLogger.error('Failed to broadcast to room', {
        error: error instanceof Error ? error.message : String(error),
        roomId,
      });
      throw error;
    }
  }

  /**
   * Gets the connection state of a specific peer
   */
  getPeerConnectionState(peerId: string): PeerConnectionState | null {
    return this.peerConnections.get(peerId) || null;
  }

  /**
   * Gets all connections in a room
   */
  getRoomConnections(roomId: string): RoomPeerConnection[] {
    return this.roomPeerConnections.get(roomId) || [];
  }

  on(event: NetworkingEventType, listener: (event: NetworkingEvent) => void): void {
    this.eventEmitter.on(event, listener);
  }

  off(event: NetworkingEventType, listener: (event: NetworkingEvent) => void): void {
    this.eventEmitter.off(event, listener);
  }

  /**
   * Gets the local peer ID
   */
  getLocalPeerId(): string {
    return this.localPeerId;
  }

  /**
   * Gets all connected peers
   */
  getConnectedPeers(): string[] {
    return Array.from(this.peerConnections.values())
      .filter((state) => state.connected)
      .map((state) => state.peerId);
  }

  /**
   * Gets networking statistics
   */
  getNetworkingStats(): NetworkingStats {
    const connectedPeers = this.getConnectedPeers();
    const activeRoomConnections = Array.from(this.roomPeerConnections.values()).reduce(
      (sum, conns) => sum + conns.filter((c) => c.connected).length,
      0,
    );

    return {
      connectedPeers: connectedPeers.length,
      totalBytesReceived: this.totalBytesReceived,
      totalBytesSent: this.totalBytesSent,
      activeRenderConnections: activeRoomConnections,
      averageLatency: this.calculateAverageLatency(),
      reconnectionAttempts: this.reconnectionAttempts,
    };
  }

  /**
   * Sets up node event listeners
   */
  private setupNodeEventListeners(): void {
    if (!this.node) {
      return;
    }

    this.node.addEventListener('peer:discovery', (evt) => {
      const peerId = evt.detail.id.toString();
      NetworkingLogger.debug('Peer discovered', { peerId });

      if (!this.peerConnections.has(peerId)) {
        this.peerConnections.set(peerId, {
          peerId,
          connected: false,
          lastSeen: new Date().toISOString(),
          connectionAttempts: 0,
          multiaddrs: [],
        });
      }

      this.emitNetworkingEvent({
        type: 'peer-discovered',
        peerId,
        timestamp: new Date().toISOString(),
        details: { peerId },
      });
    });

    this.node.addEventListener('peer:connect', (evt) => {
      const peerId = evt.detail.toString();
      NetworkingLogger.info('Peer connected', { peerId });

      const state = this.peerConnections.get(peerId);
      if (state) {
        state.connected = true;
        state.lastSeen = new Date().toISOString();
        state.connectionAttempts = 0;
      }

      this.emitNetworkingEvent({
        type: 'connection-opened',
        peerId,
        timestamp: new Date().toISOString(),
      });
    });

    this.node.addEventListener('peer:disconnect', (evt) => {
      const peerId = evt.detail.toString();
      NetworkingLogger.info('Peer disconnected', { peerId });

      const state = this.peerConnections.get(peerId);
      if (state) {
        state.connected = false;
      }

      this.emitNetworkingEvent({
        type: 'connection-closed',
        peerId,
        timestamp: new Date().toISOString(),
      });

      // Start reconnection attempt
      this.attemptReconnection(peerId);
    });
  }

  /**
   * Sets up message handler for incoming messages
   */
  private async setupMessageHandler(): Promise<void> {
    if (!this.node) {
      return;
    }

    try {
      await this.node.handle(LibP2PNetworkingLayer.MESSAGE_PROTOCOL, async (stream) => {
        try {
          const chunks = (await all(stream.source)) as Uint8Array[];
          const dataBytes = concatUint8Arrays(chunks);
          const dataStr = new TextDecoder().decode(dataBytes);
          const message = JSON.parse(dataStr) as P2PMessage;
          if (!this.transportEncryption.isEncryptedEnvelope(message.data)) {
            throw new Error(`Inbound payload for room ${message.roomId} was not encrypted`);
          }
          const decryptedPayload = await this.transportEncryption.decryptPayload(
            message.roomId,
            message.data as EncryptedPayloadEnvelope,
          );
          message.data = decryptedPayload;

          this.totalBytesReceived += dataStr.length;

          NetworkingLogger.debug('Message received from peer', {
            fromPeerId: message.fromPeerId,
            messageId: message.messageId,
            roomId: message.roomId,
          });

          this.emitNetworkingEvent({
            type: 'message-received',
            peerId: message.fromPeerId,
            roomId: message.roomId,
            timestamp: message.timestamp,
            details: { data: message.data, messageId: message.messageId, encrypted: true },
          });

          // Call registered handler if available
          const handler = this.messageHandlers.get(message.roomId);
          if (handler) {
            handler(message);
          }

          await stream.close();
        } catch (error) {
          NetworkingLogger.error('Error handling incoming message', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    } catch (error) {
      NetworkingLogger.warn('Could not set up message handler', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Attempts to reconnect to a peer
   */
  private attemptReconnection(peerId: string): void {
    const state = this.peerConnections.get(peerId);
    if (!state || state.connectionAttempts >= LibP2PNetworkingLayer.MAX_RECONNECT_ATTEMPTS) {
      return;
    }

    state.connectionAttempts++;

    this.emitNetworkingEvent({
      type: 'reconnect-attempt',
      peerId,
      timestamp: new Date().toISOString(),
      details: { attempt: state.connectionAttempts },
    });

    this.reconnectionAttempts++;

    // Clear any existing interval
    if (this.reconnectionIntervals.has(peerId)) {
      clearTimeout(this.reconnectionIntervals.get(peerId)!);
    }

    // Schedule reconnection
    const timeout = setTimeout(() => {
      if (state.connected) {
        this.emitNetworkingEvent({
          type: 'reconnect-success',
          peerId,
          timestamp: new Date().toISOString(),
        });
      } else if (state.connectionAttempts < LibP2PNetworkingLayer.MAX_RECONNECT_ATTEMPTS) {
        this.attemptReconnection(peerId);
      } else {
        this.emitNetworkingEvent({
          type: 'reconnect-failed',
          peerId,
          timestamp: new Date().toISOString(),
          details: { maxAttemptsReached: true },
        });
      }
    }, LibP2PNetworkingLayer.RECONNECT_INTERVAL);

    this.reconnectionIntervals.set(peerId, timeout);
  }

  /**
   * Generates a unique message ID
   */
  private generateMessageId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Calculates average latency across all connections
   */
  private calculateAverageLatency(): number {
    const latencies = Array.from(this.roomPeerConnections.values())
      .flatMap((conns) => conns)
      .filter((conn) => conn.latency !== undefined)
      .map((conn) => conn.latency as number);

    if (latencies.length === 0) {
      return 0;
    }

    return latencies.reduce((a, b) => a + b, 0) / latencies.length;
  }

  /**
   * Emits a networking event
   */
  private emitNetworkingEvent(event: NetworkingEvent): void {
    NetworkingLogger.debug('Networking event emitted', {
      type: event.type,
      peerId: event.peerId,
      roomId: event.roomId,
    });

    this.eventEmitter.emit(event.type, event);
  }

  private initializeTransportSecurity(): void {
    const report = this.transportEncryption.getSecurityReport();
    if (!report.webCryptoAvailable) {
      throw new Error('Secure transport initialization failed: WebCrypto API is not available');
    }

    NetworkingLogger.info('Transport security initialized', {
      secureTransport: 'libp2p-noise',
      payloadEncryption: 'AES-GCM (WebCrypto)',
      configuredRooms: report.configuredRooms,
    });

    this.emitNetworkingEvent({
      type: 'security-initialized',
      timestamp: new Date().toISOString(),
      details: {
        secureTransport: 'libp2p-noise',
        payloadEncryption: 'AES-GCM',
      },
    });
  }

  /**
   * Registers a message handler for a room
   */
  registerMessageHandler(roomId: string, handler: (msg: P2PMessage) => void): () => void {
    this.messageHandlers.set(roomId, handler);

    return () => {
      this.messageHandlers.delete(roomId);
    };
  }

  /**
   * Adds a peer connection to a room
   */
  addRoomPeerConnection(roomId: string, peerId: string, protocol: 'tcp' | 'webrtc' = 'tcp'): void {
    if (!this.roomPeerConnections.has(roomId)) {
      this.roomPeerConnections.set(roomId, []);
    }

    const connections = this.roomPeerConnections.get(roomId)!;
    const existing = connections.find((c) => c.peerId === peerId);

    if (!existing) {
      connections.push({
        roomId,
        peerId,
        connected: true,
        protocol,
        bytesReceived: 0,
        bytesSent: 0,
      });

      NetworkingLogger.info('Added peer connection to room', { roomId, peerId, protocol });
    }
  }

  /**
   * Removes a peer connection from a room
   */
  removeRoomPeerConnection(roomId: string, peerId: string): void {
    const connections = this.roomPeerConnections.get(roomId);
    if (!connections) {
      return;
    }

    const index = connections.findIndex((c) => c.peerId === peerId);
    if (index >= 0) {
      connections.splice(index, 1);
      NetworkingLogger.info('Removed peer connection from room', { roomId, peerId });
    }

    if (connections.length === 0) {
      this.roomPeerConnections.delete(roomId);
    }
  }
}

// ==================== Compatibility Interface ====================
/**
 * WebSocket-based networking layer for backward compatibility and alternative transport
 */
export class WebSocketNetworkingLayer implements INetworkingLayer {
  private eventEmitter = new BrowserEventBus();
  private ws: WebSocket | null = null;
  private localPeerId: string = '';
  private endpoint: string = '';
  private connectedPeers: Set<string> = new Set();
  private messageQueue: SignalingMessage[] = [];
  private isConnected = false;
  private totalBytesSent = 0;
  private totalBytesReceived = 0;

  /**
   * Connects to a WebSocket endpoint
   */
  async connect(endpoint: string): Promise<void> {
    this.endpoint = endpoint;
    return new Promise((resolve, reject) => {
      try {
        this.assertSecureWebSocketEndpoint(endpoint);
        this.ws = new WebSocket(endpoint);

        this.ws.onopen = () => {
          NetworkingLogger.info('WebSocket connected', { endpoint });
          this.isConnected = true;
          this.emitNetworkingEvent({
            type: 'connection-opened',
            timestamp: new Date().toISOString(),
          });
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as SignalingMessage;
            this.totalBytesReceived += String(event.data).length;
            this.emitNetworkingEvent({
              type: 'message-received',
              message,
              timestamp: new Date().toISOString(),
            });
          } catch (error) {
            NetworkingLogger.error('Error parsing WebSocket message', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        };

        this.ws.onerror = (error) => {
          NetworkingLogger.error('WebSocket error', { error: error.toString() });
          this.emitNetworkingEvent({
            type: 'error',
            error: error instanceof Error ? error.message : 'WebSocket error',
            timestamp: new Date().toISOString(),
          });
          reject(error);
        };

        this.ws.onclose = () => {
          NetworkingLogger.warn('WebSocket closed');
          this.isConnected = false;
          this.emitNetworkingEvent({
            type: 'connection-closed',
            timestamp: new Date().toISOString(),
          });
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  async start(): Promise<void> {
    // For WebSocket, we just log startup
    NetworkingLogger.info('WebSocket networking layer started');
  }

  async stop(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    NetworkingLogger.info('WebSocket networking layer stopped');
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
    }
  }

  async send(message: SignalingMessage): Promise<void> {
    if (!this.isConnected || !this.ws) {
      this.messageQueue.push(message);
      return;
    }

    const serialized = JSON.stringify(message);
    this.ws.send(serialized);
    this.totalBytesSent += serialized.length;
    this.emitNetworkingEvent({
      type: 'message-sent',
      message,
      timestamp: new Date().toISOString(),
    });
  }

  async sendMessage(message: SignalingMessage): Promise<void> {
    await this.send(message);
  }

  async sendDirectMessage(roomId: string, toPeerId: string, data: unknown): Promise<void> {
    void roomId;
    void toPeerId;
    void data;
    // WebSocket implementation would route through server
  }

  async broadcastToRoom(roomId: string, data: unknown, excludePeerId?: string): Promise<void> {
    void roomId;
    void data;
    void excludePeerId;
    // WebSocket implementation would route through server
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
    this.eventEmitter.on(event, listener);
  }

  off(event: NetworkingEventType, listener: (event: NetworkingEvent) => void): void {
    this.eventEmitter.off(event, listener);
  }

  getLocalPeerId(): string {
    return this.localPeerId;
  }

  getConnectedPeers(): string[] {
    return Array.from(this.connectedPeers);
  }

  getNetworkingStats(): NetworkingStats {
    return {
      connectedPeers: this.connectedPeers.size,
      totalBytesReceived: this.totalBytesReceived,
      totalBytesSent: this.totalBytesSent,
      activeRenderConnections: 0,
      averageLatency: 0,
      reconnectionAttempts: 0,
    };
  }

  private emitNetworkingEvent(event: NetworkingEvent): void {
    this.eventEmitter.emit(event.type, event);
  }

  private assertSecureWebSocketEndpoint(endpoint: string): void {
    const isSecure = endpoint.startsWith('wss://');
    const isLocalDevEndpoint = /^(ws:\/\/)(localhost|127\.0\.0\.1|\[::1\])/i.test(endpoint);

    if (!isSecure && !isLocalDevEndpoint) {
      throw new Error(
        `Insecure WebSocket endpoint blocked: ${endpoint}. Use wss:// for encrypted transport.`,
      );
    }

    NetworkingLogger.info('WebSocket transport policy validated', {
      endpoint,
      encryptedTransport: isSecure,
      localDevException: !isSecure && isLocalDevEndpoint,
    });
  }
}

// ==================== Logger Utility ====================
export class NetworkingLogger {
  private static readonly LOG_LEVEL = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  private static currentLevel = NetworkingLogger.LOG_LEVEL.info;

  static setLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): void {
    this.currentLevel = this.LOG_LEVEL[level];
  }

  static log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    context?: Record<string, unknown>,
  ): void {
    if (this.LOG_LEVEL[level] < this.currentLevel) {
      return;
    }

    const timestamp = new Date().toISOString();
    const contextStr = context ? ` | ${JSON.stringify(context)}` : '';
    console.log(`[${level.toUpperCase()}] [Networking] ${timestamp} - ${message}${contextStr}`);
  }

  static debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  }

  static info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }

  static warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  }

  static error(message: string, context?: Record<string, unknown>): void {
    this.log('error', message, context);
  }
}
