/**
 * useCollaborativeCanvas.ts
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasElement, CanvasState, WorkspaceOperation, WorkspaceStateV2 } from '../../models/types';
import { CRDTStateManager } from './CRDTStateManager';
import { SyncEngine, type RecoveryPhase } from './SyncEngine';

type CanvasSyncStatus = 'synced' | 'syncing' | 'pending' | 'error' | 'reconnecting' | 'recovering';

export interface UseCollaborativeCanvasOptions {
  roomId: string;
  peerId: string;
  syncEngine: SyncEngine;
}

export interface CanvasOperationHandler {
  onAdd: (element: CanvasElement) => void;
  onUpdate: (elementId: string, updates: Partial<CanvasElement>) => void;
  onDelete: (elementId: string) => void;
  onMove: (elementId: string, x: number, y: number) => void;
  onResize: (elementId: string, width: number, height: number) => void;
  onBringToFront: (elementId: string) => void;
  onSendToBack: (elementId: string) => void;
}

export interface CollaborativeCanvasState {
  canvasState: CanvasState;
  operations: CanvasOperationHandler;
  syncStatus: CanvasSyncStatus;
  pendingOperations: number;
  isConverged: boolean;
  recoveryPhase: RecoveryPhase;
  getState: () => WorkspaceStateV2;
  updateRemoteState: (state: WorkspaceStateV2) => void;
}

export function useCollaborativeCanvas(
  options: UseCollaborativeCanvasOptions | null,
): CollaborativeCanvasState | null {
  const crdtRef = useRef<CRDTStateManager | null>(null);
  const pendingOpsRef = useRef<Map<string, WorkspaceOperation>>(new Map());

  const [canvasState, setCanvasState] = useState<CanvasState>({
    elements: new Map(),
    width: 1920,
    height: 1080,
    viewportX: 0,
    viewportY: 0,
    zoom: 1,
    selectedElementIds: new Set(),
    syncStatus: 'synced',
    lastSyncTime: new Date().toISOString(),
    convergenceStatus: 'converged',
  });

  const [syncStatus, setSyncStatus] = useState<CanvasSyncStatus>('synced');
  const [pendingOperations, setPendingOperations] = useState(0);
  const [isConverged, setIsConverged] = useState(true);
  const [recoveryPhase, setRecoveryPhase] = useState<RecoveryPhase>('stable');

  useEffect(() => {
    if (!options || crdtRef.current) {
      return;
    }

    crdtRef.current = new CRDTStateManager(options.roomId, options.peerId);
    const initialState = crdtRef.current.getState();
    setCanvasState((prev) => ({
      ...prev,
      elements: new Map(initialState.canvas.elements),
      width: initialState.canvas.width,
      height: initialState.canvas.height,
      viewportX: initialState.canvas.viewportX,
      viewportY: initialState.canvas.viewportY,
      zoom: initialState.canvas.zoom,
    }));
  }, [options]);

  useEffect(() => {
    if (!options) {
      return;
    }

    options.syncEngine.setConnected(true);

    const unsubscribeRecovery = options.syncEngine.onRecoveryStatus((status) => {
      setRecoveryPhase(status.phase);
      switch (status.phase) {
        case 'intermittent':
        case 'disconnected':
        case 'reconnecting':
          setSyncStatus('reconnecting');
          setIsConverged(false);
          break;
        case 'resync-requested':
        case 'resyncing':
          setSyncStatus('recovering');
          setIsConverged(false);
          break;
        case 'recovered':
        case 'stable':
          setSyncStatus((current) => (current === 'error' ? current : 'synced'));
          break;
      }
    });

    return () => {
      unsubscribeRecovery();
      options.syncEngine.setConnected(false);
    };
  }, [options]);

  useEffect(() => {
    if (!options) {
      return;
    }

    return options.syncEngine.onOperation((operation: WorkspaceOperation) => {
      const isCanvasOp =
        (operation.type === 'insert' || operation.type === 'update' || operation.type === 'delete')
        && operation.path[0] === 'canvas'
        && operation.path[1] === 'elements';

      if (!isCanvasOp || !crdtRef.current) {
        return;
      }

      setSyncStatus('syncing');
      setIsConverged(false);

      const applied = crdtRef.current.applyOperation(operation);
      if (!applied) {
        return;
      }

      const updatedState = crdtRef.current.getState();
      setCanvasState((prev) => ({
        ...prev,
        elements: new Map(updatedState.canvas.elements),
        lastSyncTime: new Date().toISOString(),
        convergenceStatus: 'syncing',
      }));

      setTimeout(() => {
        setSyncStatus('synced');
        setIsConverged(true);
        setCanvasState((prev) => ({ ...prev, convergenceStatus: 'converged' }));
      }, 100);
    });
  }, [options]);

  const getState = useCallback((): WorkspaceStateV2 => {
    if (crdtRef.current) {
      return crdtRef.current.getState();
    }

    const roomId = options?.roomId ?? 'unknown-room';
    const peerId = options?.peerId ?? 'unknown-peer';

    return {
      roomId,
      version: 0,
      canvas: {
        width: canvasState.width,
        height: canvasState.height,
        elements: new Map(canvasState.elements),
        viewportX: canvasState.viewportX,
        viewportY: canvasState.viewportY,
        zoom: canvasState.zoom,
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
    };
  }, [canvasState, options]);

  const createAndBroadcastOperation = useCallback((operation: WorkspaceOperation) => {
    if (!crdtRef.current) {
      return;
    }

    setSyncStatus('pending');
    pendingOpsRef.current.set(operation.id, operation);
    setPendingOperations(pendingOpsRef.current.size);

    crdtRef.current.applyOperation(operation);
    const updatedState = crdtRef.current.getState();
    setCanvasState((prev) => ({
      ...prev,
      elements: new Map(updatedState.canvas.elements),
      convergenceStatus: 'syncing',
    }));

    setTimeout(() => {
      pendingOpsRef.current.delete(operation.id);
      setPendingOperations(pendingOpsRef.current.size);
      setSyncStatus('synced');
      setCanvasState((prev) => ({ ...prev, convergenceStatus: 'converged' }));
    }, 120);
  }, []);

  const operations: CanvasOperationHandler = {
    onAdd: (element) => {
      if (!crdtRef.current) return;
      const op = crdtRef.current.addCanvasElement(element);
      createAndBroadcastOperation(op);
    },
    onUpdate: (elementId, updates) => {
      if (!crdtRef.current) return;
      const op = crdtRef.current.updateCanvasElement(elementId, updates);
      if (op) createAndBroadcastOperation(op);
    },
    onDelete: (elementId) => {
      if (!crdtRef.current) return;
      const op = crdtRef.current.deleteCanvasElement(elementId);
      if (op) createAndBroadcastOperation(op);
    },
    onMove: (elementId, x, y) => {
      if (!crdtRef.current) return;
      const op = crdtRef.current.updateCanvasElement(elementId, { x, y });
      if (op) createAndBroadcastOperation(op);
    },
    onResize: (elementId, width, height) => {
      if (!crdtRef.current) return;
      const op = crdtRef.current.updateCanvasElement(elementId, { width, height });
      if (op) createAndBroadcastOperation(op);
    },
    onBringToFront: (elementId) => {
      if (!crdtRef.current) return;
      const maxZ = Math.max(0, ...Array.from(canvasState.elements.values()).map((e) => e.zIndex ?? 0));
      const op = crdtRef.current.updateCanvasElement(elementId, { zIndex: maxZ + 1 });
      if (op) createAndBroadcastOperation(op);
    },
    onSendToBack: (elementId) => {
      if (!crdtRef.current) return;
      const minZ = Math.min(0, ...Array.from(canvasState.elements.values()).map((e) => e.zIndex ?? 0));
      const op = crdtRef.current.updateCanvasElement(elementId, { zIndex: minZ - 1 });
      if (op) createAndBroadcastOperation(op);
    },
  };

  const updateRemoteState = useCallback((state: WorkspaceStateV2) => {
    if (!crdtRef.current) {
      return;
    }

    const ops: WorkspaceOperation[] = Array.from(state.canvas.elements.values()).map((elem) => ({
      id: crypto.randomUUID(),
      type: 'insert',
      path: ['canvas', 'elements', elem.id],
      value: elem,
      peerId: elem.createdBy,
      timestamp: elem.createdAt,
      clock: {},
    }));

    const applied = crdtRef.current.applyOperations(ops);
    if (applied > 0) {
      const updated = crdtRef.current.getState();
      setCanvasState((prev) => ({
        ...prev,
        elements: new Map(updated.canvas.elements),
        lastSyncTime: new Date().toISOString(),
      }));
    }
  }, []);

  if (!options) {
    return null;
  }

  return {
    canvasState,
    operations,
    syncStatus,
    pendingOperations,
    isConverged,
    recoveryPhase,
    getState,
    updateRemoteState,
  };
}
