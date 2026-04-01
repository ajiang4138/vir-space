/**
 * CollaborativeCanvas.tsx
 *
 * React component for rendering a collaborative 2D canvas
 * - Displays canvas elements with real-time updates
 * - Handles mouse interactions for adding/moving/resizing elements
 * - Shows peer cursors and presence
 * - Displays sync status
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasElement, CanvasState } from '../models/types';

interface CanvasOperationHandler {
  onAdd: (element: CanvasElement) => void;
  onUpdate: (elementId: string, updates: Partial<CanvasElement>) => void;
  onDelete: (elementId: string) => void;
  onMove: (elementId: string, x: number, y: number) => void;
  onResize: (elementId: string, width: number, height: number) => void;
  onBringToFront: (elementId: string) => void;
  onSendToBack: (elementId: string) => void;
}

export interface CollaborativeCanvasProps {
  canvasState: CanvasState;
  operations: CanvasOperationHandler;
  syncStatus: 'synced' | 'syncing' | 'pending' | 'error' | 'reconnecting' | 'recovering';
  peerId: string;
  pendingOperations: number;
  isConverged: boolean;
}

export function CollaborativeCanvas({
  canvasState,
  operations,
  syncStatus,
  peerId,
  pendingOperations,
  isConverged,
}: CollaborativeCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; elementId?: string } | null>(null);
  // const [lastMousePos, setLastMousePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Handle mouse down on canvas background - add new shape
  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (e.target === svgRef.current) {
        const rect = svgRef.current!.getBoundingClientRect();
        const x = (e.clientX - rect.left) / canvasState.zoom + canvasState.viewportX;
        const y = (e.clientY - rect.top) / canvasState.zoom + canvasState.viewportY;

        // Create a new rectangle element
        const element: CanvasElement = {
          id: crypto.randomUUID(),
          type: 'shape',
          x: x - 25,
          y: y - 25,
          width: 50,
          height: 50,
          data: { shapeType: 'rect', fillColor: '#3B82F6' },
          createdBy: peerId,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          modifiedBy: peerId,
          zIndex: Math.max(...Array.from(canvasState.elements.values()).map(e => e.zIndex ?? 0), 0) + 1,
        };

        operations.onAdd(element);
        setSelectedIds(new Set([element.id]));
      }
    },
    [canvasState.zoom, canvasState.viewportX, canvasState.viewportY, canvasState.elements, operations, peerId],
  );

  // Handle mouse down on element - start drag
  const handleElementMouseDown = useCallback(
    (e: React.MouseEvent<SVGGElement>, elementId: string) => {
      e.stopPropagation();
      setIsDragging(true);
      setDragStart({ x: e.clientX, y: e.clientY, elementId });
      setSelectedIds(new Set([elementId]));
    },
    [],
  );

  // Handle mouse move - drag element
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging || !dragStart) return;

      const deltaX = e.clientX - dragStart.x;
      const deltaY = e.clientY - dragStart.y;

      if (dragStart.elementId) {
        const element = canvasState.elements.get(dragStart.elementId);
        if (element) {
          const newX = element.x + deltaX / canvasState.zoom;
          const newY = element.y + deltaY / canvasState.zoom;
          operations.onMove(dragStart.elementId, newX, newY);

          setDragStart({ ...dragStart, x: e.clientX, y: e.clientY });
        }
      }

    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setDragStart(null);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, dragStart, canvasState.zoom, canvasState.elements, operations]);

  // Handle keyboard delete
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        selectedIds.forEach((id) => {
          operations.onDelete(id);
        });
        setSelectedIds(new Set());
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, operations]);

  const getStatusColor = () => {
    switch (syncStatus) {
      case 'synced':
        return '#10B981';
      case 'syncing':
        return '#F59E0B';
      case 'pending':
        return '#F97316';
      case 'error':
        return '#EF4444';
      case 'reconnecting':
        return '#F59E0B';
      case 'recovering':
        return '#0EA5E9';
      default:
        return '#6B7280';
    }
  };

  const getStatusText = () => {
    if (!isConverged) return 'Diverged';
    if (pendingOperations > 0) return `Pending (${pendingOperations})`;
    switch (syncStatus) {
      case 'synced':
        return 'Synced';
      case 'syncing':
        return 'Syncing...';
      case 'pending':
        return 'Pending...';
      case 'error':
        return 'Error';
      case 'reconnecting':
        return 'Reconnecting...';
      case 'recovering':
        return 'Recovering...';
      default:
        return 'Unknown';
    }
  };

  return (
    <div ref={containerRef} className="relative h-full w-full bg-slate-50 border border-slate-300 rounded-lg overflow-hidden">
      {/* Status badge */}
      <div className="absolute top-2 right-2 z-50 flex items-center gap-2 bg-white rounded-lg px-3 py-1.5 shadow-sm border border-slate-200">
        <div
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: getStatusColor() }}
        />
        <span className="text-xs font-medium text-slate-600">{getStatusText()}</span>
      </div>

      {/* Canvas grid background */}
      <svg
        ref={svgRef}
        width={canvasState.width}
        height={canvasState.height}
        viewBox={`${canvasState.viewportX} ${canvasState.viewportY} ${canvasState.width / canvasState.zoom} ${canvasState.height / canvasState.zoom}`}
        className="w-full h-full cursor-crosshair"
        onMouseDown={handleCanvasMouseDown}
        style={{ backgroundColor: '#F8FAFC' }}
      >
        {/* Grid pattern */}
        <defs>
          <pattern
            id="grid"
            width="20"
            height="20"
            patternUnits="userSpaceOnUse"
          >
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#E2E8F0" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width={canvasState.width} height={canvasState.height} fill="url(#grid)" />

        {/* Render canvas elements */}
        {Array.from(canvasState.elements.values())
          .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
          .map((element) => {
            const isSelected = selectedIds.has(element.id);

            return (
              <g
                key={element.id}
                onMouseDown={(e) => handleElementMouseDown(e, element.id)}
                style={{ cursor: isSelected ? 'move' : 'pointer' }}
              >
                {/* Element shape */}
                {element.type === 'shape' && (
                  <rect
                    x={element.x}
                    y={element.y}
                    width={element.width}
                    height={element.height}
                    fill={typeof element.data?.fillColor === 'string' ? element.data.fillColor : '#3B82F6'}
                    stroke={isSelected ? '#1F2937' : '#9CA3AF'}
                    strokeWidth={isSelected ? 2 : 1}
                    rx="4"
                    opacity="0.8"
                  />
                )}

                {/* Element text */}
                {element.type === 'text' && (
                  <text
                    x={element.x + element.width / 2}
                    y={element.y + element.height / 2}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="#1F2937"
                    fontSize="14"
                    fontWeight="500"
                  >
                    {typeof element.data?.textContent === 'string' ? element.data.textContent : 'Text'}
                  </text>
                )}

                {/* Element note (similar to sticky note) */}
                {element.type === 'note' && (
                  <>
                    <rect
                      x={element.x}
                      y={element.y}
                      width={element.width}
                      height={element.height}
                      fill="#FBBF24"
                      stroke={isSelected ? '#1F2937' : '#F59E0B'}
                      strokeWidth={isSelected ? 2 : 1}
                      rx="2"
                      opacity="0.85"
                    />
                    <text
                      x={element.x + 6}
                      y={element.y + 18}
                      fill="#78350F"
                      fontSize="12"
                      fontFamily="handwriting, cursive"
                      textAnchor="start"
                    >
                      {typeof element.data?.noteText === 'string' ? element.data.noteText.substring(0, 20) : 'Note'}
                    </text>
                  </>
                )}

                {/* Selection handle */}
                {isSelected && (
                  <>
                    <rect
                      x={element.x}
                      y={element.y}
                      width={element.width}
                      height={element.height}
                      fill="none"
                      stroke="#3B82F6"
                      strokeWidth="2"
                      strokeDasharray="4"
                      rx="4"
                      pointerEvents="none"
                    />
                    {/* Resize handle at bottom-right */}
                    <circle
                      cx={element.x + element.width}
                      cy={element.y + element.height}
                      r="4"
                      fill="#3B82F6"
                      stroke="white"
                      strokeWidth="1"
                      cursor="nwse-resize"
                      style={{ pointerEvents: 'auto' }}
                    />
                    {/* Metadata label */}
                    <text
                      x={element.x + element.width / 2}
                      y={element.y - 5}
                      textAnchor="middle"
                      fill="#6B7280"
                      fontSize="10"
                      pointerEvents="none"
                    >
                      {element.modifiedBy && element.modifiedBy !== peerId ? `by ${element.id.substring(0, 8)}` : 'Local'}
                    </text>
                  </>
                )}
              </g>
            );
          })}
      </svg>

      {/* Instructions */}
      <div className="absolute bottom-2 left-2 text-xs text-slate-500 pointer-events-none">
        <p>Click to add • Drag to move • Delete key to remove</p>
      </div>
    </div>
  );
}
