# VIR

## Introduction
Project developed by Group 9 for CS6675-CS4675's Spring 2026 semester.

## Description
VIR is a desktop collaboration app for creating or joining shared rooms with real-time communication tools. It combines Electron, React, WebSocket signaling, and WebRTC to support chat and peer-to-peer collaboration workflows.

## Key Features
- Room creation and join flow with password validation.
- WebSocket-based signaling for room lifecycle and peer negotiation.
- WebRTC peer connections for real-time data exchange.
- BitTorrent-style file transfer flow with piece hashing, content `infoHash` identity, adaptive piece windows, and seeding after download completion.
- Multi-workspace collaboration UI:
  - Chatroom
  - Shared whiteboard
  - Shared text editor (CRDT sync)
  - File sharing and transfer tracking
- Participant list and room info panel
- Embedded Electron host signaling service and optional standalone signaling server mode.

## Tech Stack
- Language: TypeScript
- Frontend: React, Vite
- Desktop Runtime: Electron
- Realtime Networking: WebSocket (`ws`), WebRTC
- File Transfer Protocol: BitTorrent-inspired piece protocol over WebRTC data channels (room-scoped swarm)
- Collaboration: Yjs (CRDT)
- Whiteboard: `react-sketch-canvas`
- Tooling: npm, tsx, concurrently, wait-on, cross-env

## Installation Instructions
### Prerequisites
- Node.js 20+
- npm 10+

### Steps
1. Clone the repository:

```bash
git clone <your-repo-url>
cd vir-space
```

2. Install all dependencies (client + server):

```bash
npm run install:all
```

## Usage
### Run the desktop client

```bash
cd client
npm run dev
```

### Run the standalone signaling server (optional)

```bash
cd server
npm run dev
```

Use `ws://localhost:8787` (or your configured URL) as the bootstrap signaling URL when joining/creating a room.

### Build

```bash
npm run build
```

## Demo
Pending!

```bash
cd client
npm run build
```

From server only:

```bash
cd server
npm run build
```

## Environment Variables

Client supports these (all optional):

- `VITE_BOOTSTRAP_SIGNALING_URL`
  - Default bootstrap URL shown in UI.
- `VITE_STUN_URLS`
  - Comma-separated STUN URLs.
  - Default is `stun:stun.l.google.com:19302`.
- `VITE_TURN_URLS`
  - Comma-separated TURN URLs.
- `VITE_TURN_USERNAME`
  - TURN username.
- `VITE_TURN_CREDENTIAL`
  - TURN credential.

## NPM Scripts

### Root (`package.json`)

- `npm run install:all` installs client and server dependencies.
- `npm run dev:client` starts client dev flow.
- `npm run dev:server` starts standalone signaling server dev flow.
- `npm run build` builds client app.

### Client (`client/package.json`)

- `npm run dev` starts Vite + Electron concurrently.
- `npm run dev:renderer` starts Vite only.
- `npm run dev:electron` waits for renderer and starts Electron.
- `npm run build:electron` compiles Electron main/preload TS.
- `npm run typecheck` typechecks renderer + Electron TS.
- `npm run build` runs typecheck, Vite build, and Electron compile.

### Server (`server/package.json`)

- `npm run dev` starts standalone signaling server with watch mode.
- `npm run build` compiles server TS to `dist`.
- `npm run start` runs compiled server.

## Metrics Logging And Analysis

The Electron client now supports local metrics logging for evaluation runs.

- Logs are written under workspace root `.metrics/<run_id>/`.
- Each peer writes to `peer_<local_peer_file_id>.ndjson`.
- Open the run folder directly from filesystem at `.metrics/<run_id>/`.
- Metrics run ID is derived from room ID as `room-<roomId>`.

If you generated logs before this fix, some older runs may be under `client/dist-electron/.metrics/`.

### Analyze A Run

From repository root:

```bash
npm run analyze:metrics -- room-myroomid
```

You can also pass a direct directory path:

```bash
npm run analyze:metrics -- .metrics/room-myroomid
```

Generated output:

- `.metrics/<run_id>/analysis/room_latency.csv`
- `.metrics/<run_id>/analysis/transfer_metrics.csv`
- `.metrics/<run_id>/analysis/workspace_rtt.csv`
- `.metrics/<run_id>/analysis/resync_metrics.csv`
- `.metrics/<run_id>/analysis/metrics_summary.json`

## File And Folder Map

### Root

- `package.json`: Monorepo-level helper scripts (`install:all`, `dev:client`, `dev:server`, `build`).
- `README.md`: Project documentation.

### Client app (`client/`)

- `package.json`: Client scripts and dependencies (React, Electron, Vite).
- `index.html`: Renderer entry HTML.
- `tsconfig.json`: Renderer TypeScript config.
- `tsconfig.node.json`: Electron-process TypeScript config.
- `vite.config.ts`: Vite dev server config (`127.0.0.1:5173`, strict port).

#### Electron process code (`client/electron/`)

- `main.ts`: Electron main process; window lifecycle; IPC handlers; host service start/stop; local network info.
- `preload.ts`: Secure renderer bridge (`window.electronApi`) for host-service and network calls.
- `hostServer.ts`: Embedded WebSocket host signaling service and in-memory room management.

#### Renderer source (`client/src/`)

- `main.tsx`: React root mount.
- `App.tsx`: Main app flow/state machine (user setup, create/join, signaling lifecycle, WebRTC lifecycle, chat state).
- `styles.css`: App styling and responsive layout.
- `types.ts`: Shared renderer-facing types and unions for statuses/messages.
- `vite-env.d.ts`: Vite client type declarations.

##### Renderer components (`client/src/components/`)

- `JoinForm.tsx`: Multi-step setup UI (user ID, mode selection, create/join forms).
- `ChatPanel.tsx`: Chat message list + send form.
- `DebugLog.tsx`: Event timeline panel.
- `ParticipantList.tsx`: Connected participants display.
- `RoomInfo.tsx`: Room metadata/status display with leave/end actions.

##### Renderer libraries (`client/src/lib/`)

- `signalingClient.ts`: Browser WebSocket client wrapper with typed dispatch for signaling messages.
- `webrtc.ts`: `RTCPeerConnection` manager, ICE handling, data channel wiring, and status callbacks.

##### Shared signaling contracts (`client/src/shared/`)

- `signaling.ts`: Shared message/type contracts for room, relay, chat, and host-service info.

#### Build output (`client/dist-electron/`)

- `vite.config.js`: Transpiled copy of Vite config.
- `electron/main.js`, `electron/preload.js`, `electron/hostServer.js`: Compiled JS output for Electron process code.
- `src/shared/signaling.js`: Compiled shared signaling contracts.

### Standalone signaling service (`server/`)

- `package.json`: Server scripts/dependencies.
- `tsconfig.json`: Server TypeScript compiler settings.
- `src/index.ts`: Standalone WebSocket signaling server implementation with in-memory room store.

## Current Limitations

- No persistence: rooms and participants are in-memory only.
- No auth/identity verification beyond entered display name.
- No E2EE layer for signaling payloads.
- No host migration/re-election; room ends when host leaves.
- Room state model still has single explicit `guestPeerId`/`guestDisplayName` fields even though participant map can hold more peers.
- WebRTC connection manager is currently single-peer oriented (not full mesh for many peers).
- No file transfer, voice/video streams, or workspace synchronization yet.

## Authors

- Author: Allen Jiang, Jonathan Liang, Alyn Kosasi, Calvin Cheah, Yu Lin Lu, Zi Hang Lin
- Project Link: <https://github.com/ajiang4138/vir-space>
