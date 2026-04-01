# Vir Space

Vir Space is a desktop-based peer-to-peer multi-user virtual remote workspace scaffold. This repository provides the first project foundation with a runnable Electron + React + Tailwind shell and clear module boundaries for networking, room management, synchronization, file transfer, security, and evaluation.

## Purpose

The app is intended to evolve into a secure desktop collaboration workspace where peers can create or join rooms, share workspace state in near real-time, and transfer files directly across peers with policy and auth controls.

## High-Level Architecture

- **Desktop shell**: Electron main and preload process host the app window and native runtime boundary.
- **UI layer**: React + Tailwind UI for routes and feature panels.
- **Room/peer manager**: Room lifecycle and peer membership abstractions.
- **Networking layer**: Signaling/data-plane abstraction for peer transport.
- **Workspace-sync service**: Shared workspace state APIs and subscriptions.
- **File transfer engine**: File metadata and transfer session flow.
- **Security layer**: Auth payload signing and validation interfaces.
- **Testing/evaluation**: Placeholder testing summary utilities and test scripts.

### Prerequisites

- Node.js 20+
- npm 10+

### Install

```bash
npm install
```

### Run in Development (Electron + Vite)

```bash
npm run dev
```

If port 5173 is already in use:

```bash
lsof -ti tcp:5173 | xargs -r kill -9
npm run dev
```

### Build for Production

```bash
npm run build
```

### Launch Built Desktop Shell

```bash
npm run start
```

### Optional Packaging

```bash
npm run package:desktop
```