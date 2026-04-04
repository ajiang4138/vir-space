# Vir Space

Vir Space is an Electron desktop chat app built with React + TypeScript.

At the moment, it supports:

- Room creation and joining with room password validation.
- WebSocket-based signaling (room lifecycle + relay messages).
- WebRTC peer connection negotiation.
- Text chat UI with participant list and room state display.
- Debug event timeline for connection and signaling diagnostics.

## What The App Can Currently Do

### User setup and room actions

- Prompt for a user ID before any room action.
- Let a user choose between Create Room or Join Room.
- Generate a random room ID for hosts.
- Require a room password (minimum 4 characters).
- Validate bootstrap/signaling URL format (`ws://` or `wss://`).
- Show detailed connection states like:
  - `connecting to bootstrap server`
  - `room created`
  - `waiting for guest`
  - `peer connecting`
  - `peer connected`
  - `invalid room password`
  - `room full`
  - `room not found`

### Signaling and room lifecycle

- Handle messages for:
  - `create-room`
  - `join-room`
  - `leave-room`
  - `end-room`
  - `offer`
  - `answer`
  - `ice-candidate`
  - `chat-message`
- Broadcast room updates (`room-state`, `participant-joined`, `participant-left`, `room-closed`, `peer-left`).
- Enforce room password checks.
- Enforce max participants at signaling layer (`6`).
- Close room immediately when host ends session or disconnects.

### WebRTC behavior

- Establish one `RTCPeerConnection` per client session.
- Exchange SDP offers/answers and ICE candidates via signaling server.
- Create/use a WebRTC data channel named `chat`.
- Surface WebRTC status (`idle`, `connecting`, `connected`, `disconnected`, `failed`, `closed`) in the UI.

### Chat behavior right now

- Chat UI supports send/receive with local timestamps.
- Outbound chat is currently sent through signaling as `chat-message` and fanned out by server.
- The WebRTC data channel is established and monitored, but user chat transport is currently server-relayed (not pure RTCDataChannel-only chat).

### Host networking helpers (Electron)

- Renderer can query local IPv4 addresses via preload bridge.
- On host create flow, app can start a local host signaling service on selected port (default `8787`).
- If host enters a loopback URL, app tries to replace with LAN IP and may prompt for manual IP.

## Architecture Modes In This Repo

There are two signaling implementations present:

1. Embedded host signaling service inside Electron client (`client/electron/hostServer.ts`).
2. Standalone signaling server process (`server/src/index.ts`).

The client can connect to whichever bootstrap URL is entered in the form.

## Prerequisites

- Node.js 20+
- npm 10+

## Install

From repository root:

```bash
npm run install:all
```

## Run

### Quick start (recommended)

From repository root:

```bash
npm run dev
```

This one command:

- Starts the client flow.
- Checks whether relay server is already reachable at bootstrap URL.
- Starts local relay server only when needed.

### Client-only flow (advanced)

```bash
cd client
npm run dev
```

This runs Vite renderer and Electron together.

### Optional: run standalone signaling server

```bash
cd server
npm run dev
```

Then point clients to that server URL (for example `ws://localhost:8787`).

### Two Electron instances for local host/guest test

Terminal A:

```bash
cd client
npm run dev:renderer
```

Terminal B:

```bash
cd client
npm run dev:electron
```

Terminal C:

```bash
cd client
npm run dev:electron
```

Use one Electron window as host and the other as guest.

## Build

From root:

```bash
npm run build
```

From client only:

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

- `npm run dev` starts relay-ensure + client in one command.
- `npm run install:all` installs client and server dependencies.
- `npm run dev:relay:ensure` checks relay reachability and starts local relay only if needed.
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