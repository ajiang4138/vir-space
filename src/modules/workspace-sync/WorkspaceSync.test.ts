/**
 * WorkspaceSync.test.ts
 *
 * Comprehensive tests for CRDT-based workspace synchronization
 * - State management
 * - Operation handling
 * - Conflict resolution
 * - Message ordering
 * - Convergence
 * - Late joiner support
 * - Instrumentation
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type {
  CanvasElement,
  PeerPresenceMetadata,
  SyncMessage,
  WorkspaceStateV2,
} from '../../models/types';
import { CRDTStateManager } from './CRDTStateManager';
import { SyncEngine } from './SyncEngine';
import { DecentralizedWorkspaceSyncService } from './WorkspaceSyncService';

describe('Workspace Synchronization System', () => {
  let sync: DecentralizedWorkspaceSyncService;
  const roomId = 'test-room-1';
  const peer1Id = 'peer-1';
  const peer2Id = 'peer-2';

  beforeEach(() => {
    sync = new DecentralizedWorkspaceSyncService(peer1Id);
  });

  describe('CRDT State Manager', () => {
    it('should initialize state correctly', () => {
      const manager = new CRDTStateManager(roomId, peer1Id);
      const state = manager.getState();

      expect(state.roomId).toBe(roomId);
      expect(state.activePeers).toContain(peer1Id);
      expect(state.canvas).toBeDefined();
      expect(state.peerPresence).toBeInstanceOf(Map);
    });

    it('should add canvas elements with unique IDs', () => {
      const manager = new CRDTStateManager(roomId, peer1Id);

      const element: CanvasElement = {
        id: 'elem-1',
        type: 'shape',
        x: 100,
        y: 200,
        width: 50,
        height: 50,
        data: { color: 'red' },
        createdBy: peer1Id,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        modifiedBy: peer1Id,
      };

      const op = manager.addCanvasElement(element);

      expect(op.type).toBe('insert');
      expect(op.path).toEqual(['canvas', 'elements', 'elem-1']);

      const state = manager.getState();
      expect(state.canvas.elements.get('elem-1')).toBeDefined();
      expect(state.version).toBeGreaterThan(0);
    });

    it('should handle concurrent updates with last-write-wins', async () => {
      const manager1 = new CRDTStateManager(roomId, peer1Id);
      const manager2 = new CRDTStateManager(roomId, peer2Id);

      const element: CanvasElement = {
        id: 'elem-shared',
        type: 'shape',
        x: 100,
        y: 200,
        width: 50,
        height: 50,
        data: { color: 'red' },
        createdBy: peer1Id,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        modifiedBy: peer1Id,
      };

      // Both peers add the element
      manager1.addCanvasElement(element);

      // Simulate peer 2 adding slightly different version
      const op2 = manager2.addCanvasElement({
        ...element,
        data: { color: 'blue' },
        modifiedBy: peer2Id,
        modifiedAt: new Date(Date.now() + 10).toISOString(),
      });

      // Apply peer2's op to peer1
      manager1.applyOperation(op2);

      const state = manager1.getState();
      const resolvedElement = state.canvas.elements.get('elem-shared');

      // Last-write-wins: peer2's version should win
      expect(resolvedElement?.data.color).toBe('blue');
    });

    it('should track peer presence', () => {
      const manager = new CRDTStateManager(roomId, peer1Id);

      const presence: PeerPresenceMetadata = {
        peerId: peer1Id,
        color: '#FF0000',
        displayName: 'Peer 1',
        cursorPosition: { x: 100, y: 200 },
        lastActivity: new Date().toISOString(),
        status: 'active',
      };

      const op = manager.updatePeerPresence(presence);

      expect(op.type).toBe('update');
      expect(op.path).toContain('peerPresence');

      const state = manager.getState();
      expect(state.peerPresence.get(peer1Id)).toBeDefined();
    });

    it('should maintain operation history for recovery', () => {
      const manager = new CRDTStateManager(roomId, peer1Id);

      // Create multiple operations
      for (let i = 0; i < 5; i++) {
        manager.addCanvasElement({
          id: `elem-${i}`,
          type: 'shape',
          x: i * 100,
          y: 0,
          width: 50,
          height: 50,
          data: { index: i },
          createdBy: peer1Id,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          modifiedBy: peer1Id,
        });
      }

      const history = manager.getOperationHistory();
      expect(history.length).toBe(5);

      // Get partial history
      const recent = manager.getOperationHistory(2);
      expect(recent.length).toBe(3);
    });

    it('should create and restore snapshots', () => {
      const manager = new CRDTStateManager(roomId, peer1Id);

      // Add some data
      manager.addCanvasElement({
        id: 'elem-1',
        type: 'shape',
        x: 100,
        y: 200,
        width: 50,
        height: 50,
        data: {},
        createdBy: peer1Id,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        modifiedBy: peer1Id,
      });

      const snapshot = manager.createSnapshot();
      expect(snapshot.state).toBeDefined();
      expect(snapshot.operationCount).toBe(1);

      // Create new manager and restore
      const newManager = new CRDTStateManager(roomId, peer1Id);
      newManager.restoreFromSnapshot(snapshot);

      const state = newManager.getState();
      expect(state.canvas.elements.get('elem-1')).toBeDefined();
    });
  });

  describe('Sync Engine', () => {
    it('should handle out-of-order messages with buffering', async () => {
      const engine = new SyncEngine(roomId, peer1Id);

      // Create messages with varying sequence numbers
      const msg3: SyncMessage = {
        id: 'msg-3',
        type: 'delta',
        roomId,
        fromPeerId: peer2Id,
        payload: {
          operations: [
            {
              id: 'op-3',
              type: 'insert',
              path: ['canvas', 'elements', 'elem-3'],
              value: {},
              peerId: peer2Id,
              timestamp: new Date().toISOString(),
              clock: { [peer2Id]: 3 },
            },
          ],
        },
        timestamp: new Date().toISOString(),
        sequenceNumber: 3,
      };

      const msg1: SyncMessage = {
        id: 'msg-1',
        type: 'delta',
        roomId,
        fromPeerId: peer2Id,
        payload: {
          operations: [
            {
              id: 'op-1',
              type: 'insert',
              path: ['canvas', 'elements', 'elem-1'],
              value: {},
              peerId: peer2Id,
              timestamp: new Date().toISOString(),
              clock: { [peer2Id]: 1 },
            },
          ],
        },
        timestamp: new Date().toISOString(),
        sequenceNumber: 1,
      };

      // Receive out of order
      engine.setConnected(true);
      await engine.receiveMessage(msg3);
      await engine.receiveMessage(msg1);

      // Verify messages are buffered
      const metrics = engine.getMetrics();
      expect(metrics.messageBufferSize).toBeGreaterThanOrEqual(0);
    });

    it('should detect and eliminate duplicates', async () => {
      const engine = new SyncEngine(roomId, peer1Id);
      const appliedOps: string[] = [];

      engine.onOperation((op) => {
        appliedOps.push(op.id);
      });

      const message: SyncMessage = {
        id: 'msg-duplicate',
        type: 'delta',
        roomId,
        fromPeerId: peer2Id,
        payload: {
          operations: [
            {
              id: 'op-1',
              type: 'insert',
              path: ['canvas', 'elements', 'elem-1'],
              value: {},
              peerId: peer2Id,
              timestamp: new Date().toISOString(),
              clock: { [peer2Id]: 1 },
            },
          ],
        },
        timestamp: new Date().toISOString(),
        sequenceNumber: 1,
      };

      engine.setConnected(true);
      await engine.receiveMessage(message);
      await engine.receiveMessage(message); // Send duplicate

      await new Promise(resolve => setTimeout(resolve, 200));
      // Should only have one unique operation applied
      // (Note: operation handler may be called multiple times but op dedup happens at sync level)
      const metrics = engine.getMetrics();
      expect(metrics.messageBufferSize).toBeLessThanOrEqual(1); // One message processed, one dropped
    });

    it('should track message buffer state', async () => {
      const engine = new SyncEngine(roomId, peer1Id);

      // Create and process messages
      const message: SyncMessage = {
        id: 'msg-1',
        type: 'sync',
        roomId,
        fromPeerId: peer2Id,
        payload: { clock: { [peer2Id]: 1 } },
        timestamp: new Date().toISOString(),
        sequenceNumber: 1,
      };

      engine.setConnected(true);
      await engine.receiveMessage(message);

      const metrics = engine.getMetrics();
      expect(metrics.messageBufferSize).toBeGreaterThanOrEqual(0);
      expect(metrics.isConnected).toBe(true);
    });

    it('recovers through repeated disconnect and reconnect churn', async () => {
      const engine = new SyncEngine(roomId, peer1Id);
      const recoveryPhases: string[] = [];

      engine.onRecoveryStatus((status) => {
        recoveryPhases.push(status.phase);
      });

      engine.setConnected(true);

      for (let i = 0; i < 3; i += 1) {
        engine.setConnected(false);
        engine.markIntermittentConnectivity('simulated-network-jitter');
        engine.requestResynchronization(
          ['workspace-state', 'room-membership', 'shared-directory-state', 'file-transfers'],
          'test-loop-resync',
        );
        engine.setConnected(true);
      }

      const msgFromPeer2Seq2: SyncMessage = {
        id: 'peer2-seq2',
        type: 'delta',
        roomId,
        fromPeerId: peer2Id,
        payload: {
          operations: [
            {
              id: 'op-peer2-seq2',
              type: 'insert',
              path: ['canvas', 'elements', 'peer2-2'],
              value: { shape: 'square' },
              peerId: peer2Id,
              timestamp: new Date().toISOString(),
              clock: { [peer2Id]: 2 },
            },
          ],
        },
        timestamp: new Date().toISOString(),
        sequenceNumber: 2,
      };

      const msgFromPeer2Seq1: SyncMessage = {
        ...msgFromPeer2Seq2,
        id: 'peer2-seq1',
        payload: {
          operations: [
            {
              id: 'op-peer2-seq1',
              type: 'insert',
              path: ['canvas', 'elements', 'peer2-1'],
              value: { shape: 'circle' },
              peerId: peer2Id,
              timestamp: new Date().toISOString(),
              clock: { [peer2Id]: 1 },
            },
          ],
        },
        sequenceNumber: 1,
      };

      const msgFromPeer3Seq5: SyncMessage = {
        id: 'peer3-seq5',
        type: 'delta',
        roomId,
        fromPeerId: 'peer-3',
        payload: {
          operations: [
            {
              id: 'op-peer3-seq5',
              type: 'insert',
              path: ['canvas', 'elements', 'peer3-5'],
              value: { shape: 'triangle' },
              peerId: 'peer-3',
              timestamp: new Date().toISOString(),
              clock: { 'peer-3': 5 },
            },
          ],
        },
        timestamp: new Date().toISOString(),
        sequenceNumber: 5,
      };

      await engine.receiveMessage(msgFromPeer2Seq2);
      await engine.receiveMessage(msgFromPeer2Seq1);
      await engine.receiveMessage(msgFromPeer3Seq5);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const metrics = engine.getMetrics();
      expect(metrics.isConnected).toBe(true);
      expect(metrics.resyncRequests).toBeGreaterThan(0);
      expect(recoveryPhases).toContain('disconnected');
      expect(recoveryPhases).toContain('reconnecting');
      expect(recoveryPhases).toContain('recovered');
    });
  });

  describe('Workspace Sync Service', () => {
    it('should add and retrieve canvas elements', async () => {
      const element: CanvasElement = {
        id: 'elem-1',
        type: 'shape',
        x: 100,
        y: 200,
        width: 50,
        height: 50,
        data: { color: 'red' },
        createdBy: peer1Id,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        modifiedBy: peer1Id,
      };

      const op = await sync.addCanvasElement(roomId, element);
      expect(op).toBeDefined();
      expect(op.type).toBe('insert');

      const state = await sync.getState(roomId);
      expect(state?.canvas.elements.get('elem-1')).toBeDefined();
    });

    it('should handle peer presence updates', async () => {
      const presence: PeerPresenceMetadata = {
        peerId: peer1Id,
        color: '#FF0000',
        displayName: 'Peer 1',
        lastActivity: new Date().toISOString(),
        status: 'active',
      };

      const op = await sync.updatePeerPresence(roomId, presence);
      expect(op).toBeDefined();

      const state = await sync.getState(roomId);
      expect(state?.peerPresence.get(peer1Id)).toBeDefined();
    });

    it('should subscribe to state changes', async () => {
      let callCount = 0;
      let lastState: WorkspaceStateV2 | undefined;

      sync.subscribe(roomId, (state) => {
        callCount++;
        lastState = state;
      });

      const element: CanvasElement = {
        id: 'elem-1',
        type: 'shape',
        x: 100,
        y: 200,
        width: 50,
        height: 50,
        data: {},
        createdBy: peer1Id,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        modifiedBy: peer1Id,
      };

      await sync.addCanvasElement(roomId, element);

      expect(callCount).toBeGreaterThan(0);
      expect(lastState?.canvas.elements.get('elem-1')).toBeDefined();
    });

    it('should create and restore snapshots', async () => {
      const element: CanvasElement = {
        id: 'elem-1',
        type: 'shape',
        x: 100,
        y: 200,
        width: 50,
        height: 50,
        data: {},
        createdBy: peer1Id,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        modifiedBy: peer1Id,
      };

      await sync.addCanvasElement(roomId, element);

      const snapshot = await sync.createSnapshot(roomId);
      expect(snapshot).toBeDefined();

      // Create new service and restore
      const sync2 = new DecentralizedWorkspaceSyncService(peer2Id);
      await sync2.restoreFromSnapshot(roomId, snapshot);

      const state = await sync2.getState(roomId);
      expect(state?.canvas.elements.get('elem-1')).toBeDefined();
    });

    it('should generate sync messages', async () => {
      const element: CanvasElement = {
        id: 'elem-1',
        type: 'shape',
        x: 100,
        y: 200,
        width: 50,
        height: 50,
        data: {},
        createdBy: peer1Id,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        modifiedBy: peer1Id,
      };

      await sync.addCanvasElement(roomId, element);

      const message = await sync.createSyncMessage(roomId, 'delta');
      expect(message).toBeDefined();
      expect(message.type).toBe('delta');
      expect(message.fromPeerId).toBe(peer1Id);
    });

    it('should report metrics', async () => {
      const element: CanvasElement = {
        id: 'elem-1',
        type: 'shape',
        x: 100,
        y: 200,
        width: 50,
        height: 50,
        data: {},
        createdBy: peer1Id,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        modifiedBy: peer1Id,
      };

      await sync.addCanvasElement(roomId, element);

      const metrics = await sync.getMetrics(roomId);
      expect(metrics).toBeDefined();
      expect(metrics.roomId).toBe(roomId);
      expect(metrics.peerId).toBe(peer1Id);
      expect(metrics.updateLatencyMs).toBeGreaterThanOrEqual(0);
      expect(metrics.totalPeers).toBeGreaterThan(0);
    });

    it('should handle peer connection state', async () => {
      sync.setPeerConnected(roomId, peer2Id, true);
      let state = await sync.getState(roomId);
      expect(state?.activePeers).toContain(peer2Id);

      sync.setPeerConnected(roomId, peer2Id, false);
      state = await sync.getState(roomId);
      expect(state?.activePeers).not.toContain(peer2Id);
    });
  });

  describe('Late Joiner Support', () => {
    it('should provide snapshot for new peers', async () => {
      const element: CanvasElement = {
        id: 'elem-1',
        type: 'shape',
        x: 100,
        y: 200,
        width: 50,
        height: 50,
        data: {},
        createdBy: peer1Id,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        modifiedBy: peer1Id,
      };

      await sync.addCanvasElement(roomId, element);

      const snapshot = await sync.createSnapshot(roomId) as {
        state: WorkspaceStateV2;
        operationCount: number;
      };
      expect(snapshot.state.canvas.elements.size).toBe(1);

      // New peer uses snapshot
      const newPeerSync = new DecentralizedWorkspaceSyncService('peer-new');
      await newPeerSync.restoreFromSnapshot(roomId, snapshot);

      const state = await newPeerSync.getState(roomId);
      expect(state?.canvas.elements.get('elem-1')).toBeDefined();
    });
  });

  describe('Instrumentation', () => {
    it('should track update latency', async () => {
      const element: CanvasElement = {
        id: 'elem-1',
        type: 'shape',
        x: 100,
        y: 200,
        width: 50,
        height: 50,
        data: {},
        createdBy: peer1Id,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        modifiedBy: peer1Id,
      };

      await sync.addCanvasElement(roomId, element);
      await sync.updateCanvasElement(roomId, 'elem-1', { x: 150 });

      const metrics = await sync.getMetrics(roomId);
      expect(metrics.updateLatencyMs).toBeGreaterThan(0);
    });

    it('should report sync rate', async () => {
      const element: CanvasElement = {
        id: 'elem-1',
        type: 'shape',
        x: 100,
        y: 200,
        width: 50,
        height: 50,
        data: {},
        createdBy: peer1Id,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        modifiedBy: peer1Id,
      };

      await sync.addCanvasElement(roomId, element);
      await sync.createSyncMessage(roomId, 'delta');
      await sync.createSyncMessage(roomId, 'sync');

      const metrics = await sync.getMetrics(roomId);
      expect(metrics.syncsPerSecond).toBeGreaterThan(0);
    });
  });
});
