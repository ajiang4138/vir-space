/**
 * Canvas Operation Type Mapper
 * Maps canvas-specific operations to workspace operations
 */

import type { CanvasElement, WorkspaceOperation } from './types';

/**
 * Convert canvas add operation to workspace operation
 */
export function createAddOperation(
  elementId: string,
  element: CanvasElement,
  peerId: string,
  clock: Record<string, number>,
): WorkspaceOperation {
  return {
    id: crypto.randomUUID(),
    type: 'insert',
    path: ['canvas', 'elements', elementId],
    value: element,
    peerId,
    timestamp: new Date().toISOString(),
    clock,
  };
}

/**
 * Convert canvas update operation to workspace operation
 */
export function createUpdateOperation(
  elementId: string,
  updates: Partial<CanvasElement>,
  previousValue: CanvasElement | undefined,
  peerId: string,
  clock: Record<string, number>,
): WorkspaceOperation {
  return {
    id: crypto.randomUUID(),
    type: 'update',
    path: ['canvas', 'elements', elementId],
    value: updates,
    previousValue,
    peerId,
    timestamp: new Date().toISOString(),
    clock,
  };
}

/**
 * Convert canvas delete operation to workspace operation
 */
export function createDeleteOperation(
  elementId: string,
  previousValue: CanvasElement,
  peerId: string,
  clock: Record<string, number>,
): WorkspaceOperation {
  return {
    id: crypto.randomUUID(),
    type: 'delete',
    path: ['canvas', 'elements', elementId],
    previousValue,
    peerId,
    timestamp: new Date().toISOString(),
    clock,
  };
}
