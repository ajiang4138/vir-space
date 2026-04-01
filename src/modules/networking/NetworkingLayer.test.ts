/**
 * NetworkingLayer.test.ts
 *
 * Tests for the P2P Networking Layer
 *
 * Run with: npm test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from './ConnectionManager';
import {
    LibP2PNetworkingLayer,
    NetworkingLogger,
    WebSocketNetworkingLayer,
    type SignalingMessage,
} from './NetworkingLayer';
import { ConnectionQualityTracker, NetworkingDiagnosticsUtil } from './NetworkingUtils';

describe('LibP2PNetworkingLayer', () => {
  let networkingLayer: LibP2PNetworkingLayer;

  beforeEach(() => {
    networkingLayer = new LibP2PNetworkingLayer();
    NetworkingLogger.setLogLevel('warn'); // Reduce log noise during tests
  });

  afterEach(async () => {
    if (networkingLayer) {
      try {
        await networkingLayer.stop();
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('Initialization', () => {
    it('should initialize and start the P2P network', async () => {
      await networkingLayer.start();

      expect(networkingLayer.getLocalPeerId()).toBeTruthy();
      expect(networkingLayer.getLocalPeerId().length).toBeGreaterThan(0);
    });

    it('should have correct interface methods', () => {
      expect(typeof networkingLayer.start).toBe('function');
      expect(typeof networkingLayer.stop).toBe('function');
      expect(typeof networkingLayer.sendMessage).toBe('function');
      expect(typeof networkingLayer.getLocalPeerId).toBe('function');
      expect(typeof networkingLayer.getConnectedPeers).toBe('function');
      expect(typeof networkingLayer.getNetworkingStats).toBe('function');
    });
  });

  describe('Messaging', () => {
    beforeEach(async () => {
      await networkingLayer.start();
    });

    it('should emit message-sent event on send', async () => {
      const listener = vi.fn();
      networkingLayer.on('message-sent', listener);

      const message: SignalingMessage = {
        type: 'test',
        payload: { data: 'test' },
      };

      await networkingLayer.sendMessage(message);

      expect(listener).toHaveBeenCalled();
    });

    it('should send direct message successfully', async () => {
      const listener = vi.fn();
      networkingLayer.on('message-sent', listener);

      await networkingLayer.sendDirectMessage('test-room', 'test-peer', { test: 'data' });

      expect(listener).toHaveBeenCalled();
    });

    it('should emit encrypted envelope for outbound direct payloads', async () => {
      const listener = vi.fn();
      networkingLayer.on('message-sent', listener);

      await networkingLayer.sendDirectMessage('secure-room', 'test-peer', {
        type: 'workspace-update',
        token: 'sensitive-token',
      });

      expect(listener).toHaveBeenCalled();
      const event = listener.mock.calls[0][0];
      expect(event.details.encrypted).toBe(true);
    });
  });

  describe('Connected Peers', () => {
    beforeEach(async () => {
      await networkingLayer.start();
    });

    it('should return connected peers list', () => {
      const peers = networkingLayer.getConnectedPeers();
      expect(Array.isArray(peers)).toBe(true);
    });

    it('should return network statistics', () => {
      const stats = networkingLayer.getNetworkingStats();

      expect(stats).toHaveProperty('connectedPeers');
      expect(stats).toHaveProperty('totalBytesReceived');
      expect(stats).toHaveProperty('totalBytesSent');
      expect(stats).toHaveProperty('reconnectionAttempts');

      expect(typeof stats.connectedPeers).toBe('number');
      expect(typeof stats.totalBytesReceived).toBe('number');
    });
  });

  describe('Room Connections', () => {
    beforeEach(async () => {
      await networkingLayer.start();
    });

    it('should add peer connection to room', () => {
      networkingLayer.addRoomPeerConnection('room-1', 'peer-1', 'tcp');
      const connections = networkingLayer.getRoomConnections('room-1');

      expect(connections.length).toBe(1);
      expect(connections[0].peerId).toBe('peer-1');
    });

    it('should remove peer connection from room', () => {
      networkingLayer.addRoomPeerConnection('room-1', 'peer-1', 'tcp');
      networkingLayer.removeRoomPeerConnection('room-1', 'peer-1');
      const connections = networkingLayer.getRoomConnections('room-1');

      expect(connections.length).toBe(0);
    });

    it('should handle multiple connections per room', () => {
      networkingLayer.addRoomPeerConnection('room-1', 'peer-1', 'tcp');
      networkingLayer.addRoomPeerConnection('room-1', 'peer-2', 'tcp');
      networkingLayer.addRoomPeerConnection('room-1', 'peer-3', 'tcp');

      const connections = networkingLayer.getRoomConnections('room-1');
      expect(connections.length).toBe(3);
    });
  });
});

describe('WebSocketNetworkingLayer', () => {
  let wsLayer: WebSocketNetworkingLayer;

  beforeEach(() => {
    wsLayer = new WebSocketNetworkingLayer();
  });

  it('should have required interface methods', () => {
    expect(typeof wsLayer.connect).toBe('function');
    expect(typeof wsLayer.disconnect).toBe('function');
    expect(typeof wsLayer.send).toBe('function');
    expect(typeof wsLayer.getLocalPeerId).toBe('function');
  });

  it('should return stats', () => {
    const stats = wsLayer.getNetworkingStats();

    expect(stats).toHaveProperty('connectedPeers');
    expect(stats).toHaveProperty('totalBytesReceived');
    expect(stats).toHaveProperty('totalBytesSent');
  });

  it('should reject insecure non-local websocket endpoints', () => {
    const assertEndpoint = (
      wsLayer as unknown as { assertSecureWebSocketEndpoint: (url: string) => void }
    ).assertSecureWebSocketEndpoint.bind(wsLayer);
    expect(() => assertEndpoint('ws://example.com/socket')).toThrow(/Insecure WebSocket endpoint blocked/);
  });

  it('should allow secure websocket endpoints', () => {
    const assertEndpoint = (
      wsLayer as unknown as { assertSecureWebSocketEndpoint: (url: string) => void }
    ).assertSecureWebSocketEndpoint.bind(wsLayer);
    expect(() => assertEndpoint('wss://example.com/socket')).not.toThrow();
  });
});

describe('ConnectionManager', () => {
  let connectionManager: ConnectionManager;

  beforeEach(() => {
    connectionManager = new ConnectionManager();
  });

  afterEach(() => {
    connectionManager.cleanup();
  });

  describe('Connection Lifecycle', () => {
    it('should open a connection', async () => {
      const connInfo = await connectionManager.openConnection('room-1', 'peer-1', 'tcp');

      expect(connInfo.roomId).toBe('room-1');
      expect(connInfo.peerId).toBe('peer-1');
      expect(connInfo.protocol).toBe('tcp');
      expect(connInfo.established).toBe(true);
    });

    it('should close a connection', async () => {
      const connInfo = await connectionManager.openConnection('room-1', 'peer-1', 'tcp');
      await connectionManager.closeConnection(connInfo.connectionId);

      const retrieved = connectionManager.getConnection(connInfo.connectionId);
      expect(retrieved).toBeNull();
    });

    it('should handle room connections', async () => {
      await connectionManager.openConnection('room-1', 'peer-1');
      await connectionManager.openConnection('room-1', 'peer-2');

      const connections = connectionManager.getRoomConnections('room-1');
      expect(connections.length).toBe(2);
    });
  });

  describe('Data Tracking', () => {
    it('should record data sent', async () => {
      const connInfo = await connectionManager.openConnection('room-1', 'peer-1');
      connectionManager.recordDataSent(connInfo.connectionId, 100);

      const conn = connectionManager.getConnection(connInfo.connectionId);
      expect(conn?.bytesSent).toBe(100);
    });

    it('should record data received', async () => {
      const connInfo = await connectionManager.openConnection('room-1', 'peer-1');
      connectionManager.recordDataReceived(connInfo.connectionId, 200);

      const conn = connectionManager.getConnection(connInfo.connectionId);
      expect(conn?.bytesReceived).toBe(200);
    });
  });

  describe('Statistics', () => {
    it('should return connection pool stats', async () => {
      await connectionManager.openConnection('room-1', 'peer-1');
      await connectionManager.openConnection('room-1', 'peer-2');

      const stats = connectionManager.getStats();

      expect(stats.totalConnections).toBe(2);
      expect(stats.activeConnections).toBe(2);
      expect(typeof stats.availableConnectionSlots).toBe('number');
    });
  });
});

describe('ConnectionQualityTracker', () => {
  let tracker: ConnectionQualityTracker;

  beforeEach(() => {
    tracker = new ConnectionQualityTracker();
  });

  describe('Latency Tracking', () => {
    it('should record latency samples', () => {
      tracker.recordLatency('peer-1', 45, true);
      tracker.recordLatency('peer-1', 50, true);
      tracker.recordLatency('peer-1', 48, true);

      const avgLatency = tracker.getAverageLatency('peer-1');
      expect(avgLatency).toBeCloseTo(47.67, 1);
    });

    it('should calculate correct average latency', () => {
      tracker.recordLatency('peer-1', 100, true);
      tracker.recordLatency('peer-1', 200, true);

      expect(tracker.getAverageLatency('peer-1')).toBe(150);
    });
  });

  describe('Quality Metrics', () => {
    it('should determine connection quality', () => {
      tracker.recordLatency('peer-1', 30, true);
      tracker.recordPacketLoss('peer-1', 0);

      const metrics = tracker.getQualityMetrics('peer-1');
      expect(metrics.quality).toBe('excellent');
    });

    it('should reflect poor quality with high latency', () => {
      tracker.recordLatency('peer-1', 600, true);
      tracker.recordPacketLoss('peer-1', 0);

      const metrics = tracker.getQualityMetrics('peer-1');
      expect(metrics.quality).toBe('poor');
    });

    it('should reflect poor quality with packet loss', () => {
      tracker.recordLatency('peer-1', 50, true);
      tracker.recordPacketLoss('peer-1', 15);

      const metrics = tracker.getQualityMetrics('peer-1');
      expect(metrics.quality).toBe('poor');
    });
  });

  describe('Data Recording', () => {
    it('should record bandwidth', () => {
      tracker.recordBandwidth('peer-1', 1024000);
      tracker.recordBandwidth('peer-1', 2048000);

      const avgBandwidth = tracker.getAverageBandwidth('peer-1');
      expect(avgBandwidth).toBe(1536000);
    });

    it('should record jitter', () => {
      tracker.recordJitter('peer-1', 5);
      tracker.recordJitter('peer-1', 10);

      const avgJitter = tracker.getAverageJitter('peer-1');
      expect(avgJitter).toBe(7.5);
    });
  });
});

describe('NetworkingLogger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should log at different levels', () => {
    NetworkingLogger.setLogLevel('debug');

    NetworkingLogger.debug('Debug message');
    NetworkingLogger.info('Info message');
    NetworkingLogger.warn('Warn message');
    NetworkingLogger.error('Error message');

    expect(console.log).toHaveBeenCalledTimes(4);
  });

  it('should respect log level filter', () => {
    NetworkingLogger.setLogLevel('error');

    NetworkingLogger.debug('Debug');
    NetworkingLogger.info('Info');
    NetworkingLogger.warn('Warn');
    NetworkingLogger.error('Error');

    // Only error should be logged when level is 'error'
    expect(console.log).toHaveBeenCalledTimes(1);
  });

  it('should include context in logs', () => {
    NetworkingLogger.setLogLevel('info');

    const context = { roomId: 'test-room', peerId: 'test-peer' };
    NetworkingLogger.info('Test message', context);

    expect(console.log).toHaveBeenCalled();
    const calls = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const call = calls[0]?.[0] as string;
    expect(call).toContain('roomId');
  });
});

describe('NetworkingDiagnosticsUtil', () => {
  it('should generate diagnostics report', () => {
    const peerConnections = new Map();
    const roomConnections = new Map();
    const tracker = new ConnectionQualityTracker();

    const diagnostics = NetworkingDiagnosticsUtil.generateDiagnostics(
      'local-peer',
      peerConnections,
      roomConnections,
      tracker,
    );

    expect(diagnostics).toHaveProperty('timestamp');
    expect(diagnostics).toHaveProperty('localPeerId');
    expect(diagnostics).toHaveProperty('overallHealth');
    expect(Array.isArray(diagnostics.recommendations)).toBe(true);
  });

  it('should format diagnostics for logging', () => {
    const diagnostics = {
      timestamp: '2026-04-01T12:00:00Z',
      localPeerId: 'local-peer',
      connections: [],
      roomsStatus: [],
      overallHealth: 'excellent' as const,
      recommendations: ['✅ Network is healthy'],
    };

    const formatted = NetworkingDiagnosticsUtil.formatDiagnosticsForLog(diagnostics);

    expect(typeof formatted).toBe('string');
    expect(formatted).toContain('Diagnostics');
    expect(formatted).toContain('local-peer');
    expect(formatted).toContain('excellent');
  });
});
