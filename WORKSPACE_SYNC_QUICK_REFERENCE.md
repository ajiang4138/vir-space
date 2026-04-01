# Workspace Sync Quick Reference

## Quick Start

### 1. Initialize Service
```typescript
import { DecentralizedWorkspaceSyncService } from './modules/workspace-sync/WorkspaceSyncService';

const syncService = new DecentralizedWorkspaceSyncService('my-peer-id');
```

### 2. Join Room
```typescript
const room = { id: 'room-1', /* ... */ };
syncService.setPeerConnected(room.id, 'other-peer-1', true);
syncService.setPeerConnected(room.id, 'other-peer-2', true);
```

### 3. Canvas Operations

#### Add Element
```typescript
const element: CanvasElement = {
  id: 'shape-1',
  type: 'shape',
  x: 100, y: 200, width: 50, height: 50,
  data: { color: 'red' },
  createdBy: 'my-peer-id',
  createdAt: new Date().toISOString(),
  modifiedAt: new Date().toISOString(),
  modifiedBy: 'my-peer-id',
};

await syncService.addCanvasElement(roomId, element);
```

#### Update Element
```typescript
await syncService.updateCanvasElement(roomId, 'shape-1', {
  x: 150,
  data: { color: 'blue' },
});
```

#### Delete Element
```typescript
await syncService.deleteCanvasElement(roomId, 'shape-1');
```

### 4. Subscribe to Changes
```typescript
const unsubscribe = syncService.subscribe(roomId, (state) => {
  console.log('Canvas has', state.canvas.elements.size, 'elements');
  console.log('Active peers:', state.activePeers);
});

// Later...
unsubscribe();
```

### 5. Peer Presence
```typescript
await syncService.updatePeerPresence(roomId, {
  peerId: 'my-peer-id',
  color: '#FF0000',
  displayName: 'Alice',
  cursorPosition: { x: 100, y: 200 },
  status: 'active',
});
```

### 6. Receive Network Messages
```typescript
// From networking layer
const syncMessage: SyncMessage = /* ... */;
await syncService.receiveSyncMessage(syncMessage);
```

### 7. Send Sync Messages
```typescript
// Create delta message with pending operations
const message = await syncService.createSyncMessage(roomId, 'delta');
networkAdapter.broadcast(roomId, { type: 'workspace-sync', message });

// Or create snapshot (for late joiners)
const snapshot = await syncService.createSnapshot(roomId);
networkAdapter.send(peerId, { type: 'workspace-snapshot', snapshot });
```

### 8. Handle Late Joiners
```typescript
// New peer joins
const snapshot = await existingPeerSync.createSnapshot(roomId);
networkAdapter.send(newPeerId, snapshot);

// New peer restores
await newPeerSync.restoreFromSnapshot(roomId, snapshot);
```

### 9. Get Metrics
```typescript
const metrics = await syncService.getMetrics(roomId);

console.log({
  updateLatencyMs: metrics.updateLatencyMs,              // ms avg
  syncsPerSecond: metrics.syncsPerSecond,                // operations/sec
  pendingOperations: metrics.pendingOperations,          // to be sent
  messageQueueSize: metrics.messageQueueSize,            // buffered
  convergedPeers: metrics.convergedPeers,                // acknowledged
  totalPeers: metrics.totalPeers,                        // in room
});
```

### 10. Leave Room
```typescript
syncService.clearRoom(roomId);
```

## Integration Example

```typescript
import { WorkspaceSyncIntegrationManager } from './modules/workspace-sync/WorkspaceSyncIntegrationExample';

// Create manager
const manager = new WorkspaceSyncIntegrationManager(networkingLayer, localPeer);
await manager.initialize();

// Join room
await manager.joinRoom(room);

// Use high-level API
await manager.addCanvasElement(element);
await manager.updateCanvasElement('elem-1', { x: 200 });
await manager.updatePresence({ status: 'active', cursorPosition: { x: 100, y: 100 } });

// Monitor
const state = await manager.getState();
const metrics = await manager.getMetrics();

// Handle peers
manager.onPeerJoined(peer);
manager.onPeerLeft(peerId);

// Cleanup
await manager.leaveRoom();
```

## Conflict Resolution

**Strategy**: Last-Write-Wins with Lamport timestamps

```
UPDATE from Peer A at 2:00:00 PM
UPDATE from Peer B at 2:00:00 PM (same time)
  → Tiebreaker: Peer B > Peer A lexicographically? 
    → If yes, Peer A's version wins

UPDATE from Peer C at 2:00:01 PM
  → Always wins (newer timestamp)
```

## Message Types

| Type | Purpose | When Used |
|------|---------|-----------|
| `delta` | Operations to apply | Every 500ms (periodic) |
| `snapshot` | Full state transfer | On late joiner join, every 5s |
| `sync` | Clock synchronization | Connection establishment |
| `ack` | Acknowledgment | Convergence tracking |
| `heartbeat` | Keepalive | Periodic (if connected) |

## Sequence Diagram: Concurrent Edits

```
Peer A                          Peer B
   │                              │
   ├─ Create Element (id=abc)     │
   │  Op_A.clock = {A:1}          │
   │                    ─────────>│
   │                              ├─ Receive Op_A
   │                              ├─ Apply Op_A
   │                              │
   │                    <─────────┤
   │                    Op_B: Modify abc (id=def)
   │                    Op_B.clock = {B:1, A:1}
   │                              │
   ├─ Receive Op_B                │
   ├─ Apply Op_B                  │
   │  LWW: B's timestamp > A's?   │
   │  If yes: Use B's version     │
   │
   └──────────────────────────────┘
         Both now converged
```

## Troubleshooting

### Issue: Changes not syncing
**Solution**: Check peer connections
```typescript
syncService.setPeerConnected(roomId, peerId, true);
```

### Issue: Old messages are still processing
**Solution**: Messages are buffered and processed in order. Check metrics:
```typescript
const metrics = await syncService.getMetrics(roomId);
console.log('Queue size:', metrics.messageQueueSize);
```

### Issue: Memory usage growing
**Solution**: Message buffer has max 10,000. Operation buffer has max 5,000.
Clear old snapshots periodically and keep updated.

### Issue: Convergence not detected
**Solution**: Convergence happens when:
- No pending operations
- Message buffer empty
- All peers have acknowledged

Check:
```typescript
const state = await syncService.getState(roomId);
console.log('Is converged:', state.syncMetadata?.isConverged);
```

## Architecture Layers

```
Application Layer
    ↓
WorkspaceSyncService (Public API)
    ↓
CRDTStateManager + SyncEngine (Core Logic)
    ↓
SyncMessage (Protocol)
    ↓
NetworkingLayer (Transport)
    ↓
Peers (Network)
```

## Types Reference

### CanvasElement
```typescript
{
  id: string;              // Unique element ID
  type: 'shape' | 'text' | 'media' | 'note';
  x: number;               // Position X
  y: number;               // Position Y
  width: number;           // Width
  height: number;          // Height
  data: Record<string, unknown>;  // Custom data
  createdBy: string;       // Peer ID
  createdAt: string;       // ISO timestamp
  modifiedAt: string;      // ISO timestamp
  modifiedBy: string;      // Peer ID
  zIndex?: number;         // Layer depth
}
```

### PeerPresenceMetadata
```typescript
{
  peerId: string;                    // Peer ID
  color: string;                     // Cursor color
  displayName: string;               // Display name
  cursorPosition?: { x: number; y: number };
  selectedElementId?: string;        // Selected element
  lastActivity: string;              // ISO timestamp
  status: 'active' | 'idle' | 'away';
}
```

### SyncMetrics
```typescript
{
  roomId: string;
  peerId: string;
  updateLatencyMs: number;           // Average ms
  messageQueueSize: number;          // Messages buffered
  pendingOperations: number;         // Operations waiting
  convergedPeers: number;            // Peers acknowledged
  totalPeers: number;                // In room
  syncsPerSecond: number;            // Sync frequency
  lastUpdate: string;                // ISO timestamp
  uptime: number;                    // Milliseconds
}
```

## Testing

```bash
# Run all tests
npm run test

# Run workspace sync tests specifically
npm run test workspace-sync

# Run with coverage
npm run test -- --coverage
```

## Performance Tips

1. **Batch operations**: Group multiple updates before sending
2. **Monitor latency**: Check `metrics.updateLatencyMs`
3. **Watch queue size**: If > 5000, messages are dropping
4. **Enable debug**: Add console logs in `SyncEngine`
5. **Profile memory**: Check operation history size

## Example: Real-time Collaboration

```typescript
// Setup
const manager = new WorkspaceSyncIntegrationManager(networking, peer1);
await manager.joinRoom(room);

// Listen for changes
manager.subscribeToState((state) => {
  renderCanvas(state.canvas.elements);
  renderPeerCursors(state.peerPresence);
});

// Handle user actions
onCanvasClick((x, y) => {
  manager.addCanvasElement({
    id: uuid(),
    type: 'shape',
    x, y,
    width: 50, height: 50,
    data: { color: '#FF0000' },
    createdBy: peer1.id,
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    modifiedBy: peer1.id,
  });
});

onMouseMove(({ x, y }) => {
  manager.updatePresence({
    cursorPosition: { x, y },
    status: 'active',
  });
});

// Monitor performance
setInterval(async () => {
  const metrics = await manager.getMetrics();
  updateStatusBar({
    latency: `${metrics.updateLatencyMs.toFixed(1)}ms`,
    peers: `${metrics.convergedPeers}/${metrics.totalPeers}`,
    queue: metrics.messageQueueSize,
  });
}, 1000);
```

## See Also

- `WORKSPACE_SYNC_IMPLEMENTATION.md` - Full documentation
- `WorkspaceSyncIntegrationExample.ts` - Integration example
- `WorkspaceSync.test.ts` - Test suite
- `P2P_NETWORKING_GUIDE.md` - Networking layer
