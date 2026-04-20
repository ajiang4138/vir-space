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
- Relay server for room discovery on the same network

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
cd vir-space
npm run install:all
```

## Usage
### Join a VPN
Join the GT VPN for correct relay server discovery. Make sure you and your peers are on the same gateway (DC, Ni, ... etc)

### Run the desktop client

```bash
cd vir-space
npm run dev
```

### Test the Build

```bash
cd vir-space
npm run build
```

## Demo
Pending!

## Authors
- Author: Allen Jiang, Jonathan Liang, Alyn Kosasi, Calvin Cheah, Yu Lin Lu, Zi Hang Lin
- Project Link: <https://github.com/ajiang4138/vir-space>
