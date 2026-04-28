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
- Room Discovery: WebSocket, TypeScript, Node.js, http

## Installation Instructions
### Prerequisites
- Node.js 20+
- npm 10+
### Executable
- Download either "VIR Space 0.1.0.exe" or "VIR Space Setup 0.1.0.exe"
  - Either will work, but the setup executable will install application files to your disk

## Usage
### Join a VPN
Join the GT VPN for correct relay server discovery. Make sure you and your peers are on the same gateway (DC, NI, ... etc)

### Run the executable

To run:
Double-click on the downloaded executable

*Note*: Please give the application a few minutes to start while it scans for relay servers.

### Application Functions
- Enter Name: your display name
- Create Room: creates a room at your IP
- Join Room: manually join a room through IP + Room ID + password, or check room discovery panel
- Chatroom: send messages
- Whiteboard: shared drawings
- Shared Text Editor: collaborative text editor
- File Transfer: send and receive files from peers in the same room
- Transfer Ownership: changes the host of the room to another person

## Run it manually in your terminal (dev mode):

### Clone repo
```bash
git clone https://github.com/ajiang4138/vir-space.git
```

```bash
cd vir-space
```

```bash
npm run install:all
```

```bash
npm run dev
```

### Test the Build

```bash
npm run build
```

## Authors
- Author: Allen Jiang, Jonathan Liang, Alyn Kosasi, Calvin Cheah, Yu Lin Lu, Zi Hang Lin
- Project Link: <https://github.com/ajiang4138/vir-space>
