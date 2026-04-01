import type { FileChunkInfo, SharedFileMetadata } from '../../models/types';

const DIRECTORY_STORAGE_PREFIX = 'vir-space:shared-directory:';
const DIRECTORY_EVENT_PREFIX = 'vir-space:shared-directory:event:';

type DirectoryMessageType =
  | 'file-announcement'
  | 'file-removal'
  | 'file-request'
  | 'snapshot-request'
  | 'snapshot';

export interface SharedFileAnnouncementInput {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  mimeType: string;
  checksum: string;
  fileHash: string;
  chunkInfo: FileChunkInfo;
  createdAt?: string;
  id?: string;
}

export interface DirectorySyncMessage {
  type: DirectoryMessageType;
  roomId: string;
  fromPeerId: string;
  logicalTimestamp: number;
  directoryVersion: number;
  targetPeerId?: string;
  file?: SharedFileMetadata;
  fileId?: string;
  files?: SharedFileMetadata[];
}

interface DirectoryRoomState {
  roomId: string;
  files: Map<string, SharedFileMetadata>;
  tombstones: Map<string, number>;
  logicalClock: number;
  directoryVersion: number;
}

type DirectoryListener = (roomId: string, files: SharedFileMetadata[]) => void;
type FileRequestListener = (roomId: string, request: { fileId: string; fromPeerId: string; targetPeerId: string }) => void;

interface SharedDirectorySnapshot {
  roomId: string;
  logicalClock: number;
  directoryVersion: number;
  files: SharedFileMetadata[];
  tombstones?: Record<string, number>;
}

export class SharedFileDirectorySync {
  private readonly rooms = new Map<string, DirectoryRoomState>();
  private readonly listeners = new Set<DirectoryListener>();
  private readonly fileRequestListeners = new Set<FileRequestListener>();
  private readonly channels = new Map<string, BroadcastChannel>();
  private readonly hasWindow = typeof window !== 'undefined';
  private readonly selfPeerIdsByRoom = new Map<string, string>();
  private storageListenerRegistered = false;

  constructor(
    private readonly onSend?: (message: DirectorySyncMessage) => void,
  ) {
    this.setupStorageListener();
  }

  joinRoom(roomId: string, peerId: string): void {
    this.selfPeerIdsByRoom.set(roomId, peerId);
    this.ensureRoomState(roomId);
    this.ensureRoomChannel(roomId);
    this.logRecoveryEvent('join-room', { roomId, peerId });
    this.requestSnapshot(roomId, peerId);
  }

  requestSnapshot(roomId: string, peerId: string): void {
    const state = this.ensureRoomState(roomId);
    this.logRecoveryEvent('snapshot-requested', {
      roomId,
      peerId,
      localVersion: state.directoryVersion,
    });
    this.sendMessage({
      type: 'snapshot-request',
      roomId,
      fromPeerId: peerId,
      logicalTimestamp: state.logicalClock,
      directoryVersion: state.directoryVersion,
    });
  }

  announceFile(
    roomId: string,
    peerId: string,
    input: SharedFileAnnouncementInput,
  ): SharedFileMetadata {
    const state = this.ensureRoomState(roomId);
    state.logicalClock = this.nextClock(state.logicalClock);
    state.directoryVersion += 1;

    const nowIso = new Date().toISOString();
    const file: SharedFileMetadata = {
      id: input.id ?? crypto.randomUUID(),
      fileName: input.fileName,
      filePath: input.filePath,
      sizeBytes: input.sizeBytes,
      checksum: input.checksum,
      mimeType: input.mimeType,
      createdAt: input.createdAt ?? nowIso,
      fileHash: input.fileHash,
      chunkInfo: input.chunkInfo,
      version: 1,
      logicalTimestamp: state.logicalClock,
      updatedAt: nowIso,
      announcedByPeerId: peerId,
    };

    const knownDeleteTimestamp = state.tombstones.get(file.id);
    if (knownDeleteTimestamp !== undefined && knownDeleteTimestamp >= file.logicalTimestamp) {
      this.logRecoveryEvent('announcement-skipped-by-tombstone', {
        roomId,
        fileId: file.id,
        knownDeleteTimestamp,
        incomingTimestamp: file.logicalTimestamp,
      });
      return file;
    }

    state.tombstones.delete(file.id);

    this.upsertFile(state, file);
    this.persistRoomState(state);
    this.emitDirectoryUpdate(roomId);

    this.sendMessage({
      type: 'file-announcement',
      roomId,
      fromPeerId: peerId,
      logicalTimestamp: state.logicalClock,
      directoryVersion: state.directoryVersion,
      file,
    });

    return file;
  }

  removeFile(roomId: string, peerId: string, fileId: string): void {
    const state = this.ensureRoomState(roomId);
    if (!state.files.has(fileId)) {
      return;
    }

    state.logicalClock = this.nextClock(state.logicalClock);
    state.directoryVersion += 1;
    state.files.delete(fileId);
    state.tombstones.set(fileId, state.logicalClock);

    this.persistRoomState(state);
    this.emitDirectoryUpdate(roomId);

    this.sendMessage({
      type: 'file-removal',
      roomId,
      fromPeerId: peerId,
      fileId,
      logicalTimestamp: state.logicalClock,
      directoryVersion: state.directoryVersion,
    });
  }

  requestFile(roomId: string, fromPeerId: string, targetPeerId: string, fileId: string): void {
    const state = this.ensureRoomState(roomId);
    state.logicalClock = this.nextClock(state.logicalClock);

    this.sendMessage({
      type: 'file-request',
      roomId,
      fromPeerId,
      targetPeerId,
      fileId,
      logicalTimestamp: state.logicalClock,
      directoryVersion: state.directoryVersion,
    });
  }

  receiveMessage(message: DirectorySyncMessage): void {
    const state = this.ensureRoomState(message.roomId);
    state.logicalClock = Math.max(state.logicalClock, message.logicalTimestamp);
    state.directoryVersion = Math.max(state.directoryVersion, message.directoryVersion);

    switch (message.type) {
      case 'file-announcement':
        if (message.file) {
          const knownDeleteTimestamp = state.tombstones.get(message.file.id);
          if (
            knownDeleteTimestamp === undefined
            || message.file.logicalTimestamp > knownDeleteTimestamp
          ) {
            if (this.upsertFile(state, message.file)) {
              state.tombstones.delete(message.file.id);
              this.persistRoomState(state);
              this.emitDirectoryUpdate(message.roomId);
            }
          } else {
            this.logRecoveryEvent('announcement-ignored-stale', {
              roomId: message.roomId,
              fileId: message.file.id,
              knownDeleteTimestamp,
              incomingTimestamp: message.file.logicalTimestamp,
            });
          }
        }
        break;
      case 'file-removal':
        if (message.fileId) {
          const current = state.files.get(message.fileId);
          if (!current || message.logicalTimestamp >= current.logicalTimestamp) {
            state.files.delete(message.fileId);
            state.tombstones.set(
              message.fileId,
              Math.max(state.tombstones.get(message.fileId) ?? 0, message.logicalTimestamp),
            );
            this.persistRoomState(state);
            this.emitDirectoryUpdate(message.roomId);
          }
        }
        break;
      case 'file-request': {
        const selfPeerId = this.selfPeerIdsByRoom.get(message.roomId);
        if (
          !selfPeerId
          || !message.fileId
          || !message.targetPeerId
          || message.targetPeerId !== selfPeerId
        ) {
          return;
        }

        this.emitFileRequest(message.roomId, {
          fileId: message.fileId,
          fromPeerId: message.fromPeerId,
          targetPeerId: message.targetPeerId,
        });
        break;
      }
      case 'snapshot-request': {
        const selfPeerId = this.selfPeerIdsByRoom.get(message.roomId);
        if (!selfPeerId || message.fromPeerId === selfPeerId) {
          return;
        }

        this.sendMessage({
          type: 'snapshot',
          roomId: message.roomId,
          fromPeerId: selfPeerId,
          logicalTimestamp: state.logicalClock,
          directoryVersion: state.directoryVersion,
          files: this.getDirectory(message.roomId),
        });
        break;
      }
      case 'snapshot':
        this.logRecoveryEvent('snapshot-received', {
          roomId: message.roomId,
          fileCount: (message.files ?? []).length,
        });
        this.mergeSnapshot(message.roomId, message.files ?? []);
        break;
      default:
        break;
    }
  }

  mergeSnapshot(roomId: string, files: SharedFileMetadata[]): void {
    const state = this.ensureRoomState(roomId);
    let changed = false;

    for (const file of files) {
      const knownDeleteTimestamp = state.tombstones.get(file.id);
      if (
        knownDeleteTimestamp !== undefined
        && file.logicalTimestamp <= knownDeleteTimestamp
      ) {
        continue;
      }

      if (this.upsertFile(state, file)) {
        changed = true;
      }
      state.logicalClock = Math.max(state.logicalClock, file.logicalTimestamp);
    }

    if (changed) {
      state.directoryVersion += 1;
      this.persistRoomState(state);
      this.emitDirectoryUpdate(roomId);
    }
  }

  getDirectory(roomId: string): SharedFileMetadata[] {
    const state = this.ensureRoomState(roomId);
    return Array.from(state.files.values()).sort((a, b) => {
      if (a.fileName === b.fileName) {
        return a.id.localeCompare(b.id);
      }
      return a.fileName.localeCompare(b.fileName);
    });
  }

  onDirectoryChanged(listener: DirectoryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onFileRequest(listener: FileRequestListener): () => void {
    this.fileRequestListeners.add(listener);
    return () => {
      this.fileRequestListeners.delete(listener);
    };
  }

  resynchronizeRoom(roomId: string, peerId: string, reason: string = 'manual-resync'): void {
    this.logRecoveryEvent('room-resync-requested', { roomId, peerId, reason });
    this.requestSnapshot(roomId, peerId);
  }

  handlePeerReconnected(roomId: string, peerId: string): void {
    this.logRecoveryEvent('peer-reconnected', { roomId, peerId });
    this.requestSnapshot(roomId, peerId);
  }

  getRoomRecoveryStatus(roomId: string): {
    roomId: string;
    fileCount: number;
    tombstoneCount: number;
    logicalClock: number;
    directoryVersion: number;
  } {
    const state = this.ensureRoomState(roomId);
    return {
      roomId,
      fileCount: state.files.size,
      tombstoneCount: state.tombstones.size,
      logicalClock: state.logicalClock,
      directoryVersion: state.directoryVersion,
    };
  }

  private ensureRoomState(roomId: string): DirectoryRoomState {
    const existing = this.rooms.get(roomId);
    if (existing) {
      return existing;
    }

    const loaded = this.loadRoomState(roomId);
    if (loaded) {
      this.rooms.set(roomId, loaded);
      return loaded;
    }

    const initialState: DirectoryRoomState = {
      roomId,
      files: new Map(),
      tombstones: new Map(),
      logicalClock: 0,
      directoryVersion: 0,
    };
    this.rooms.set(roomId, initialState);
    return initialState;
  }

  private upsertFile(state: DirectoryRoomState, incoming: SharedFileMetadata): boolean {
    const existing = state.files.get(incoming.id);
    if (!existing || this.shouldReplace(existing, incoming)) {
      state.files.set(incoming.id, incoming);
      return true;
    }
    return false;
  }

  private shouldReplace(current: SharedFileMetadata, incoming: SharedFileMetadata): boolean {
    if (incoming.logicalTimestamp !== current.logicalTimestamp) {
      return incoming.logicalTimestamp > current.logicalTimestamp;
    }
    if (incoming.version !== current.version) {
      return incoming.version > current.version;
    }
    return incoming.updatedAt > current.updatedAt;
  }

  private nextClock(current: number): number {
    return current + 1;
  }

  private emitDirectoryUpdate(roomId: string): void {
    const files = this.getDirectory(roomId);
    for (const listener of this.listeners) {
      listener(roomId, files);
    }
  }

  private emitFileRequest(
    roomId: string,
    request: { fileId: string; fromPeerId: string; targetPeerId: string },
  ): void {
    for (const listener of this.fileRequestListeners) {
      listener(roomId, request);
    }
  }

  private sendMessage(message: DirectorySyncMessage): void {
    this.onSend?.(message);

    if (!this.hasWindow) {
      return;
    }

    const channel = this.ensureRoomChannel(message.roomId);
    channel?.postMessage(message);

    try {
      window.localStorage.setItem(
        `${DIRECTORY_EVENT_PREFIX}${message.roomId}`,
        JSON.stringify({ ...message, emittedAt: Date.now() }),
      );
    } catch {
      // no-op: localStorage might be unavailable in sandboxed contexts
    }
  }

  private ensureRoomChannel(roomId: string): BroadcastChannel | null {
    if (!this.hasWindow || typeof BroadcastChannel === 'undefined') {
      return null;
    }

    const existing = this.channels.get(roomId);
    if (existing) {
      return existing;
    }

    const channel = new BroadcastChannel(`${DIRECTORY_EVENT_PREFIX}${roomId}`);
    channel.onmessage = (event: MessageEvent<DirectorySyncMessage>) => {
      if (!event.data || typeof event.data !== 'object') {
        return;
      }
      this.receiveMessage(event.data);
    };

    this.channels.set(roomId, channel);
    return channel;
  }

  private setupStorageListener(): void {
    if (!this.hasWindow || this.storageListenerRegistered) {
      return;
    }

    window.addEventListener('storage', (event: StorageEvent) => {
      if (!event.key || !event.newValue) {
        return;
      }
      if (!event.key.startsWith(DIRECTORY_EVENT_PREFIX)) {
        return;
      }

      try {
        const message = JSON.parse(event.newValue) as DirectorySyncMessage;
        this.receiveMessage(message);
      } catch {
        // Ignore malformed cross-tab messages
      }
    });

    this.storageListenerRegistered = true;
  }

  private persistRoomState(state: DirectoryRoomState): void {
    if (!this.hasWindow) {
      return;
    }

    const snapshot: SharedDirectorySnapshot = {
      roomId: state.roomId,
      logicalClock: state.logicalClock,
      directoryVersion: state.directoryVersion,
      files: Array.from(state.files.values()),
      tombstones: Object.fromEntries(state.tombstones.entries()),
    };

    try {
      window.localStorage.setItem(
        `${DIRECTORY_STORAGE_PREFIX}${state.roomId}`,
        JSON.stringify(snapshot),
      );
    } catch {
      // no-op: localStorage might be unavailable in sandboxed contexts
    }
  }

  private loadRoomState(roomId: string): DirectoryRoomState | null {
    if (!this.hasWindow) {
      return null;
    }

    try {
      const raw = window.localStorage.getItem(`${DIRECTORY_STORAGE_PREFIX}${roomId}`);
      if (!raw) {
        return null;
      }

      const snapshot = JSON.parse(raw) as SharedDirectorySnapshot;
      return {
        roomId,
        logicalClock: snapshot.logicalClock,
        directoryVersion: snapshot.directoryVersion,
        files: new Map((snapshot.files ?? []).map((file) => [file.id, file])),
        tombstones: new Map(Object.entries(snapshot.tombstones ?? {}).map(([key, value]) => [key, Number(value)])),
      };
    } catch {
      return null;
    }
  }

  private logRecoveryEvent(event: string, details: Record<string, unknown>): void {
    console.info('[SharedFileDirectoryRecovery]', event, details);
  }
}

let sharedFileDirectorySyncSingleton: SharedFileDirectorySync | null = null;

export function getSharedFileDirectorySync(): SharedFileDirectorySync {
  if (!sharedFileDirectorySyncSingleton) {
    sharedFileDirectorySyncSingleton = new SharedFileDirectorySync();
  }
  return sharedFileDirectorySyncSingleton;
}
