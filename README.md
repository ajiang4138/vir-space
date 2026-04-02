# Vir Space - Milestone 1

Electron desktop app with React + TypeScript where two clients join the same room and exchange chat messages over a WebRTC data channel, with a minimal Node.js signaling server using WebSocket.

## Project Structure

```text
vir-space/
  package.json
  README.md
  .gitignore
  client/
    package.json
    tsconfig.json
    tsconfig.node.json
    vite.config.ts
    index.html
    electron/
      main.ts
      preload.ts
    src/
      main.tsx
      App.tsx
      styles.css
      vite-env.d.ts
      types.ts
      lib/
        signaling.ts
        webrtc.ts
      components/
        JoinForm.tsx
        ChatPanel.tsx
        DebugLog.tsx
  server/
    package.json
    tsconfig.json
    src/
      index.ts
```

## Prerequisites

- Node.js 20+ (works on Windows and macOS)
- npm 10+ (or npm that ships with your Node version)

## Install

Run from repo root:

```bash
npm run install:all
```

Equivalent explicit commands:

```bash
npm install --prefix server
npm install --prefix client
```

## Run (Development)

### 1. Start signaling server

In terminal A:

```bash
npm run dev:server
```

Server defaults to `ws://localhost:8787`.

### 2. Start first desktop client

In terminal B:

```bash
npm run dev:client
```

In the opened app window:
- Signaling URL: `ws://localhost:8787`
- Room ID: `room-1`
- Display Name: e.g. `Alice`
- Click **Join Room**

### 3. Start second desktop client

In terminal C, launch another instance:

```bash
cd client
npm run dev
```

In the second window:
- Signaling URL: `ws://localhost:8787`
- Room ID: same as first (`room-1`)
- Display Name: e.g. `Bob`
- Click **Join Room**

When both are joined, the app performs signaling and establishes one `RTCDataChannel`.

### 4. Test room chat

- Wait for status: **peer connected** in both windows
- Type message in one client and click **Send**
- Verify it appears on the other client

## NPM Scripts

### Root

- `npm run install:all` - install server and client dependencies
- `npm run dev:server` - run signaling server in watch mode
- `npm run dev:client` - run Vite renderer + Electron app
- `npm run build` - build server and client

### Server (`server/package.json`)

- `npm run dev` - run with `tsx watch`
- `npm run build` - compile TypeScript to `server/dist`
- `npm run start` - run compiled server

### Client (`client/package.json`)

- `npm run dev` - run Vite + Electron together
- `npm run build:electron` - compile Electron main/preload
- `npm run typecheck` - typecheck renderer and node/electron code
- `npm run build` - production renderer build + Electron compile

## Signaling Protocol (JSON over WebSocket)

Client to server:
- `join`
- `offer`
- `answer`
- `ice-candidate`

Server to client:
- `joined`
- `peer-joined`
- `offer`
- `answer`
- `ice-candidate`
- `peer-left`
- `error`

Each message includes `roomId` and `senderId` where relevant.

## Milestone 1

Implemented:
- Electron desktop shell with secure preload (`contextBridge`, no direct Node API exposure)
- React + TypeScript renderer built with Vite
- Minimal typed WebSocket signaling server (`ws`) with 2-peer room limit
- Room join flow with room ID and display name
- Deterministic initiator selection for WebRTC negotiation
- `RTCPeerConnection` + reliable ordered `RTCDataChannel` for chat
- Offer/answer and ICE candidate relay via signaling server
- Connection states:
  - `disconnected`
  - `signaling connected`
  - `connecting to peer`
  - `peer connected`
- Debug event panel including:
  - connected to signaling server
  - joined room
  - received offer
  - received answer
  - received ICE candidate
  - data channel open
  - peer disconnected

Scope notes:
- Milestone 1 assumes max 2 peers per room
- Focused on clean modular structure (`signaling.ts`, `webrtc.ts`, UI components)
- Designed to extend later for presence, canvas sync, and file transfer
