# Final Architecture Summary

Date: 2026-04-01

## System Overview

Vir Space is a desktop-first peer-to-peer collaboration application composed of:

1. Electron shell
2. React renderer/UI state
3. Room and peer lifecycle management
4. P2P networking and transport security
5. Workspace synchronization
6. Shared directory and file transfer
7. Security/authentication services
8. Evaluation and resilience testing

## Layered Architecture

### 1. Desktop and UI

- Electron main/preload host desktop runtime.
- React pages drive room creation, joining, and workspace interactions.
- Shared status messages and state are managed via the UI store.

Key paths:

- `electron/main.ts`
- `electron/preload.ts`
- `src/App.tsx`
- `src/pages/*`
- `src/store/*`

### 2. Room and Membership

- `RoomManager` orchestrates room lifecycle.
- `InMemoryRoomPeerManager` enforces membership and authentication rules.
- Membership snapshots/resync APIs support churn/recovery scenarios.

Key paths:

- `src/modules/room-peer/RoomManager.ts`
- `src/modules/room-peer/RoomPeerManager.ts`

### 3. Authentication and Access Control

Supported methods:

- `public`
- `password`
- `shared-secret`
- `invite-token`

Security controls:

- Attempt tracking
- Lockout windows
- Credential hashing and timing-safe comparison

Key paths:

- `src/modules/security/AuthenticationService.ts`
- `src/modules/room-peer/RoomAuthentication.test.ts`

### 4. Networking and Transport

- `LibP2PNetworkingLayer` provides direct peer messaging and room broadcast.
- `IntegratedNetworkingManager` coordinates connections and diagnostics.
- Connection manager monitors lifecycle and reconnection.

Key paths:

- `src/modules/networking/NetworkingLayer.ts`
- `src/modules/networking/NetworkingIntegration.ts`
- `src/modules/networking/ConnectionManager.ts`

### 5. Encryption in Transit

- Transport/channel encryption via libp2p noise.
- Payload encryption via AES-GCM envelopes.
- Room-specific transport secret support and security reporting.

Key path:

- `src/modules/security/TransportEncryption.ts`

### 6. Workspace Synchronization

- CRDT-like operation flow with deduplication and buffering.
- Out-of-order handling and recovery phase tracking.
- Snapshot restore path for late joiners.

Key paths:

- `src/modules/workspace-sync/CRDTStateManager.ts`
- `src/modules/workspace-sync/SyncEngine.ts`
- `src/modules/workspace-sync/WorkspaceSyncService.ts`

### 7. Shared Directory and File Transfer

- Shared directory announcements, tombstones, and snapshot merge.
- Chunked transfer sessions with retry and verification.
- Integration hooks bridge state/store and transfer runtime.

Key paths:

- `src/modules/file-transfer/SharedFileDirectorySync.ts`
- `src/modules/file-transfer/FileTransferEngine.ts`
- `src/modules/file-transfer/useFileTransferIntegration.ts`

## Recovery and Resilience Model

System supports disruption recovery through:

1. Membership snapshot/resync in room manager
2. Sync engine recovery phases (`disconnected`, `reconnecting`, `resyncing`, `recovered`)
3. Shared directory resynchronization after reconnect
4. Transfer retry logic for dropped/corrupted chunks

## Observability

- Structured module logs (`RoomPeerManager`, sync recovery, transfer recovery, networking logger)
- Diagnostics helpers for connection quality and recommendations
- Evaluation harness report for performance/resilience/security outcomes

## Architecture Status

- End-to-end flow implemented and test-backed for demo scope.
- TypeScript compile status is clean (`get_errors` reported no compile issues).
- Core demonstration paths validated by targeted tests.
