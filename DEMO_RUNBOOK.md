# Vir Space Demo Runbook

Date: 2026-04-01

## Purpose

This runbook provides a stable, repeatable demonstration flow covering:

1. Create room
2. Discover and join room
3. Authenticate into room
4. Collaborate in real time
5. Share a file peer-to-peer
6. Verify file integrity
7. Disconnect and reconnect with state recovery
8. Show evidence of encrypted communication

## Demo Preconditions

- Node.js 20+ and npm 10+
- Dependencies installed
- No stale dev server using port 5173

Commands:

```bash
npm install
lsof -ti tcp:5173 | xargs -r kill -9
npm run dev
```

## Recommended Demo Setup

Use two app windows (or two machines) to represent two peers:

- Peer A (room owner)
- Peer B (joining collaborator)

Keep browser devtools console visible in at least one window for evidence logs.

## End-to-End Demo Flow

### 1. Create Room

In Peer A:

1. Open Create Room.
2. Enter room name.
3. Select auth method:
   - `password`, `shared-secret`, or `invite-token` (recommended: `password` for clarity).
4. Create room.

Expected outcome:

- Success status message appears.
- Room is opened in workspace.

### 2. Discover and Join Room

In Peer B:

1. Open Discover/Join flow.
2. Enter room ID.
3. Attempt join.

Expected outcome:

- If room is protected, UI transitions to authentication step.
- Helpful status text describes required credential type.

### 3. Authenticate into Room

In Peer B:

1. Enter credential.
2. Submit authentication.

Expected outcome:

- On success: `Successfully joined` message.
- On failure: clear error state with attempt context.

### 4. Collaborate in Real Time

In either peer workspace:

1. Add a canvas element.
2. Move/update/delete the element.
3. Observe updates reflected on the other peer.

Expected outcome:

- Changes propagate peer-to-peer.
- Sync status remains healthy (`synced` / `syncing` / recovery states as applicable).

### 5. Share a File Peer-to-Peer

In Peer A:

1. Select a file to share from the shared-file panel path.
2. Start transfer.

Expected outcome:

- Transfer session appears with progress.
- Peer B receives the announced file and transfer completes.

### 6. Verify File Integrity

In Peer B:

1. Wait for transfer completion.
2. Confirm transfer session shows verified completion.

Expected outcome:

- Verification status indicates integrity success.
- Recovery logs can show retry handling for fault scenarios in tests.

### 7. Disconnect and Reconnect with Recovery

Simulate disruption:

1. Temporarily disconnect one peer (network toggle, window suspend, or simulated churn in test path).
2. Reconnect peer.
3. Observe automatic resync.

Expected outcome:

- Recovery/status events move through reconnect/resync phases.
- Workspace and directory states converge after reconnect.

### 8. Show Encrypted Communication Evidence

Use one or both evidence paths:

1. Runtime evidence in logs:
   - `Transport security initialized`
   - Encrypted payload indicators (`encrypted: true`)
2. Test evidence:

```bash
npm run test -- src/modules/security/TransportEncryption.test.ts src/modules/networking/NetworkingLayer.test.ts
```

Expected outcome:

- Transport policy enforcement and encrypted envelope behavior validated.

## Validation Commands for Demo Readiness

```bash
npm run test -- src/modules/room-peer/RoomAuthentication.test.ts src/modules/networking/NetworkingLayer.test.ts src/modules/file-transfer/FileTransferEngine.test.ts src/modules/workspace-sync/WorkspaceSync.test.ts
```

## Troubleshooting

- `Room not found`: Verify room ID and that owner instance is running.
- `Authentication failed`: Verify credential and lockout timing.
- `Port conflict`: Kill process on `5173` and restart dev server.
- `No peer updates`: Confirm both peers are in same room and connected.
- `Transfer missing`: Verify file owner peer is still connected and local file bytes are available.

## Related Documents

- `README.md`
- `SECURITY_ENCRYPTION_IN_TRANSIT.md`
- `PERFORMANCE_RESILIENCE_SECURITY_EVALUATION_REPORT.md`
- `ROOM_AUTHENTICATION_GUIDE.md`
- `P2P_NETWORKING_GUIDE.md`
