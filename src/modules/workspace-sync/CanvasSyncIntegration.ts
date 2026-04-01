/**
 * CanvasSyncIntegration.ts
 *
 * Integrates collaborative canvas with sync engine and networking layer
 * - Broadcasts canvas operations to remote peers
 * - Receives and applies remote canvas operations
 * - Manages state synchronization for new peers joining
 * - Handles state convergence
 */

import type {
    CanvasElement,
    CanvasOperation,
    CanvasOperationType,
    WorkspaceOperation,
    WorkspaceStateV2,
} from '../../models/types';
import { SyncEngine } from './SyncEngine';

export interface CanvasSyncIntegrationOptions {
  roomId: string;
  peerId: string;
  syncEngine: SyncEngine;
}

export class CanvasSyncIntegration {
  private roomId: string;
  private peerId: string;
  private syncEngine: SyncEngine;
  private broadcastHandlers: ((operation: CanvasOperation) => void)[] = [];
  private receiveHandlers: ((operation: CanvasOperation) => void)[] = [];
  private stateHandlers: ((state: WorkspaceStateV2) => void)[] = [];
  private operationQueue: CanvasOperation[] = [];
  private isProcessing = false;

  constructor(options: CanvasSyncIntegrationOptions) {
    this.roomId = options.roomId;
    this.peerId = options.peerId;
    this.syncEngine = options.syncEngine;

    // Register with sync engine to receive operations
    this.setupSyncEngineListeners();
  }

  /**
   * Setup listeners for sync engine events
   */
  private setupSyncEngineListeners(): void {
    this.syncEngine.onOperation((operation: WorkspaceOperation) => {
      // Filter for canvas operations
      if (operation.path[0] === 'canvas' && operation.path[1] === 'elements') {
        const canvasOp = this.convertToCanvasOperation(operation);
        if (canvasOp) {
          this.handleRemoteOperation(canvasOp);
        }
      }
    });

    this.syncEngine.onConvergence(() => {
      this.emitConvergence();
    });
  }

  /**
   * Convert WorkspaceOperation to CanvasOperation
   */
  private convertToCanvasOperation(operation: WorkspaceOperation): CanvasOperation | null {
    if (!operation.path[2]) return null;

    const type = this.toCanvasOperationType(operation.type);
    if (!type) {
      return null;
    }

    const elementId = operation.path[2];
    const baseOp: CanvasOperation = {
      type,
      elementId,
      elementData: this.asCanvasElement(operation.value),
      id: operation.id,
      peerId: operation.peerId,
      timestamp: operation.timestamp,
      clock: operation.clock,
    };

    return baseOp;
  }

  private toCanvasOperationType(type: WorkspaceOperation['type']): CanvasOperationType | null {
    switch (type) {
      case 'insert':
        return 'add';
      case 'update':
        return 'update';
      case 'delete':
        return 'delete';
      case 'move':
        return 'move';
      default:
        return null;
    }
  }

  private asCanvasElement(value: unknown): Partial<CanvasElement> | undefined {
    if (typeof value === 'object' && value !== null) {
      return value as Partial<CanvasElement>;
    }
    return undefined;
  }

  /**
   * Broadcast a local canvas operation to remote peers
   */
  broadcastOperation(operation: CanvasOperation): void {
    this.broadcastHandlers.forEach((handler) => handler(operation));

    // Queue for processing
    this.operationQueue.push(operation);
    this.processQueue();
  }

  /**
   * Handle incoming remote canvas operation
   */
  private handleRemoteOperation(operation: CanvasOperation): void {
    this.receiveHandlers.forEach((handler) => handler(operation));
  }

  /**
   * Process queued operations
   */
  private processQueue(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;

    // Batch process operations
    const batch = this.operationQueue.splice(0, 10);
    if (batch.length > 0) {
      // In real implementation, would send through networking layer
      console.log(`[CanvasSyncIntegration] Broadcasting ${batch.length} operations`);
    }

    this.isProcessing = false;

    // Process remaining items
    if (this.operationQueue.length > 0) {
      setTimeout(() => this.processQueue(), 50);
    }
  }

  /**
   * Emit convergence event
   */
  private emitConvergence(): void {
    this.stateHandlers.forEach((handler) => {
      // Emit a dummy state - in real implementation would send actual state
      handler({
        roomId: this.roomId,
        version: 0,
        canvas: {
          width: 1920,
          height: 1080,
          elements: new Map(),
          viewportX: 0,
          viewportY: 0,
          zoom: 1,
        },
        openFiles: [],
        sharedDirectory: {
          id: 'root',
          name: 'Shared Files',
          createdAt: new Date().toISOString(),
          createdBy: this.peerId,
          children: new Map(),
        },
        peerPresence: new Map(),
        activePeers: [this.peerId],
        updatedAt: new Date().toISOString(),
        updatedBy: this.peerId,
      });
    });
  }

  /**
   * Register handler for broadcast operations
   */
  onBroadcast(handler: (operation: CanvasOperation) => void): () => void {
    this.broadcastHandlers.push(handler);
    return () => {
      const idx = this.broadcastHandlers.indexOf(handler);
      if (idx > -1) this.broadcastHandlers.splice(idx, 1);
    };
  }

  /**
   * Register handler for received operations
   */
  onReceive(handler: (operation: CanvasOperation) => void): () => void {
    this.receiveHandlers.push(handler);
    return () => {
      const idx = this.receiveHandlers.indexOf(handler);
      if (idx > -1) this.receiveHandlers.splice(idx, 1);
    };
  }

  /**
   * Register handler for state updates
   */
  onStateUpdate(handler: (state: WorkspaceStateV2) => void): () => void {
    this.stateHandlers.push(handler);
    return () => {
      const idx = this.stateHandlers.indexOf(handler);
      if (idx > -1) this.stateHandlers.splice(idx, 1);
    };
  }

  /**
   * Initialize state for new peer joining
   */
  initializeForNewPeer(state: WorkspaceStateV2): void {
    this.stateHandlers.forEach((handler) => handler(state));
  }

  /**
   * Get metrics
   */
  getMetrics() {
    return {
      pendingOperations: this.operationQueue.length,
      isProcessing: this.isProcessing,
      broadcasterCount: this.broadcastHandlers.length,
      receiverCount: this.receiveHandlers.length,
    };
  }
}

/**
 * Create a canvas sync integration instance
 */
export function createCanvasSyncIntegration(
  options: CanvasSyncIntegrationOptions,
): CanvasSyncIntegration {
  return new CanvasSyncIntegration(options);
}
