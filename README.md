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

## Repository Structure

- `electron/` - Electron main process and preload bridge.
- `src/layout/` - Shared app shell layout.
- `src/pages/` - Placeholder screens for core flows.
- `src/routes/` - Route mapping.
- `src/modules/ui/` - UI-specific reusable components.
- `src/modules/room-peer/` - Room and peer manager contracts.
- `src/modules/networking/` - Networking contracts and placeholder adapter.
- `src/modules/workspace-sync/` - Workspace synchronization service abstractions.
- `src/modules/file-transfer/` - Transfer engine abstractions.
- `src/modules/security/` - Security/auth abstractions.
- `src/modules/testing/` - Evaluation helpers and test-focused utilities.
- `src/models/` - Shared TypeScript domain models.

## Domain Models Included

- `Room`
- `Peer`
- `WorkspaceState`
- `FileMetadata`
- `AuthPayload`
- `TransferSession`

Defined in `src/models/types.ts`.

## Placeholder Screens Included

- Landing page
- Create room
- Discover room
- Join room
- Workspace view
- Shared file panel
- Peer presence panel

## Local Development

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

## Tooling

- TypeScript for type-safe modules.
- Vite for renderer build and dev server.
- Tailwind CSS for utility-based styling.
- ESLint + Prettier for linting and formatting.
- Vitest script scaffold for test/evaluation workflow.

## Current Module Responsibilities

- `ui`: Presentation shell and route placeholders.
- `room-peer`: Room membership and lifecycle interfaces.
- `networking`: Signaling transport contract boundaries.
- `workspace-sync`: Workspace state persistence and broadcast APIs.
- `file-transfer`: Session management for shared files.
- `security`: Auth payload issue/verify abstraction.
- `testing`: Evaluation summary and future quality gates.
