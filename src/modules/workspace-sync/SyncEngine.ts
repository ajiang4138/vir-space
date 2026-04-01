/**
 * SyncEngine.ts
 *
 * Manages peer-to-peer synchronization with:
 * - Out-of-order message handling
 * - Duplicate detection and elimination
 * - Temporary disconnect recovery
 * - Operation deduplication
 * - Batch message processing
 * - Convergence detection
 */

import type {
    SyncMessage,
    SyncState,
    WorkspaceOperation
} from '../../models/types';

export type RecoveryScope = 'workspace-state' | 'room-membership' | 'shared-directory-state' | 'file-transfers';

export type RecoveryPhase =
  | 'stable'
  | 'intermittent'
  | 'disconnected'
  | 'reconnecting'
  | 'resync-requested'
  | 'resyncing'
  | 'recovered';

export interface RecoveryStatus {
  phase: RecoveryPhase;
  roomId: string;
  peerId: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

// ==================== Sync Engine ====================
export class SyncEngine {
  private peerId: string;
  private state: SyncState;
  private messageBuffer: Map<string, SyncMessage> = new Map(); // peerId:sequence -> message
  private peerMessageBuffer = new Map<string, Map<number, SyncMessage>>();
  private expectedSequenceByPeer = new Map<string, number>();
  private pendingResyncScopes = new Set<RecoveryScope>();
  private seenMessageIds = new Set<string>(); // For duplicate detection
  private operationDeduplication = new Map<string, WorkspaceOperation>(); // opId -> operation
  private readonly MAX_BUFFER_SIZE = 10000;
  private lastBatchProcessTime = Date.now();
  private readonly BATCH_INTERVAL_MS = 100;
  private readonly OUT_OF_ORDER_GRACE_MS = 1500;
  private connectivityPhase: RecoveryPhase = 'stable';
  private disconnectedAtMs: number | null = null;
  private resyncRequests = 0;

  // Event handlers
  private onOperationHandlers: ((op: WorkspaceOperation) => void)[] = [];
  private onConvergenceHandlers: (() => void)[] = [];
  private onErrorHandlers: ((error: string) => void)[] = [];
  private onRecoveryHandlers: ((status: RecoveryStatus) => void)[] = [];

  constructor(roomId: string, peerId: string) {
    this.peerId = peerId;

    this.state = {
      roomId,
      peerId,
      localClock: { [peerId]: 0 },
      lastReceivedClock: {},
      pendingOperations: [],
      acknowledgedOperations: new Set(),
      messageQueue: [],
      isConnected: false,
      lastSyncTime: new Date().toISOString(),
    };
  }

  /**
   * Register handler for when operations need to be applied
   */
  onOperation(handler: (op: WorkspaceOperation) => void): () => void {
    this.onOperationHandlers.push(handler);
    return () => {
      const idx = this.onOperationHandlers.indexOf(handler);
      if (idx > -1) this.onOperationHandlers.splice(idx, 1);
    };
  }

  /**
   * Register handler for convergence
   */
  onConvergence(handler: () => void): () => void {
    this.onConvergenceHandlers.push(handler);
    return () => {
      const idx = this.onConvergenceHandlers.indexOf(handler);
      if (idx > -1) this.onConvergenceHandlers.splice(idx, 1);
    };
  }

  /**
   * Register handler for errors
   */
  onError(handler: (error: string) => void): () => void {
    this.onErrorHandlers.push(handler);
    return () => {
      const idx = this.onErrorHandlers.indexOf(handler);
      if (idx > -1) this.onErrorHandlers.splice(idx, 1);
    };
  }

  /**
   * Register handler for resilience and recovery transitions.
   */
  onRecoveryStatus(handler: (status: RecoveryStatus) => void): () => void {
    this.onRecoveryHandlers.push(handler);
    return () => {
      const idx = this.onRecoveryHandlers.indexOf(handler);
      if (idx > -1) this.onRecoveryHandlers.splice(idx, 1);
    };
  }

  /**
   * Signal connection state change
   */
  setConnected(connected: boolean): void {
    const wasConnected = this.state.isConnected;
    this.state.isConnected = connected;

    if (connected) {
      this.connectivityPhase = wasConnected ? 'stable' : 'reconnecting';
      this.emitRecoveryStatus(this.connectivityPhase, {
        reason: wasConnected ? 'heartbeat' : 'transport-restored',
        queuedMessages: this.state.messageQueue.length,
      });

      for (const queued of this.state.messageQueue.splice(0)) {
        this.bufferInboundMessage(queued);
      }

      this.processMessageBuffer();

      if (!wasConnected) {
        const downtimeMs = this.disconnectedAtMs ? Date.now() - this.disconnectedAtMs : 0;
        this.connectivityPhase = 'recovered';
        this.disconnectedAtMs = null;
        this.emitRecoveryStatus('recovered', {
          downtimeMs,
          requestedScopes: Array.from(this.pendingResyncScopes.values()),
        });
      }
    } else {
      this.connectivityPhase = 'disconnected';
      this.disconnectedAtMs = Date.now();
      this.emitRecoveryStatus('disconnected', {
        bufferedMessages: this.messageBuffer.size,
      });
    }
  }

  /**
   * Marks the transport as intermittent when connectivity is unstable but not fully down.
   */
  markIntermittentConnectivity(reason: string): void {
    this.connectivityPhase = 'intermittent';
    this.emitRecoveryStatus('intermittent', { reason });
  }

  /**
   * Mark scopes requiring explicit resynchronization after churn or reconnect.
   */
  requestResynchronization(scopes: RecoveryScope[], reason: string): void {
    for (const scope of scopes) {
      this.pendingResyncScopes.add(scope);
    }
    this.resyncRequests += 1;
    this.emitRecoveryStatus('resync-requested', {
      reason,
      scopes: scopes.join(','),
      totalRequests: this.resyncRequests,
    });
  }

  /**
   * Called by integration layer when a resync scope starts.
   */
  markResyncInProgress(scope: RecoveryScope): void {
    this.emitRecoveryStatus('resyncing', { scope });
  }

  /**
   * Called by integration layer when a resync scope completes.
   */
  markResyncComplete(scope: RecoveryScope): void {
    this.pendingResyncScopes.delete(scope);
    this.emitRecoveryStatus('recovered', {
      scope,
      pendingScopes: this.pendingResyncScopes.size,
    });
    if (this.pendingResyncScopes.size === 0 && this.state.isConnected) {
      this.connectivityPhase = 'stable';
      this.emitRecoveryStatus('stable');
    }
  }

  /**
   * Receive a sync message (may arrive out-of-order)
   */
  async receiveMessage(message: SyncMessage): Promise<void> {
    // 1. Duplicate detection
    if (this.seenMessageIds.has(message.id)) {
      return; // Discard duplicate
    }
    this.seenMessageIds.add(message.id);

    if (!this.state.isConnected) {
      this.state.messageQueue.push(message);
      this.emitRecoveryStatus('intermittent', {
        reason: 'message-queued-while-disconnected',
        queuedMessages: this.state.messageQueue.length,
      });
      return;
    }

    this.bufferInboundMessage(message);

    // 3. Trim buffer if too large
    this.trimMessageBufferIfNeeded();

    // 4. Try to process messages in order
    this.processMessageBuffer();
  }

  /**
   * Process buffered messages in sequence order.
   */
  private processMessageBuffer(): void {
    const now = Date.now();
    const shouldBatch = now - this.lastBatchProcessTime < this.BATCH_INTERVAL_MS;

    if (shouldBatch && this.messageBuffer.size < 50) {
      return;
    }

    let processedAny = false;
    for (const [fromPeerId, peerBuffer] of this.peerMessageBuffer.entries()) {
      let expectedSeq = this.expectedSequenceByPeer.get(fromPeerId);
      if (expectedSeq === undefined) {
        const minSeq = this.findMinSequence(peerBuffer);
        if (minSeq !== null) {
          expectedSeq = minSeq;
          this.expectedSequenceByPeer.set(fromPeerId, minSeq);
        }
      }

      if (expectedSeq === undefined) {
        continue;
      }

      while (peerBuffer.has(expectedSeq)) {
        const message = peerBuffer.get(expectedSeq);
        if (!message) {
          break;
        }

        try {
          this.processMessage(message);
          peerBuffer.delete(expectedSeq);
          this.messageBuffer.delete(this.getBufferKey(message));
          expectedSeq += 1;
          processedAny = true;
          this.expectedSequenceByPeer.set(fromPeerId, expectedSeq);
        } catch (error) {
          this.handleError(`Failed to process message: ${error}`);
          break;
        }
      }

      this.handleOutOfOrderGap(fromPeerId, expectedSeq, peerBuffer);

      if (peerBuffer.size === 0) {
        this.peerMessageBuffer.delete(fromPeerId);
      }
    }

    this.lastBatchProcessTime = now;

    if (processedAny) {
      this.checkConvergence();
    }
  }

  /**
   * Process a single message
   */
  private processMessage(message: SyncMessage): void {
    const timestamp = new Date().toISOString();

    switch (message.type) {
      case 'delta':
        this.handleDeltaMessage(message);
        break;

      case 'snapshot':
        this.handleSnapshotMessage(message);
        break;

      case 'sync':
        this.handleSyncMessage(message);
        break;

      case 'ack':
        this.handleAckMessage(message);
        break;

      case 'heartbeat':
        // Just update last sync time
        this.state.lastSyncTime = timestamp;
        break;
    }
  }

  /**
   * Handle delta message with operations
   */
  private handleDeltaMessage(message: SyncMessage): void {
    if (!message.payload.operations) return;

    for (const op of message.payload.operations) {
      // Deduplicate operations
      if (!this.operationDeduplication.has(op.id)) {
        this.operationDeduplication.set(op.id, op);
        this.state.pendingOperations.push(op);

        // Emit operation
        for (const handler of this.onOperationHandlers) {
          handler(op);
        }
      }
    }

    // Update remote clock tracking
    if (message.payload.clock) {
      this.updateRemoteClock(message.fromPeerId, message.payload.clock);
    }

    this.state.lastSyncTime = new Date().toISOString();
  }

  /**
   * Handle snapshot message (for late joiners)
   */
  private handleSnapshotMessage(message: SyncMessage): void {
    if (!message.payload.state) return;

    // Snapshot is usually sent when joining
    // We treat it as a full state reset
    this.state.lastSyncTime = new Date().toISOString();

    // Emit as synthetic operations for integration
    // In a real CRDT, we'd merge this properly
  }

  /**
   * Handle sync request
   */
  private handleSyncMessage(message: SyncMessage): void {
    // Sync message is usually a request or initialization
    this.state.lastSyncTime = new Date().toISOString();

    if (message.payload.clock) {
      this.updateRemoteClock(message.fromPeerId, message.payload.clock);
    }
  }

  /**
   * Handle acknowledgment
   */
  private handleAckMessage(message: SyncMessage): void {
    if (message.payload.checkpoint !== undefined) {
      // Peer has acknowledged operations up to checkpoint
      this.state.acknowledgedOperations.add(message.fromPeerId);
    }
  }

  /**
   * Update remote peer's clock
   */
  private updateRemoteClock(peerId: string, clock: Record<string, number>): void {
    if (!this.state.lastReceivedClock[peerId]) {
      this.state.lastReceivedClock[peerId] = 0;
    }

    // Store highest value seen from this peer
    const maxRemote = Math.max(
      this.state.lastReceivedClock[peerId],
      ...(Object.values(clock) as number[]),
    );

    this.state.lastReceivedClock[peerId] = maxRemote;
  }

  /**
   * Create a new operation to send
   */
  createOperation(
    type: WorkspaceOperation['type'],
    path: string[],
    value?: unknown,
    previousValue?: unknown,
  ): WorkspaceOperation {
    const op: WorkspaceOperation = {
      id: crypto.randomUUID(),
      type,
      path,
      value,
      previousValue,
      peerId: this.peerId,
      timestamp: new Date().toISOString(),
      clock: { ...this.state.localClock },
    };

    // Track operation
    this.operationDeduplication.set(op.id, op);
    this.state.pendingOperations.push(op);

    // Emit immediately for local application
    for (const handler of this.onOperationHandlers) {
      handler(op);
    }

    return op;
  }

  /**
   * Get pending operations for sending
   */
  getPendingOperations(limit?: number): WorkspaceOperation[] {
    if (limit === undefined) {
      return [...this.state.pendingOperations];
    }
    return this.state.pendingOperations.slice(0, limit);
  }

  /**
   * Acknowledge that operations have been sent
   */
  acknowledgeOperations(operationIds: string[]): void {
    for (const id of operationIds) {
      this.state.pendingOperations = this.state.pendingOperations.filter(op => op.id !== id);
    }
  }

  /**
   * Check if all peers have converged
   */
  private checkConvergence(): void {
    // Convergence is achieved when:
    // 1. No pending operations
    // 2. All peers have same view of all operations
    // 3. Message buffer is empty or all messages processed

    const isConverged =
      this.state.pendingOperations.length === 0 &&
      this.messageBuffer.size === 0;

    if (isConverged) {
      for (const handler of this.onConvergenceHandlers) {
        handler();
      }
    }
  }

  /**
   * Get synchronization metrics
   */
  getMetrics() {
    return {
      messageBufferSize: this.messageBuffer.size,
      queuedWhileDisconnected: this.state.messageQueue.length,
      pendingOperations: this.state.pendingOperations.length,
      acknowledgedOperations: this.state.acknowledgedOperations.size,
      isConnected: this.state.isConnected,
      lastSyncTime: this.state.lastSyncTime,
      connectivityPhase: this.connectivityPhase,
      pendingResyncScopes: this.pendingResyncScopes.size,
      resyncRequests: this.resyncRequests,
      disconnectedAtMs: this.disconnectedAtMs,
    };
  }

  /**
   * Handle error
   */
  private handleError(error: string): void {
    for (const handler of this.onErrorHandlers) {
      handler(error);
    }
  }

  /**
   * Reset state (for reconnection)
   */
  reset(): void {
    this.messageBuffer.clear();
    this.peerMessageBuffer.clear();
    this.expectedSequenceByPeer.clear();
    this.pendingResyncScopes.clear();
    this.operationDeduplication.clear();
    this.seenMessageIds.clear();
    this.state.pendingOperations = [];
    this.state.acknowledgedOperations.clear();
    this.state.messageQueue = [];
    this.connectivityPhase = 'stable';
    this.disconnectedAtMs = null;
    this.resyncRequests = 0;
  }

  /**
   * Get current sync state
   */
  getSyncState(): SyncState {
    return {
      ...this.state,
      localClock: { ...this.state.localClock },
      lastReceivedClock: { ...this.state.lastReceivedClock },
      pendingOperations: [...this.state.pendingOperations],
      acknowledgedOperations: new Set(this.state.acknowledgedOperations),
      messageQueue: [...this.state.messageQueue],
    };
  }

  private bufferInboundMessage(message: SyncMessage): void {
    const key = this.getBufferKey(message);
    this.messageBuffer.set(key, message);

    if (!this.peerMessageBuffer.has(message.fromPeerId)) {
      this.peerMessageBuffer.set(message.fromPeerId, new Map<number, SyncMessage>());
    }

    const peerBuffer = this.peerMessageBuffer.get(message.fromPeerId);
    if (!peerBuffer) {
      return;
    }

    peerBuffer.set(message.sequenceNumber, message);
  }

  private trimMessageBufferIfNeeded(): void {
    if (this.messageBuffer.size <= this.MAX_BUFFER_SIZE) {
      return;
    }

    const entries = Array.from(this.messageBuffer.entries())
      .sort((a, b) => a[1].timestamp.localeCompare(b[1].timestamp));

    const targetSize = Math.floor(this.MAX_BUFFER_SIZE * 0.8);
    const toDelete = entries.slice(0, entries.length - targetSize);
    for (const [key, message] of toDelete) {
      this.messageBuffer.delete(key);
      const peerBuffer = this.peerMessageBuffer.get(message.fromPeerId);
      peerBuffer?.delete(message.sequenceNumber);
      if (peerBuffer && peerBuffer.size === 0) {
        this.peerMessageBuffer.delete(message.fromPeerId);
      }
    }
  }

  private findMinSequence(buffer: Map<number, SyncMessage>): number | null {
    const keys = Array.from(buffer.keys());
    if (keys.length === 0) {
      return null;
    }
    return Math.min(...keys);
  }

  private handleOutOfOrderGap(
    fromPeerId: string,
    expectedSeq: number,
    buffer: Map<number, SyncMessage>,
  ): void {
    if (buffer.size === 0) {
      return;
    }

    const minSeq = this.findMinSequence(buffer);
    if (minSeq === null || minSeq <= expectedSeq) {
      return;
    }

    const oldestTimestamp = Math.min(
      ...Array.from(buffer.values()).map((msg) => Date.parse(msg.timestamp) || Date.now()),
    );
    const waitMs = Date.now() - oldestTimestamp;

    if (waitMs >= this.OUT_OF_ORDER_GRACE_MS) {
      this.requestResynchronization(
        ['workspace-state', 'room-membership', 'shared-directory-state'],
        `out-of-order-gap:${fromPeerId}:${expectedSeq}->${minSeq}`,
      );
      this.emitRecoveryStatus('resyncing', {
        fromPeerId,
        expectedSeq,
        nextBufferedSeq: minSeq,
      });
    } else {
      this.emitRecoveryStatus('intermittent', {
        reason: 'waiting-for-out-of-order-gap',
        fromPeerId,
        expectedSeq,
        nextBufferedSeq: minSeq,
      });
    }
  }

  private getBufferKey(message: SyncMessage): string {
    return `${message.fromPeerId}:${message.sequenceNumber}`;
  }

  private emitRecoveryStatus(
    phase: RecoveryPhase,
    details?: Record<string, unknown>,
  ): void {
    const status: RecoveryStatus = {
      phase,
      roomId: this.state.roomId,
      peerId: this.peerId,
      timestamp: new Date().toISOString(),
      details,
    };

    if (phase !== 'stable') {
      console.info('[SyncRecovery]', phase, {
        roomId: status.roomId,
        peerId: status.peerId,
        ...details,
      });
    }

    for (const handler of this.onRecoveryHandlers) {
      handler(status);
    }
  }
}
