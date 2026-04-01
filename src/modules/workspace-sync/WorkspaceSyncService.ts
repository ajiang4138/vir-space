import type {
    CanvasElement,
    PeerPresenceMetadata,
    SyncMessage,
    SyncMetrics,
    WorkspaceOperation,
    WorkspaceStateV2
} from '../../models/types';
import { CRDTStateManager } from './CRDTStateManager';
import { SyncEngine } from './SyncEngine';

// ==================== Sync Service Interface ====================
export interface WorkspaceSyncService {
  getState(roomId: string): Promise<WorkspaceStateV2 | null>;
  updateState(roomId: string, state: WorkspaceStateV2): Promise<void>;
  subscribe(roomId: string, onState: (state: WorkspaceStateV2) => void): () => void;
  // Canvas operations
  addCanvasElement(roomId: string, element: CanvasElement): Promise<WorkspaceOperation>;
  updateCanvasElement(roomId: string, elementId: string, updates: Partial<CanvasElement>): Promise<WorkspaceOperation | null>;
  deleteCanvasElement(roomId: string, elementId: string): Promise<WorkspaceOperation | null>;
  // Presence
  updatePeerPresence(roomId: string, presence: PeerPresenceMetadata): Promise<WorkspaceOperation>;
  // Synchronization
  receiveSyncMessage(message: SyncMessage): Promise<void>;
  createSyncMessage(roomId: string, type: SyncMessage['type']): Promise<SyncMessage>;
  createSnapshot(roomId: string): Promise<unknown>;
  restoreFromSnapshot(roomId: string, snapshot: unknown): Promise<void>;
  // Metrics
  getMetrics(roomId: string): Promise<SyncMetrics>;
  // Network integration
  onNetworkMessage(roomId: string, handler: (msg: SyncMessage) => void): () => void;
}

// ==================== Implementation ====================
export class DecentralizedWorkspaceSyncService implements WorkspaceSyncService {
  private roomStates = new Map<string, CRDTStateManager>();
  private syncEngines = new Map<string, SyncEngine>();
  private subscriptions = new Map<string, Set<(state: WorkspaceStateV2) => void>>();
  private networkHandlers = new Map<string, Set<(msg: SyncMessage) => void>>();
  private syncMessageSequence = new Map<string, number>(); // roomId -> sequence number
  private metrics = new Map<string, SyncMetrics>();
  private localPeerId: string;
  private startTime = Date.now();
  private syncCounters = new Map<string, number>(); // roomId -> sync count

  // Timing instrumentation
  private updateTimings = new Map<string, number[]>(); // roomId -> array of latencies
  private readonly TIMING_WINDOW_SIZE = 100;

  constructor(localPeerId?: string) {
    this.localPeerId = localPeerId || crypto.randomUUID();
  }

  /**
   * Get or create state manager for room
   */
  private getStateManager(roomId: string): CRDTStateManager {
    if (!this.roomStates.has(roomId)) {
      this.roomStates.set(roomId, new CRDTStateManager(roomId, this.localPeerId));
    }
    return this.roomStates.get(roomId)!;
  }

  /**
   * Get or create sync engine for room
   */
  private getSyncEngine(roomId: string): SyncEngine {
    if (!this.syncEngines.has(roomId)) {
      const engine = new SyncEngine(roomId, this.localPeerId);

      // Wire up event handlers
      engine.onOperation((op) => {
        this.handleOperation(roomId, op);
      });

      engine.onConvergence(() => {
        this.notifySubscribers(roomId);
      });

      engine.onError((error) => {
        console.error(`[SyncEngine] Room ${roomId}: ${error}`);
      });

      this.syncEngines.set(roomId, engine);
    }
    return this.syncEngines.get(roomId)!;
  }

  /**
   * Get current workspace state
   */
  async getState(roomId: string): Promise<WorkspaceStateV2 | null> {
    const manager = this.roomStates.get(roomId);
    if (!manager) return null;
    return manager.getState();
  }

  /**
   * Update entire workspace state
   */
  async updateState(roomId: string, state: WorkspaceStateV2): Promise<void> {
    void roomId;
    void state;
    // State is updated through canvas operations
    // This method is here for API completeness
  }

  /**
   * Subscribe to state changes
   */
  subscribe(roomId: string, onState: (state: WorkspaceStateV2) => void): () => void {
    if (!this.subscriptions.has(roomId)) {
      this.subscriptions.set(roomId, new Set());
    }

    const subscribers = this.subscriptions.get(roomId)!;
    subscribers.add(onState);

    return () => {
      subscribers.delete(onState);
      if (subscribers.size === 0) {
        this.subscriptions.delete(roomId);
      }
    };
  }

  /**
   * Add canvas element
   */
  async addCanvasElement(roomId: string, element: CanvasElement): Promise<WorkspaceOperation> {
    const startTime = performance.now();
    const manager = this.getStateManager(roomId);
    const operation = manager.addCanvasElement(element);

    // Track operation for sync
    const engine = this.getSyncEngine(roomId);
    const pending = engine.getPendingOperations();
    pending.push(operation);

    this.recordTiming(roomId, performance.now() - startTime);
    this.notifySubscribers(roomId);

    return operation;
  }

  /**
   * Update canvas element
   */
  async updateCanvasElement(
    roomId: string,
    elementId: string,
    updates: Partial<CanvasElement>,
  ): Promise<WorkspaceOperation | null> {
    const startTime = performance.now();
    const manager = this.getStateManager(roomId);
    const operation = manager.updateCanvasElement(elementId, updates);

    if (operation) {
      const engine = this.getSyncEngine(roomId);
      engine.getPendingOperations().push(operation);
      this.recordTiming(roomId, performance.now() - startTime);
      this.notifySubscribers(roomId);
    }

    return operation;
  }

  /**
   * Delete canvas element
   */
  async deleteCanvasElement(roomId: string, elementId: string): Promise<WorkspaceOperation | null> {
    const startTime = performance.now();
    const manager = this.getStateManager(roomId);
    const operation = manager.deleteCanvasElement(elementId);

    if (operation) {
      const engine = this.getSyncEngine(roomId);
      engine.getPendingOperations().push(operation);
      this.recordTiming(roomId, performance.now() - startTime);
      this.notifySubscribers(roomId);
    }

    return operation;
  }

  /**
   * Update peer presence
   */
  async updatePeerPresence(roomId: string, presence: PeerPresenceMetadata): Promise<WorkspaceOperation> {
    const startTime = performance.now();
    const manager = this.getStateManager(roomId);
    manager.addActivePeer(presence.peerId);
    const operation = manager.updatePeerPresence(presence);

    const engine = this.getSyncEngine(roomId);
    engine.getPendingOperations().push(operation);

    this.recordTiming(roomId, performance.now() - startTime);
    this.notifySubscribers(roomId);

    return operation;
  }

  /**
   * Receive sync message from peer
   */
  async receiveSyncMessage(message: SyncMessage): Promise<void> {
    const roomId = message.roomId;
    const engine = this.getSyncEngine(roomId);

    try {
      await engine.receiveMessage(message);

      // Notify network handlers
      this.notifyNetworkHandlers(roomId, message);
    } catch (error) {
      console.error(`[WorkspaceSyncService] Failed to receive message: ${error}`);
    }
  }

  /**
   * Create a sync message for sending to peers
   */
  async createSyncMessage(roomId: string, type: SyncMessage['type']): Promise<SyncMessage> {
    const engine = this.getSyncEngine(roomId);
    const manager = this.getStateManager(roomId);

    // Get sequence number
    const seq = (this.syncMessageSequence.get(roomId) ?? 0) + 1;
    this.syncMessageSequence.set(roomId, seq);

    const payload: SyncMessage['payload'] = {};

    switch (type) {
      case 'delta': {
        // Get pending operations
        const operations = engine.getPendingOperations();
        if (operations.length > 0) {
          payload.operations = operations;
          engine.acknowledgeOperations(operations.map(op => op.id));
        }
        payload.clock = manager.getClock();
        break;
      }

      case 'snapshot': {
        const snapshot = manager.createSnapshot();
        payload.state = snapshot.state;
        payload.clock = manager.getClock();
        break;
      }

      case 'sync': {
        payload.clock = manager.getClock();
        break;
      }

      case 'heartbeat': {
        payload.clock = manager.getClock();
        break;
      }

      case 'ack': {
        payload.checkpoint = engine.getPendingOperations().length;
        break;
      }
    }

    const message: SyncMessage = {
      id: crypto.randomUUID(),
      type,
      roomId,
      fromPeerId: this.localPeerId,
      payload,
      timestamp: new Date().toISOString(),
      sequenceNumber: seq,
    };

    // Track sync
    const count = (this.syncCounters.get(roomId) ?? 0) + 1;
    this.syncCounters.set(roomId, count);

    return message;
  }

  /**
   * Create state snapshot (for late joiners)
   */
  async createSnapshot(roomId: string): Promise<unknown> {
    const manager = this.getStateManager(roomId);
    return manager.createSnapshot();
  }

  /**
   * Restore from snapshot
   */
  async restoreFromSnapshot(roomId: string, snapshot: unknown): Promise<void> {
    const manager = this.getStateManager(roomId);
    manager.restoreFromSnapshot(snapshot as { state: WorkspaceStateV2; operationCount: number });
    this.notifySubscribers(roomId);
  }

  /**
   * Get synchronization metrics
   */
  async getMetrics(roomId: string): Promise<SyncMetrics> {
    const engine = this.getSyncEngine(roomId);
    const manager = this.getStateManager(roomId);
    const engineMetrics = engine.getMetrics();

    // Calculate average latency
    const timings = this.updateTimings.get(roomId) ?? [];
    const avgLatency = timings.length > 0
      ? timings.reduce((a, b) => a + b, 0) / timings.length
      : 0;

    // Calculate syncs per second
    const uptime = Date.now() - this.startTime;
    const syncsPerSecond = (this.syncCounters.get(roomId) ?? 0) / (uptime / 1000);

    const metrics: SyncMetrics = {
      roomId,
      peerId: this.localPeerId,
      updateLatencyMs: avgLatency,
      messageQueueSize: engineMetrics.messageBufferSize,
      pendingOperations: engineMetrics.pendingOperations,
      convergedPeers: engineMetrics.acknowledgedOperations,
      totalPeers: manager.getState().activePeers.length,
      syncsPerSecond,
      lastUpdate: new Date().toISOString(),
      uptime,
    };

    this.metrics.set(roomId, metrics);
    return metrics;
  }

  /**
   * Register network message handler
   */
  onNetworkMessage(roomId: string, handler: (msg: SyncMessage) => void): () => void {
    if (!this.networkHandlers.has(roomId)) {
      this.networkHandlers.set(roomId, new Set());
    }

    const handlers = this.networkHandlers.get(roomId)!;
    handlers.add(handler);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.networkHandlers.delete(roomId);
      }
    };
  }

  /**
   * Handle operation application
   */
  private handleOperation(roomId: string, operation: WorkspaceOperation): void {
    void operation;
    // Operations are already applied in state manager
    // Just notify subscribers
    this.notifySubscribers(roomId);
  }

  /**
   * Notify subscribers of state changes
   */
  private notifySubscribers(roomId: string): void {
    const subscribers = this.subscriptions.get(roomId);
    if (!subscribers) return;

    const manager = this.roomStates.get(roomId);
    if (!manager) return;

    const state = manager.getState();

    for (const subscriber of subscribers) {
      try {
        subscriber(state);
      } catch (error) {
        console.error(`[WorkspaceSyncService] Subscriber error: ${error}`);
      }
    }
  }

  /**
   * Notify network handlers
   */
  private notifyNetworkHandlers(roomId: string, message: SyncMessage): void {
    const handlers = this.networkHandlers.get(roomId);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        handler(message);
      } catch (error) {
        console.error(`[WorkspaceSyncService] Network handler error: ${error}`);
      }
    }
  }

  /**
   * Record timing for instrumentation
   */
  private recordTiming(roomId: string, latency: number): void {
    if (!this.updateTimings.has(roomId)) {
      this.updateTimings.set(roomId, []);
    }

    const timings = this.updateTimings.get(roomId)!;
    timings.push(latency);

    // Keep only recent timings
    if (timings.length > this.TIMING_WINDOW_SIZE) {
      timings.shift();
    }
  }

  /**
   * Signal peer connection/disconnection
   */
  setPeerConnected(roomId: string, peerId: string, connected: boolean): void {
    const manager = this.getStateManager(roomId);
    if (connected) {
      manager.addActivePeer(peerId);
    } else {
      manager.removeActivePeer(peerId);
    }

    const engine = this.getSyncEngine(roomId);
    engine.setConnected(connected);

    this.notifySubscribers(roomId);
  }

  /**
   * Clear room state (e.g., when leaving room)
   */
  clearRoom(roomId: string): void {
    this.roomStates.delete(roomId);
    this.syncEngines.delete(roomId);
    this.subscriptions.delete(roomId);
    this.networkHandlers.delete(roomId);
    this.syncMessageSequence.delete(roomId);
    this.metrics.delete(roomId);
    this.updateTimings.delete(roomId);
    this.syncCounters.delete(roomId);
  }
}

// ==================== Placeholder for backward compatibility ====================
export class PlaceholderWorkspaceSyncService implements WorkspaceSyncService {
  async getState(roomId: string): Promise<WorkspaceStateV2 | null> {
    void roomId;
    return null;
  }

  async updateState(roomId: string, state: WorkspaceStateV2): Promise<void> {
    void roomId;
    void state;
    return;
  }

  subscribe(roomId: string, onState: (state: WorkspaceStateV2) => void): () => void {
    void roomId;
    void onState;
    return () => undefined;
  }

  async addCanvasElement(
    roomId: string,
    element: CanvasElement,
  ): Promise<WorkspaceOperation> {
    void roomId;
    void element;
    throw new Error('Not implemented');
  }

  async updateCanvasElement(
    roomId: string,
    elementId: string,
    updates: Partial<CanvasElement>,
  ): Promise<WorkspaceOperation | null> {
    void roomId;
    void elementId;
    void updates;
    throw new Error('Not implemented');
  }

  async deleteCanvasElement(roomId: string, elementId: string): Promise<WorkspaceOperation | null> {
    void roomId;
    void elementId;
    throw new Error('Not implemented');
  }

  async updatePeerPresence(roomId: string, presence: PeerPresenceMetadata): Promise<WorkspaceOperation> {
    void roomId;
    void presence;
    throw new Error('Not implemented');
  }

  async receiveSyncMessage(message: SyncMessage): Promise<void> {
    void message;
    return;
  }

  async createSyncMessage(roomId: string, type: SyncMessage['type']): Promise<SyncMessage> {
    void roomId;
    void type;
    throw new Error('Not implemented');
  }

  async createSnapshot(roomId: string): Promise<unknown> {
    void roomId;
    return null;
  }

  async restoreFromSnapshot(roomId: string, snapshot: unknown): Promise<void> {
    void roomId;
    void snapshot;
    return;
  }

  async getMetrics(roomId: string): Promise<SyncMetrics> {
    void roomId;
    throw new Error('Not implemented');
  }

  onNetworkMessage(roomId: string, handler: (msg: SyncMessage) => void): () => void {
    void roomId;
    void handler;
    return () => undefined;
  }
}
