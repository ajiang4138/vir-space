import { describe, expect, it } from 'vitest';
import type { CanvasElement } from '../../models/types';
import { CRDTStateManager } from './CRDTStateManager';

const roomId = 'room-canvas-test';

function makeElement(id: string, peerId: string, x = 100, y = 100): CanvasElement {
  const now = new Date().toISOString();
  return {
    id,
    type: 'shape',
    x,
    y,
    width: 80,
    height: 60,
    data: { fillColor: '#3B82F6' },
    createdBy: peerId,
    createdAt: now,
    modifiedAt: now,
    modifiedBy: peerId,
    zIndex: 1,
  };
}

describe('Collaborative canvas convergence', () => {
  it('replicates add across peers', () => {
    const p1 = new CRDTStateManager(roomId, 'p1');
    const p2 = new CRDTStateManager(roomId, 'p2');

    const op = p1.addCanvasElement(makeElement('e1', 'p1'));
    p2.applyOperation(op);

    expect(p1.getState().canvas.elements.has('e1')).toBe(true);
    expect(p2.getState().canvas.elements.has('e1')).toBe(true);
  });

  it('converges for add, move, delete sequence', () => {
    const p1 = new CRDTStateManager(roomId, 'p1');
    const p2 = new CRDTStateManager(roomId, 'p2');
    const p3 = new CRDTStateManager(roomId, 'p3');

    const add = p1.addCanvasElement(makeElement('e2', 'p1', 10, 20));
    p2.applyOperation(add);
    p3.applyOperation(add);

    const move = p2.updateCanvasElement('e2', { x: 200, y: 250 });
    expect(move).not.toBeNull();
    if (!move) return;

    p1.applyOperation(move);
    p3.applyOperation(move);

    const del = p3.deleteCanvasElement('e2');
    expect(del).not.toBeNull();
    if (!del) return;

    p1.applyOperation(del);
    p2.applyOperation(del);

    expect(p1.getState().canvas.elements.has('e2')).toBe(false);
    expect(p2.getState().canvas.elements.has('e2')).toBe(false);
    expect(p3.getState().canvas.elements.has('e2')).toBe(false);
  });

  it('hydrates new peer from existing state snapshot', () => {
    const existing = new CRDTStateManager(roomId, 'p1');
    existing.addCanvasElement(makeElement('e3', 'p1', 333, 444));

    const joiner = new CRDTStateManager(roomId, 'p4');
    const state = existing.getState();

    const ops = Array.from(state.canvas.elements.values()).map((elem) => ({
      id: crypto.randomUUID(),
      type: 'insert' as const,
      path: ['canvas', 'elements', elem.id],
      value: elem,
      peerId: elem.createdBy,
      timestamp: elem.createdAt,
      clock: {},
    }));

    joiner.applyOperations(ops);

    const hydrated = joiner.getState().canvas.elements.get('e3');
    expect(hydrated?.x).toBe(333);
    expect(hydrated?.y).toBe(444);
  });
});
