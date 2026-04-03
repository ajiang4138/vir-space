# Vir Space - Milestone 2

Electron desktop app with React + TypeScript where the room creator becomes a temporary host and runs the room coordination/signaling service inside the same app instance. WebRTC still carries chat traffic directly between the two peers.

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

The `server/` folder is legacy and is not required for the normal hosted-room flow.

## Prerequisites

- Node.js 20+
- npm 10+

## Install

Run from the repo root:

```bash
npm run install:all
```

This installs the client dependencies only. The hosted-room flow does not require the standalone server during normal operation.

## Run

### Single instance development

Terminal A:

```bash
cd client
npm run dev
```

This starts the Vite renderer and one Electron instance.

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
3. Optionally change the host port.
4. Click **Create Room**.
5. The Electron main process starts a local ws signaling service.
6. The renderer connects to that local service and creates the room.
7. Share the host address, port, and room ID with the guest.

### Guest join flow

1. Enter a display name.
2. Enter the host address, host port, and room ID.
3. Click **Join Room**.
4. The renderer connects directly to the host's ws endpoint.
5. Signaling is relayed through the host app, and WebRTC negotiation begins.

## Hosted-Peer Architecture

This milestone removes the dedicated central signaling server from normal use.

- Every Electron instance contains both client behavior and host behavior.
- The room creator is the temporary host.
- The host app starts a local ws room-coordination service from the Electron main process.
- Guests connect directly to that host service using host address + port + room ID.
- The host is also a participant in the WebRTC chat.
- Max room size stays at 2 peers: one host and one guest.
- There is no host migration.
- When the host leaves, the room ends.

## How One Node Acts as Both Server and Client

The Electron main process owns the local ws server and exposes a minimal preload bridge for room lifecycle control.

- `startHostService(port?)` starts the host-owned ws service.
- `stopHostService()` stops it and frees the port.
- `getHostServiceStatus()` returns the current host-service state.
- `getLocalNetworkInfo()` returns local IP candidates for sharing a room on the LAN.

The renderer still uses the normal WebSocket client API. When the user creates a room, the renderer first asks Electron main to start the host service, then connects to `ws://127.0.0.1:<port>` and sends `create-room`. When a guest joins, the renderer connects directly to the host's ws endpoint and sends `join-room`.

## Create Room Flow

The host enters display name, room ID, and optional port, then clicks **Create Room**.

1. The Electron main process starts the local ws service.
2. The renderer connects to the local service.
3. The host sends `create-room`.
4. The service records the host as the room creator and returns room state.
5. The UI shows the room as open and waiting for a guest.
6. The host shares the address, port, and room ID with the guest.

## Join Room Flow

The guest enters display name, host address, host port, and room ID, then clicks **Join Room**.

1. The renderer opens a WebSocket connection directly to the host service.
2. The guest sends `join-room`.
3. The host validates that the room exists, is active, and has capacity.
4. The service adds the guest, broadcasts the room state, and relays WebRTC signaling.
5. The initiator is chosen deterministically from peer IDs so only one side sends the offer.

## How Host Shutdown Works

If the host clicks **End Room** or closes the app:

1. The host service sends `room-closed` to the connected peer.
2. The guest tears down WebRTC state and returns to a disconnected state.
3. The host service stops and releases the port.
4. If the host disappears unexpectedly, the guest sees the WebSocket disconnect and cleans up.

## NPM Scripts

### Root

- `npm run install:all` - install client dependencies
- `npm run dev:client` - run renderer + Electron together for one instance
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
- There is no automatic discovery or NAT traversal.
- Guests must manually enter the host address, port, and room ID.
- This milestone assumes either localhost testing or a manually reachable LAN host.
- Workspace sync, file transfer, and larger multi-peer topologies are not implemented yet.