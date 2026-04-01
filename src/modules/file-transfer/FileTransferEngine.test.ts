import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileMetadata } from '../../models/types';
import {
    ChunkedFileTransferEngine,
    InMemoryFileTransferTransport,
    type FileTransferMessage,
    type FileTransferProgress,
    type FileTransferTransport,
    type FileTransferTransportEnvelope,
} from './FileTransferEngine';

describe('ChunkedFileTransferEngine', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('transfers files incrementally with verified reconstruction', async () => {
    const transport = new InMemoryFileTransferTransport();

    const senderEngine = new ChunkedFileTransferEngine({
      localPeerId: 'peer-a',
      transport,
      chunkSizeBytes: 64 * 1024,
    });
    const receiverEngine = new ChunkedFileTransferEngine({
      localPeerId: 'peer-b',
      transport,
      chunkSizeBytes: 64 * 1024,
    });

    const senderEvents: FileTransferProgress[] = [];
    const receiverEvents: FileTransferProgress[] = [];
    senderEngine.onTransferProgress((event) => senderEvents.push(event));
    receiverEngine.onTransferProgress((event) => receiverEvents.push(event));

    const fileBytes = makePatternBytes(1024 * 1024 + 12345);
    const fileMetadata: FileMetadata = {
      id: 'file-1',
      fileName: 'large.bin',
      filePath: '/workspace/shared/large.bin',
      sizeBytes: fileBytes.byteLength,
      checksum: 'abc123',
      mimeType: 'application/octet-stream',
      createdAt: new Date().toISOString(),
    };

    const session = await senderEngine.startTransfer({
      roomId: 'room-1',
      senderPeerId: 'peer-a',
      receiverPeerId: 'peer-b',
      file: fileMetadata,
      fileBytes,
    });

    await waitFor(
      () =>
        senderEvents.some((event) => event.session.id === session.id && event.status === 'completed')
        && receiverEvents.some((event) => event.session.id === session.id && event.status === 'completed'),
      2000,
    );

    const receivedBytes = receiverEngine.getReceivedFileBytes(session.id);
    expect(receivedBytes).not.toBeNull();
    expect(receivedBytes?.byteLength).toBe(fileBytes.byteLength);
    expect(Array.from(receivedBytes ?? [])).toEqual(Array.from(fileBytes));

    const senderChunkEvents = senderEvents.filter(
      (event) => event.session.id === session.id && event.direction === 'send',
    );
    expect(senderChunkEvents.some((event) => event.completedChunks > 1)).toBe(true);
    expect(senderChunkEvents[senderChunkEvents.length - 1]?.status).toBe('completed');

    senderEngine.dispose();
    receiverEngine.dispose();
  });

  it('recovers from a dropped chunk response', async () => {
    const transport = createFaultInjectingTransport({
      dropChunkResponseOnce: 2,
    });

    const senderEngine = new ChunkedFileTransferEngine({
      localPeerId: 'peer-a',
      transport,
      chunkSizeBytes: 64 * 1024,
    });
    const receiverEngine = new ChunkedFileTransferEngine({
      localPeerId: 'peer-b',
      transport,
      chunkSizeBytes: 64 * 1024,
    });

    const fileBytes = makePatternBytes(512 * 1024 + 17);
    const fileMetadata: FileMetadata = {
      id: 'file-2',
      fileName: 'missing-chunk.bin',
      filePath: '/workspace/shared/missing-chunk.bin',
      sizeBytes: fileBytes.byteLength,
      checksum: 'abc123',
      mimeType: 'application/octet-stream',
      createdAt: new Date().toISOString(),
    };

    const session = await senderEngine.startTransfer({
      roomId: 'room-1',
      senderPeerId: 'peer-a',
      receiverPeerId: 'peer-b',
      file: fileMetadata,
      fileBytes,
    });

    await waitFor(() => receiverEngine.getReceivedFileBytes(session.id) !== null, 3000);

    const receivedBytes = receiverEngine.getReceivedFileBytes(session.id);
    expect(receivedBytes).not.toBeNull();
    expect(Array.from(receivedBytes ?? [])).toEqual(Array.from(fileBytes));
    expect(transport.droppedChunkResponses).toBe(1);

    senderEngine.dispose();
    receiverEngine.dispose();
  });

  it('detects corrupted chunk responses and retries them', async () => {
    const transport = createFaultInjectingTransport({
      corruptChunkResponseOnce: 1,
    });

    const senderEngine = new ChunkedFileTransferEngine({
      localPeerId: 'peer-a',
      transport,
      chunkSizeBytes: 32 * 1024,
    });
    const receiverEngine = new ChunkedFileTransferEngine({
      localPeerId: 'peer-b',
      transport,
      chunkSizeBytes: 32 * 1024,
    });

    const fileBytes = makePatternBytes(256 * 1024 + 11);
    const fileMetadata: FileMetadata = {
      id: 'file-3',
      fileName: 'corrupted-chunk.bin',
      filePath: '/workspace/shared/corrupted-chunk.bin',
      sizeBytes: fileBytes.byteLength,
      checksum: 'abc123',
      mimeType: 'application/octet-stream',
      createdAt: new Date().toISOString(),
    };

    const session = await senderEngine.startTransfer({
      roomId: 'room-1',
      senderPeerId: 'peer-a',
      receiverPeerId: 'peer-b',
      file: fileMetadata,
      fileBytes,
    });

    await waitFor(
      () =>
        receiverEngine.getReceivedFileBytes(session.id) !== null
        && transport.corruptedChunkResponses === 1,
      2000,
    );

    const receivedBytes = receiverEngine.getReceivedFileBytes(session.id);
    expect(receivedBytes).not.toBeNull();
    expect(Array.from(receivedBytes ?? [])).toEqual(Array.from(fileBytes));

    senderEngine.dispose();
    receiverEngine.dispose();
  });
});

interface FaultInjectionOptions {
  dropChunkResponseOnce?: number;
  corruptChunkResponseOnce?: number;
}

function createFaultInjectingTransport(options: FaultInjectionOptions): FileTransferTransport & {
  droppedChunkResponses: number;
  corruptedChunkResponses: number;
} {
  const listeners = new Set<(envelope: FileTransferTransportEnvelope) => void>();
  let droppedChunkResponses = 0;
  let corruptedChunkResponses = 0;
  let dropRemaining = options.dropChunkResponseOnce !== undefined ? 1 : 0;
  let corruptRemaining = options.corruptChunkResponseOnce !== undefined ? 1 : 0;

  return {
    get droppedChunkResponses(): number {
      return droppedChunkResponses;
    },
    get corruptedChunkResponses(): number {
      return corruptedChunkResponses;
    },
    async send(roomId: string, _toPeerId: string, message: FileTransferMessage): Promise<void> {
      if (message.type === 'chunk-response') {
        if (options.dropChunkResponseOnce === message.chunkIndex && dropRemaining > 0) {
          dropRemaining -= 1;
          droppedChunkResponses += 1;
          return;
        }

        if (options.corruptChunkResponseOnce === message.chunkIndex && corruptRemaining > 0) {
          corruptRemaining -= 1;
          corruptedChunkResponses += 1;
          const corrupted = corruptBase64(message.chunkDataBase64);
          message = {
            ...message,
            chunkDataBase64: corrupted,
          };
        }
      }

      const envelope: FileTransferTransportEnvelope = { roomId, message };
      for (const listener of listeners) {
        listener(envelope);
      }
    },
    subscribe(handler: (envelope: FileTransferTransportEnvelope) => void): () => void {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}

function corruptBase64(base64: string): string {
  if (typeof Buffer !== 'undefined') {
    const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
    if (bytes.length > 0) {
      bytes[0] = bytes[0] ^ 0xff;
    }
    return Buffer.from(bytes).toString('base64');
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  if (bytes.length > 0) {
    bytes[0] = bytes[0] ^ 0xff;
  }
  let corrupted = '';
  for (const byte of bytes) {
    corrupted += String.fromCharCode(byte);
  }
  return btoa(corrupted);
}

function makePatternBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = i % 251;
  }
  return bytes;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('Timed out waiting for transfer completion.');
}
