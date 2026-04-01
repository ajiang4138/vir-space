/**
 * CRDTStateManager.ts
 *
 * Manages CRDT-like state for workspace synchronization.
 * - Uses Lamport timestamps for causality
 * - Supports operation-based updates
 * - Handles conflict resolution through last-write-wins with timestamps
 * - Tracks operation history for recovery
 */

import type {
    CanvasElement,
    PeerPresenceMetadata,
    WorkspaceOperation,
    WorkspaceStateV2
} from '../../models/types';

// ==================== CRDT State Manager ====================
export class CRDTStateManager {
  private state: WorkspaceStateV2;
  private operationHistory: WorkspaceOperation[] = [];
  private lamportClock: Record<string, number> = {}; // peerId -> clock value
  private localClock = 0;
  private readonly peerId: string;

  constructor(roomId: string, peerId: string, initialState?: Partial<WorkspaceStateV2>) {
    this.peerId = peerId;
    this.lamportClock[peerId] = 0;

    // Initialize state
    this.state = {
      roomId,
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
        createdBy: peerId,
        children: new Map(),
      },
      peerPresence: new Map(),
      activePeers: [peerId],
      updatedAt: new Date().toISOString(),
      updatedBy: peerId,
      ...(initialState || {}),
    };
  }

  /**
   * Get current state
   */
  getState(): WorkspaceStateV2 {
    return structuredClone(this.state) as WorkspaceStateV2;
  }

  /**
   * Increment local Lamport clock and return new value
   */
  private incrementLocalClock(): number {
    this.localClock++;
    this.lamportClock[this.peerId] = this.localClock;
    return this.localClock;
  }

  /**
   * Update Lamport clock on receiving message from peer
   */
  private updateLamportClock(receivedClock: Record<string, number>): void {
    // Find max value from received clock
    const maxReceived = Math.max(
      0,
      ...Object.values(receivedClock),
    );

    // Update local clock
    this.localClock = Math.max(this.localClock + 1, maxReceived + 1);
    this.lamportClock[this.peerId] = this.localClock;

    // Merge received clock values
    for (const [peer, clock] of Object.entries(receivedClock)) {
      this.lamportClock[peer] = Math.max(
        this.lamportClock[peer] ?? 0,
        clock,
      );
    }
  }

  /**
   * Get current clock state
   */
  getClock(): Record<string, number> {
    return { ...this.lamportClock };
  }

  /**
   * Add a canvas element (with conflict resolution)
   */
  addCanvasElement(element: CanvasElement): WorkspaceOperation {
    this.incrementLocalClock();

    const operation: WorkspaceOperation = {
      id: crypto.randomUUID(),
      type: 'insert',
      path: ['canvas', 'elements', element.id],
      value: element,
      peerId: this.peerId,
      timestamp: new Date().toISOString(),
      clock: { ...this.lamportClock },
    };

    this.applyOperation(operation);
    this.operationHistory.push(operation);

    return operation;
  }

  /**
   * Update a canvas element
   */
  updateCanvasElement(elementId: string, updates: Partial<CanvasElement>): WorkspaceOperation | null {
    this.incrementLocalClock();
    const element = this.state.canvas.elements.get(elementId);

    if (!element) {
      return null;
    }

    const updated: CanvasElement = { ...element, ...updates, modifiedBy: this.peerId, modifiedAt: new Date().toISOString() };

    const operation: WorkspaceOperation = {
      id: crypto.randomUUID(),
      type: 'update',
      path: ['canvas', 'elements', elementId],
      value: updated,
      previousValue: element,
      peerId: this.peerId,
      timestamp: new Date().toISOString(),
      clock: { ...this.lamportClock },
    };

    this.applyOperation(operation);
    this.operationHistory.push(operation);

    return operation;
  }

  /**
   * Delete a canvas element
   */
  deleteCanvasElement(elementId: string): WorkspaceOperation | null {
    this.incrementLocalClock();
    const element = this.state.canvas.elements.get(elementId);

    if (!element) {
      return null;
    }

    const operation: WorkspaceOperation = {
      id: crypto.randomUUID(),
      type: 'delete',
      path: ['canvas', 'elements', elementId],
      previousValue: element,
      peerId: this.peerId,
      timestamp: new Date().toISOString(),
      clock: { ...this.lamportClock },
    };

    this.applyOperation(operation);
    this.operationHistory.push(operation);

    return operation;
  }

  /**
   * Update peer presence
   */
  updatePeerPresence(presence: PeerPresenceMetadata): WorkspaceOperation {
    this.incrementLocalClock();

    const operation: WorkspaceOperation = {
      id: crypto.randomUUID(),
      type: 'update',
      path: ['peerPresence', presence.peerId],
      value: presence,
      peerId: this.peerId,
      timestamp: new Date().toISOString(),
      clock: { ...this.lamportClock },
    };

    this.applyOperation(operation);
    this.operationHistory.push(operation);

    return operation;
  }

  /**
   * Add peer to active peers
   */
  addActivePeer(peerId: string): void {
    if (!this.state.activePeers.includes(peerId)) {
      this.state.activePeers.push(peerId);
      this.lamportClock[peerId] = 0;
    }
  }

  /**
   * Remove peer from active peers
   */
  removeActivePeer(peerId: string): void {
    this.state.activePeers = this.state.activePeers.filter(p => p !== peerId);
    this.state.peerPresence.delete(peerId);
  }

  /**
   * Apply an operation to local state (with conflict resolution)
   * Using last-write-wins strategy with Lamport timestamps
   */
  applyOperation(operation: WorkspaceOperation): boolean {
    // Update our view of remote clocks
    this.updateLamportClock(operation.clock);

    // Conflict resolution: last-write-wins based on timestamp + peerId
    if (operation.type === 'insert' || operation.type === 'update') {
      // Check if we have an existing value at this path
      const existing = this.getValueAtPath(operation.path);

      if (this.isRecord(existing) && typeof existing.modifiedAt === 'string') {
        // Compare timestamps: if operation is older, reject it
        const existingTime = new Date(existing.modifiedAt).getTime();
        const operationTime = new Date(operation.timestamp).getTime();

        if (operationTime < existingTime) {
          return false; // Reject older operation
        }

        // If same timestamp, use peerId as tiebreaker (lexicographic)
        if (operationTime === existingTime) {
          const existingPeerId =
            (typeof existing.modifiedBy === 'string' ? existing.modifiedBy : undefined)
            || (typeof existing.createdBy === 'string' ? existing.createdBy : undefined);
          if (existingPeerId && existingPeerId > operation.peerId) {
            return false; // Reject if our peerId is "greater"
          }
        }
      }

      this.setValueAtPath(operation.path, operation.value);
      this.state.version++;
      this.state.updatedAt = operation.timestamp;
      this.state.updatedBy = operation.peerId;

      return true;
    }

    if (operation.type === 'delete') {
      this.deleteValueAtPath(operation.path);
      this.state.version++;
      this.state.updatedAt = operation.timestamp;
      this.state.updatedBy = operation.peerId;

      return true;
    }

    return false;
  }

  /**
   * Apply multiple operations (batch update)
   */
  applyOperations(operations: WorkspaceOperation[]): number {
    let applied = 0;

    for (const op of operations) {
      if (this.applyOperation(op)) {
        applied++;
      }
    }

    return applied;
  }

  /**
   * Get value at path
   */
  private getValueAtPath(path: string[]): unknown {
    let current: unknown = this.state;

    for (const key of path) {
      if (current instanceof Map) {
        current = current.get(key);
      } else if (this.isRecord(current)) {
        current = current[key];
      } else {
        return undefined;
      }
    }

    return current;
  }

  /**
   * Set value at path
   */
  private setValueAtPath(path: string[], value: unknown): void {
    if (path.length === 0) return;

    let current: unknown = this.state;

    // Navigate to parent
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];

      if (current instanceof Map) {
        if (!current.has(key)) {
          current.set(key, {} as Record<string, unknown>);
        }
        current = current.get(key);
      } else if (this.isRecord(current)) {
        if (!(key in current)) {
          current[key] = {};
        }
        current = current[key];
      }
    }

    // Set final value
    const lastKey = path[path.length - 1];
    if (current instanceof Map) {
      current.set(lastKey, value);
    } else if (this.isRecord(current)) {
      current[lastKey] = value;
    }
  }

  /**
   * Delete value at path
   */
  private deleteValueAtPath(path: string[]): void {
    if (path.length === 0) return;

    let current: unknown = this.state;

    // Navigate to parent
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];

      if (current instanceof Map) {
        current = current.get(key);
      } else if (this.isRecord(current)) {
        current = current[key];
      } else {
        return;
      }
    }

    // Delete final value
    const lastKey = path[path.length - 1];
    if (current instanceof Map) {
      current.delete(lastKey);
    } else if (this.isRecord(current)) {
      delete current[lastKey];
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  /**
   * Get operation history (for recovery and late joiners)
   */
  getOperationHistory(since?: number): WorkspaceOperation[] {
    if (since === undefined) return [...this.operationHistory];
    return this.operationHistory.slice(since);
  }

  /**
   * Get operation history size
   */
  getOperationHistorySize(): number {
    return this.operationHistory.length;
  }

  /**
   * Create a checkpointed state snapshot
   */
  createSnapshot(): { state: WorkspaceStateV2; operationCount: number } {
    return {
      state: structuredClone(this.state) as WorkspaceStateV2,
      operationCount: this.operationHistory.length,
    };
  }

  /**
   * Restore from snapshot (for late joiners)
   */
  restoreFromSnapshot(snapshot: { state: WorkspaceStateV2; operationCount: number }): void {
    this.state = structuredClone(snapshot.state) as WorkspaceStateV2;
    // Clear operation history after restore
    this.operationHistory = [];
  }
}
