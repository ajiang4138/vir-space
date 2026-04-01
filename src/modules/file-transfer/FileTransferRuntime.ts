import {
  ChunkedFileTransferEngine,
  type FileTransferMessage,
  type FileTransferTransport,
  type FileTransferTransportEnvelope,
} from './FileTransferEngine';

const TRANSFER_CHANNEL_PREFIX = 'vir-space:file-transfer:';
const TRANSFER_STORAGE_PREFIX = 'vir-space:file-transfer:event:';

interface WireEnvelope {
  roomId: string;
  toPeerId: string;
  message: FileTransferMessage;
}

class BrowserBroadcastFileTransferTransport implements FileTransferTransport {
  private readonly channels = new Map<string, BroadcastChannel>();
  private readonly listeners = new Set<(envelope: FileTransferTransportEnvelope) => void>();
  private readonly localPeerId: string;
  private readonly hasWindow = typeof window !== 'undefined';
  private storageListenerRegistered = false;

  constructor(localPeerId: string) {
    this.localPeerId = localPeerId;
    this.setupStorageListener();
  }

  async send(roomId: string, toPeerId: string, message: FileTransferMessage): Promise<void> {
    if (!this.hasWindow) {
      return;
    }

    const envelope: WireEnvelope = {
      roomId,
      toPeerId,
      message,
    };

    const channel = this.ensureRoomChannel(roomId);
    channel?.postMessage(envelope);

    try {
      window.localStorage.setItem(
        `${TRANSFER_STORAGE_PREFIX}${roomId}`,
        JSON.stringify({ ...envelope, emittedAt: Date.now() }),
      );
    } catch {
      // localStorage can be unavailable in sandboxed contexts.
    }
  }

  subscribe(handler: (envelope: FileTransferTransportEnvelope) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  private ensureRoomChannel(roomId: string): BroadcastChannel | null {
    if (!this.hasWindow || typeof BroadcastChannel === 'undefined') {
      return null;
    }

    const existing = this.channels.get(roomId);
    if (existing) {
      return existing;
    }

    const channel = new BroadcastChannel(`${TRANSFER_CHANNEL_PREFIX}${roomId}`);
    channel.onmessage = (event: MessageEvent<WireEnvelope>) => {
      this.handleEnvelope(event.data);
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
      if (!event.key.startsWith(TRANSFER_STORAGE_PREFIX)) {
        return;
      }

      try {
        const envelope = JSON.parse(event.newValue) as WireEnvelope;
        this.handleEnvelope(envelope);
      } catch {
        // Ignore malformed cross-tab messages.
      }
    });

    this.storageListenerRegistered = true;
  }

  private handleEnvelope(envelope: WireEnvelope): void {
    if (!envelope || envelope.toPeerId !== this.localPeerId) {
      return;
    }

    for (const listener of this.listeners) {
      listener({
        roomId: envelope.roomId,
        message: envelope.message,
      });
    }
  }
}

let singletonEngine: ChunkedFileTransferEngine | null = null;
let singletonPeerId: string | null = null;

export function getFileTransferEngine(localPeerId: string): ChunkedFileTransferEngine {
  if (!singletonEngine || singletonPeerId !== localPeerId) {
    singletonEngine?.dispose();
    const transport = new BrowserBroadcastFileTransferTransport(localPeerId);
    singletonEngine = new ChunkedFileTransferEngine({
      localPeerId,
      transport,
    });
    singletonPeerId = localPeerId;
  }

  return singletonEngine;
}
