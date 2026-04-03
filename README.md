# Vir Space - Option A Bootstrap Signaling

Electron desktop app with React + TypeScript. A minimal standalone WebSocket bootstrap/signaling server handles room coordination and WebRTC signaling relay. Chat traffic stays peer-to-peer over WebRTC RTCDataChannel.

## Project Structure

```text
vir-space/
  package.json
  README.md
  client/
    package.json
    tsconfig.json
    tsconfig.node.json
    vite.config.ts
    index.html
    electron/
      main.ts
      preload.ts
      hostServer.ts
    src/
      main.tsx
      App.tsx
      styles.css
      types.ts
      vite-env.d.ts
      shared/
        signaling.ts
      lib/
        signalingClient.ts
        webrtc.ts
      components/
        JoinForm.tsx
        ChatPanel.tsx
        DebugLog.tsx
        ParticipantList.tsx
        RoomInfo.tsx
  server/
    package.json
    tsconfig.json
    src/
      index.ts
```

The `server/` folder is required for Option A and must be running for room create/join flow.

## Prerequisites

- Node.js 20+
- npm 10+

## Install

Run from the repo root:

```bash
npm run install:all
```

This installs both client and server dependencies.

## Run

### Start bootstrap signaling server

Terminal A:

```bash
cd server
npm run dev
```

### Start client

Terminal B:

```bash
cd client
npm run dev
```

Use multiple Electron instances if you want host/guest local testing.

### Two-instance local test

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

Use Terminal B as the host instance and Terminal C as the guest instance.

### Host create flow

1. Enter a display name.
2. Enter a room ID.
3. Enter the bootstrap signaling URL (for example `ws://localhost:8787`).
4. Click **Create Room**.
5. The client connects to the bootstrap server.
6. The server registers host ownership for that room.
7. Host waits for guest.

### Guest join flow

1. Enter a display name.
2. Enter the same bootstrap signaling URL and room ID.
3. Click **Join Room**.
4. The server validates room exists and guest slot is available.
5. Signaling is relayed through the bootstrap server, and WebRTC negotiation begins.

## Option A Architecture

- Dedicated bootstrap/signaling server uses `ws` and in-memory room state.
- Server is not the chat transport; chat stays on RTCDataChannel.
- Room creator is still host.
- Max room size is 2 peers: one host and one guest.
- No host migration.
- If host disconnects or ends room, room closes immediately.

## Server Responsibilities

- `create-room`
- `join-room`
- `end-room`
- `leave-room`
- relay `offer` / `answer` / `ice-candidate` within same room only
- room lifecycle notifications: `participant-joined`, `participant-left`, `room-state`, `room-closed`

## Room Lifecycle

If host ends room or disconnects:

1. Server marks room closed and broadcasts `room-closed`.
2. Guest tears down WebRTC and clears room state.
3. Host remains room owner semantics-wise; no host migration is attempted.

If guest leaves or disconnects:

1. Host receives `participant-left` and `peer-left`.
2. Room remains open with empty guest slot.

## NPM Scripts

### Root

- `npm run install:all` - install client and server dependencies
- `npm run dev:client` - run renderer + Electron together for one instance
- `npm run dev:server` - run bootstrap signaling server
- `npm run build` - build the client app and Electron main/preload code

### Client (`client/package.json`)

- `npm run dev` - run Vite + Electron together
- `npm run dev:renderer` - run only the Vite renderer
- `npm run dev:electron` - run only the Electron process against the running Vite server
- `npm run build:electron` - compile Electron main/preload
- `npm run typecheck` - typecheck renderer and Electron code
- `npm run build` - production renderer build + Electron compile

## Known Limitations in This Milestone

- Room size is limited to 2 peers.
- There is no host migration or re-election.
- There is no decentralized room discovery.
- Peers need the same room ID and bootstrap URL.
- TURN credentials are optional and must be supplied via environment variables for strict NAT scenarios.
- Workspace sync, file transfer, and larger multi-peer topologies are not implemented yet.