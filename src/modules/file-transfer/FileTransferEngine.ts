import type { FileMetadata, TransferSession } from '../../models/types';

const DEFAULT_CHUNK_SIZE_BYTES = 64 * 1024;
const MAX_CHUNK_RETRY_ATTEMPTS = 3;
const CHUNK_RETRY_DELAY_MS = 25;

export type FileTransferDirection = 'send' | 'receive';

export type FileTransferStatus = TransferSession['status'] | 'canceled';

export type FileTransferVerificationStatus = 'pending' | 'verified' | 'failed';

export interface FileTransferProgress {
  session: TransferSession;
  direction: FileTransferDirection;
  bytesTransferred: number;
  totalBytes: number;
  completedChunks: number;
  totalChunks: number;
  status: FileTransferStatus;
  verificationStatus?: FileTransferVerificationStatus;
  error?: string;
}

export type FileTransferMessage =
  | {
      type: 'transfer-offer';
      transferId: string;
      fromPeerId: string;
      toPeerId: string;
      file: FileMetadata;
      fileHash: string;
      totalChunks: number;
      chunkSizeBytes: number;
      chunkHashes: string[];
    }
  | {
      type: 'chunk-request';
      transferId: string;
      fromPeerId: string;
      toPeerId: string;
      chunkIndex: number;
    }
  | {
      type: 'chunk-response';
      transferId: string;
      fromPeerId: string;
      toPeerId: string;
      chunkIndex: number;
      chunkDataBase64: string;
    }
  | {
      type: 'transfer-complete';
      transferId: string;
      fromPeerId: string;
      toPeerId: string;
      receivedBytes: number;
    }
  | {
      type: 'transfer-cancel';
      transferId: string;
      fromPeerId: string;
      toPeerId: string;
      reason?: string;
    }
  | {
      type: 'transfer-error';
      transferId: string;
      fromPeerId: string;
      toPeerId: string;
      error: string;
    };

export interface FileTransferTransportEnvelope {
  roomId: string;
  message: FileTransferMessage;
}

export interface FileTransferTransport {
  send(roomId: string, toPeerId: string, message: FileTransferMessage): Promise<void>;
  subscribe(handler: (envelope: FileTransferTransportEnvelope) => void): () => void;
}

export interface StartTransferInput {
  roomId: string;
  receiverPeerId: string;
  senderPeerId: string;
  file: FileMetadata;
  fileBytes: Uint8Array;
  chunkSizeBytes?: number;
}

interface FileTransferEngineOptions {
  localPeerId: string;
  transport: FileTransferTransport;
  chunkSizeBytes?: number;
}

interface OutboundTransferState {
  transferId: string;
  roomId: string;
  receiverPeerId: string;
  senderPeerId: string;
  file: FileMetadata;
  chunkSizeBytes: number;
  totalChunks: number;
  chunks: Uint8Array[];
  chunkHashes: string[];
  sentChunks: Set<number>;
  sentBytes: number;
}

interface InboundTransferState {
  transferId: string;
  roomId: string;
  senderPeerId: string;
  receiverPeerId: string;
  file: FileMetadata;
  chunkSizeBytes: number;
  totalChunks: number;
  expectedFileHash: string;
  chunkHashes: string[];
  requestedChunks: Set<number>;
  chunks: Map<number, Uint8Array>;
  receivedBytes: number;
  chunkRetryAttempts: Map<number, number>;
  chunkRetryTimers: Map<number, ReturnType<typeof setTimeout>>;
  verificationStatus: FileTransferVerificationStatus;
}

interface TransferRecoveryStatus {
  transferId: string;
  roomId: string;
  remotePeerId: string;
  direction: FileTransferDirection;
  status: FileTransferStatus;
  missingChunks: number;
}

export interface FileTransferEngine {
  startTransfer(input: StartTransferInput): Promise<TransferSession>;
  cancelTransfer(sessionId: string): Promise<void>;
  onTransferProgress(listener: (progress: FileTransferProgress) => void): () => void;
  getReceivedFileBytes(sessionId: string): Uint8Array | null;
}

export class ChunkedFileTransferEngine implements FileTransferEngine {
  private readonly sessionMap = new Map<string, TransferSession>();
  private readonly outboundTransfers = new Map<string, OutboundTransferState>();
  private readonly inboundTransfers = new Map<string, InboundTransferState>();
  private readonly receivedFileBytes = new Map<string, Uint8Array>();
  private readonly listeners = new Set<(progress: FileTransferProgress) => void>();
  private readonly localPeerId: string;
  private readonly transport: FileTransferTransport;
  private readonly defaultChunkSizeBytes: number;
  private readonly unsubscribe: () => void;
  private readonly disconnectedPeers = new Set<string>();

  constructor(options: FileTransferEngineOptions) {
    this.localPeerId = options.localPeerId;
    this.transport = options.transport;
    this.defaultChunkSizeBytes = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
    this.unsubscribe = this.transport.subscribe((envelope) => {
      void this.handleIncomingEnvelope(envelope);
    });
  }

  async startTransfer(input: StartTransferInput): Promise<TransferSession> {
    const transferId = crypto.randomUUID();
    const chunkSizeBytes = Math.max(1024, input.chunkSizeBytes ?? this.defaultChunkSizeBytes);
    const chunks = chunkBytes(input.fileBytes, chunkSizeBytes);
    const chunkHashes = await Promise.all(chunks.map((chunk) => computeHashHex(chunk)));
    const fileHash = await computeHashHex(input.fileBytes);
    const file = {
      ...input.file,
      checksum: fileHash,
    };

    const outbound: OutboundTransferState = {
      transferId,
      roomId: input.roomId,
      receiverPeerId: input.receiverPeerId,
      senderPeerId: input.senderPeerId,
      file,
      chunkSizeBytes,
      totalChunks: chunks.length,
      chunks,
      chunkHashes,
      sentChunks: new Set<number>(),
      sentBytes: 0,
    };
    this.outboundTransfers.set(transferId, outbound);

    const session: TransferSession = {
      id: transferId,
      roomId: input.roomId,
      senderPeerId: input.senderPeerId,
      receiverPeerId: input.receiverPeerId,
      file,
      status: 'in-progress',
      progressPercent: 0,
      startedAt: new Date().toISOString(),
      verificationStatus: 'pending',
    };
    this.sessionMap.set(transferId, session);
    this.emitProgressFromOutbound(outbound);
    this.logRecoveryEvent('transfer-started', {
      transferId,
      roomId: input.roomId,
      senderPeerId: input.senderPeerId,
      receiverPeerId: input.receiverPeerId,
      totalChunks: outbound.totalChunks,
    });

    await this.transport.send(input.roomId, input.receiverPeerId, {
      type: 'transfer-offer',
      transferId,
      fromPeerId: input.senderPeerId,
      toPeerId: input.receiverPeerId,
      file,
      fileHash,
      totalChunks: outbound.totalChunks,
      chunkSizeBytes,
      chunkHashes,
    });

    return session;
  }

  async cancelTransfer(sessionId: string): Promise<void> {
    const outbound = this.outboundTransfers.get(sessionId);
    if (outbound) {
      this.outboundTransfers.delete(sessionId);
      const session = this.sessionMap.get(sessionId);
      if (session) {
        session.status = 'failed';
        this.sessionMap.set(sessionId, session);
      }

      await this.transport.send(outbound.roomId, outbound.receiverPeerId, {
        type: 'transfer-cancel',
        transferId: sessionId,
        fromPeerId: this.localPeerId,
        toPeerId: outbound.receiverPeerId,
      });
      this.emitProgressFromOutbound(outbound, 'canceled');
      this.logRecoveryEvent('transfer-canceled-outbound', {
        transferId: sessionId,
        roomId: outbound.roomId,
        remotePeerId: outbound.receiverPeerId,
      });
      return;
    }

    const inbound = this.inboundTransfers.get(sessionId);
    if (!inbound) {
      return;
    }

    this.inboundTransfers.delete(sessionId);
    const session = this.sessionMap.get(sessionId);
    if (session) {
      session.status = 'failed';
      this.sessionMap.set(sessionId, session);
    }

    await this.transport.send(inbound.roomId, inbound.senderPeerId, {
      type: 'transfer-cancel',
      transferId: sessionId,
      fromPeerId: this.localPeerId,
      toPeerId: inbound.senderPeerId,
    });
    this.emitProgressFromInbound(inbound, 'canceled');
    this.logRecoveryEvent('transfer-canceled-inbound', {
      transferId: sessionId,
      roomId: inbound.roomId,
      remotePeerId: inbound.senderPeerId,
    });
  }

  setPeerConnectivity(peerId: string, connected: boolean): void {
    if (connected) {
      this.disconnectedPeers.delete(peerId);
      this.logRecoveryEvent('peer-reconnected', { peerId });
      void this.resumePendingTransfers(undefined, peerId);
      return;
    }

    this.disconnectedPeers.add(peerId);
    this.logRecoveryEvent('peer-disconnected', { peerId });

    for (const outbound of this.outboundTransfers.values()) {
      if (outbound.receiverPeerId !== peerId) {
        continue;
      }
      const session = this.sessionMap.get(outbound.transferId);
      if (session && session.status === 'in-progress') {
        session.status = 'queued';
        this.sessionMap.set(outbound.transferId, session);
      }
    }
  }

  async resumePendingTransfers(roomId?: string, peerId?: string): Promise<void> {
    for (const inbound of this.inboundTransfers.values()) {
      if (roomId && inbound.roomId !== roomId) {
        continue;
      }
      if (peerId && inbound.senderPeerId !== peerId) {
        continue;
      }
      if (this.disconnectedPeers.has(inbound.senderPeerId)) {
        continue;
      }

      const session = this.sessionMap.get(inbound.transferId);
      if (session && session.status === 'queued') {
        session.status = 'in-progress';
        this.sessionMap.set(inbound.transferId, session);
      }

      await this.requestNextChunk(inbound);
      this.logRecoveryEvent('transfer-resume-requested', {
        transferId: inbound.transferId,
        roomId: inbound.roomId,
        remotePeerId: inbound.senderPeerId,
      });
    }
  }

  getRecoveryStatus(): TransferRecoveryStatus[] {
    const statuses: TransferRecoveryStatus[] = [];

    for (const outbound of this.outboundTransfers.values()) {
      const session = this.sessionMap.get(outbound.transferId);
      statuses.push({
        transferId: outbound.transferId,
        roomId: outbound.roomId,
        remotePeerId: outbound.receiverPeerId,
        direction: 'send',
        status: (session?.status ?? 'in-progress') as FileTransferStatus,
        missingChunks: Math.max(0, outbound.totalChunks - outbound.sentChunks.size),
      });
    }

    for (const inbound of this.inboundTransfers.values()) {
      const session = this.sessionMap.get(inbound.transferId);
      statuses.push({
        transferId: inbound.transferId,
        roomId: inbound.roomId,
        remotePeerId: inbound.senderPeerId,
        direction: 'receive',
        status: (session?.status ?? 'in-progress') as FileTransferStatus,
        missingChunks: Math.max(0, inbound.totalChunks - inbound.chunks.size),
      });
    }

    return statuses;
  }

  onTransferProgress(listener: (progress: FileTransferProgress) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getReceivedFileBytes(sessionId: string): Uint8Array | null {
    return this.receivedFileBytes.get(sessionId) ?? null;
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  private async handleIncomingEnvelope(envelope: FileTransferTransportEnvelope): Promise<void> {
    const message = envelope.message;
    if (message.toPeerId !== this.localPeerId) {
      return;
    }

    switch (message.type) {
      case 'transfer-offer': {
        this.logRecoveryEvent('transfer-offer-received', {
          transferId: message.transferId,
          roomId: envelope.roomId,
          fromPeerId: message.fromPeerId,
          totalChunks: message.totalChunks,
        });
        const inbound: InboundTransferState = {
          transferId: message.transferId,
          roomId: envelope.roomId,
          senderPeerId: message.fromPeerId,
          receiverPeerId: this.localPeerId,
          file: message.file,
          chunkSizeBytes: message.chunkSizeBytes,
          totalChunks: message.totalChunks,
          expectedFileHash: message.fileHash,
          chunkHashes: message.chunkHashes,
          requestedChunks: new Set<number>(),
          chunks: new Map<number, Uint8Array>(),
          receivedBytes: 0,
          chunkRetryAttempts: new Map<number, number>(),
          chunkRetryTimers: new Map<number, ReturnType<typeof setTimeout>>(),
          verificationStatus: 'pending',
        };
        this.inboundTransfers.set(message.transferId, inbound);

        const session: TransferSession = {
          id: message.transferId,
          roomId: envelope.roomId,
          senderPeerId: message.fromPeerId,
          receiverPeerId: this.localPeerId,
          file: message.file,
          status: 'in-progress',
          progressPercent: 0,
          startedAt: new Date().toISOString(),
        };
        this.sessionMap.set(message.transferId, session);
        this.emitProgressFromInbound(inbound);
        await this.requestNextChunk(inbound);
        break;
      }
      case 'chunk-request': {
        const outbound = this.outboundTransfers.get(message.transferId);
        if (!outbound) {
          await this.transport.send(envelope.roomId, message.fromPeerId, {
            type: 'transfer-error',
            transferId: message.transferId,
            fromPeerId: this.localPeerId,
            toPeerId: message.fromPeerId,
            error: 'Transfer does not exist on sender side.',
          });
          return;
        }

        const chunk = outbound.chunks[message.chunkIndex];
        if (!chunk) {
          await this.transport.send(envelope.roomId, message.fromPeerId, {
            type: 'transfer-error',
            transferId: message.transferId,
            fromPeerId: this.localPeerId,
            toPeerId: message.fromPeerId,
            error: `Requested chunk ${message.chunkIndex} is out of range.`,
          });
          return;
        }

        outbound.sentChunks.add(message.chunkIndex);
        outbound.sentBytes += chunk.byteLength;

        await this.transport.send(envelope.roomId, message.fromPeerId, {
          type: 'chunk-response',
          transferId: message.transferId,
          fromPeerId: this.localPeerId,
          toPeerId: message.fromPeerId,
          chunkIndex: message.chunkIndex,
          chunkDataBase64: encodeBytesToBase64(chunk),
        });

        this.emitProgressFromOutbound(outbound);
        break;
      }
      case 'chunk-response': {
        const inbound = this.inboundTransfers.get(message.transferId);
        if (!inbound) {
          return;
        }

        if (inbound.chunks.has(message.chunkIndex)) {
          return;
        }

        const chunkBytesDecoded = decodeBase64ToBytes(message.chunkDataBase64);
        const expectedChunkHash = inbound.chunkHashes[message.chunkIndex];
        if (!expectedChunkHash) {
          await this.handleChunkIntegrityFailure(
            inbound,
            envelope.roomId,
            message.chunkIndex,
            `Received unexpected chunk ${message.chunkIndex}.`,
          );
          return;
        }

        const receivedChunkHash = await computeHashHex(chunkBytesDecoded);
        if (receivedChunkHash !== expectedChunkHash) {
          await this.handleChunkIntegrityFailure(
            inbound,
            envelope.roomId,
            message.chunkIndex,
            `Chunk ${message.chunkIndex} failed integrity verification.`,
          );
          return;
        }

        this.clearChunkRetry(inbound, message.chunkIndex);
        inbound.chunks.set(message.chunkIndex, chunkBytesDecoded);
        inbound.receivedBytes += chunkBytesDecoded.byteLength;
        this.emitProgressFromInbound(inbound);

        if (inbound.chunks.size === inbound.totalChunks) {
          const fileBytes = mergeChunks(inbound.chunks, inbound.totalChunks);
          const mergedHash = await computeHashHex(fileBytes);
          if (mergedHash !== inbound.expectedFileHash) {
            await this.handleFinalIntegrityFailure(inbound, envelope.roomId, message.fromPeerId);
            return;
          }

          this.receivedFileBytes.set(message.transferId, fileBytes);
          this.inboundTransfers.delete(message.transferId);
          this.logRecoveryEvent('transfer-completed-inbound', {
            transferId: message.transferId,
            roomId: envelope.roomId,
            fromPeerId: message.fromPeerId,
          });

          const session = this.sessionMap.get(message.transferId);
          if (session) {
            session.status = 'completed';
            session.progressPercent = 100;
            session.completedAt = new Date().toISOString();
            session.verificationStatus = 'verified';
            this.sessionMap.set(message.transferId, session);
          }

          await this.transport.send(envelope.roomId, message.fromPeerId, {
            type: 'transfer-complete',
            transferId: message.transferId,
            fromPeerId: this.localPeerId,
            toPeerId: message.fromPeerId,
            receivedBytes: inbound.receivedBytes,
          });
          this.emitProgressFromInbound(inbound, 'completed');
          return;
        }

        await this.requestNextChunk(inbound);
        break;
      }
      case 'transfer-complete': {
        const outbound = this.outboundTransfers.get(message.transferId);
        if (!outbound) {
          return;
        }

        this.outboundTransfers.delete(message.transferId);
        const session = this.sessionMap.get(message.transferId);
        if (session) {
          session.status = 'completed';
          session.progressPercent = 100;
          session.completedAt = new Date().toISOString();
          session.verificationStatus = 'verified';
          this.sessionMap.set(message.transferId, session);
        }

        this.emitProgressFromOutbound(outbound, 'completed');
        this.logRecoveryEvent('transfer-completed-outbound', {
          transferId: message.transferId,
          roomId: envelope.roomId,
          toPeerId: message.fromPeerId,
        });
        break;
      }
      case 'transfer-cancel': {
        this.markTransferFailed(message.transferId, 'Transfer canceled by remote peer.', envelope.roomId, message.fromPeerId);
        break;
      }
      case 'transfer-error': {
        this.markTransferFailed(message.transferId, message.error, envelope.roomId, message.fromPeerId);
        break;
      }
      default:
        break;
    }
  }

  private async requestNextChunk(inbound: InboundTransferState): Promise<void> {
    for (let chunkIndex = 0; chunkIndex < inbound.totalChunks; chunkIndex += 1) {
      if (inbound.chunks.has(chunkIndex) || inbound.requestedChunks.has(chunkIndex)) {
        continue;
      }

      await this.requestChunk(inbound, chunkIndex);
      return;
    }
  }

  private async requestChunk(inbound: InboundTransferState, chunkIndex: number): Promise<void> {
    if (inbound.chunks.has(chunkIndex)) {
      return;
    }

    inbound.requestedChunks.add(chunkIndex);
    this.scheduleChunkRetry(inbound, chunkIndex);
    await this.transport.send(inbound.roomId, inbound.senderPeerId, {
      type: 'chunk-request',
      transferId: inbound.transferId,
      fromPeerId: this.localPeerId,
      toPeerId: inbound.senderPeerId,
      chunkIndex,
    });
  }

  private scheduleChunkRetry(inbound: InboundTransferState, chunkIndex: number): void {
    this.clearChunkRetry(inbound, chunkIndex);

    const timer = setTimeout(() => {
      void this.retryMissingChunk(inbound.transferId, chunkIndex);
    }, CHUNK_RETRY_DELAY_MS);

    inbound.chunkRetryTimers.set(chunkIndex, timer);
  }

  private clearChunkRetry(inbound: InboundTransferState, chunkIndex: number): void {
    const timer = inbound.chunkRetryTimers.get(chunkIndex);
    if (timer) {
      clearTimeout(timer);
      inbound.chunkRetryTimers.delete(chunkIndex);
    }
    inbound.requestedChunks.delete(chunkIndex);
  }

  private async retryMissingChunk(transferId: string, chunkIndex: number): Promise<void> {
    const inbound = this.inboundTransfers.get(transferId);
    if (!inbound || inbound.chunks.has(chunkIndex)) {
      return;
    }

    const attempts = (inbound.chunkRetryAttempts.get(chunkIndex) ?? 0) + 1;
    inbound.chunkRetryAttempts.set(chunkIndex, attempts);
    inbound.requestedChunks.delete(chunkIndex);

    if (attempts > MAX_CHUNK_RETRY_ATTEMPTS) {
      await this.transport.send(inbound.roomId, inbound.senderPeerId, {
        type: 'transfer-error',
        transferId: inbound.transferId,
        fromPeerId: this.localPeerId,
        toPeerId: inbound.senderPeerId,
        error: `Chunk ${chunkIndex} could not be verified after ${MAX_CHUNK_RETRY_ATTEMPTS} retries.`,
      });
      await this.failInboundTransfer(
        inbound,
        `Chunk ${chunkIndex} could not be verified after ${MAX_CHUNK_RETRY_ATTEMPTS} retries.`,
      );
      this.logRecoveryEvent('chunk-retry-exhausted', {
        transferId,
        chunkIndex,
        attempts,
      });
      return;
    }

    await this.requestChunk(inbound, chunkIndex);
    this.logRecoveryEvent('chunk-retry-scheduled', {
      transferId,
      chunkIndex,
      attempts,
    });
  }

  private async handleChunkIntegrityFailure(
    inbound: InboundTransferState,
    roomId: string,
    chunkIndex: number,
    error: string,
  ): Promise<void> {
    this.clearChunkRetry(inbound, chunkIndex);

    const attempts = (inbound.chunkRetryAttempts.get(chunkIndex) ?? 0) + 1;
    inbound.chunkRetryAttempts.set(chunkIndex, attempts);

    if (attempts > MAX_CHUNK_RETRY_ATTEMPTS) {
      await this.transport.send(roomId, inbound.senderPeerId, {
        type: 'transfer-error',
        transferId: inbound.transferId,
        fromPeerId: this.localPeerId,
        toPeerId: inbound.senderPeerId,
        error,
      });
      await this.failInboundTransfer(inbound, error);
      return;
    }

    await this.requestChunk(inbound, chunkIndex);
  }

  private async handleFinalIntegrityFailure(
    inbound: InboundTransferState,
    roomId: string,
    remotePeerId: string,
  ): Promise<void> {
    await this.failInboundTransfer(
      inbound,
      `File integrity verification failed for ${inbound.file.fileName}.`,
    );

    await this.transport.send(roomId, remotePeerId, {
      type: 'transfer-error',
      transferId: inbound.transferId,
      fromPeerId: this.localPeerId,
      toPeerId: remotePeerId,
      error: `File integrity verification failed for ${inbound.file.fileName}.`,
    });
  }

  private async failInboundTransfer(inbound: InboundTransferState, error: string): Promise<void> {
    for (const timer of inbound.chunkRetryTimers.values()) {
      clearTimeout(timer);
    }
    inbound.chunkRetryTimers.clear();
    inbound.requestedChunks.clear();

    this.inboundTransfers.delete(inbound.transferId);
    const session = this.sessionMap.get(inbound.transferId);
    if (session) {
      session.status = 'failed';
      session.error = error;
      session.verificationStatus = 'failed';
      this.sessionMap.set(inbound.transferId, session);
    }
    this.emitProgressFromInbound(inbound, 'failed', error);
    this.logRecoveryEvent('transfer-failed-inbound', {
      transferId: inbound.transferId,
      roomId: inbound.roomId,
      error,
    });
  }

  private markTransferFailed(transferId: string, error: string, roomId: string, remotePeerId: string): void {
    const outbound = this.outboundTransfers.get(transferId);
    if (outbound) {
      this.outboundTransfers.delete(transferId);
      const session = this.sessionMap.get(transferId);
      if (session) {
        session.status = 'failed';
        session.error = error;
        session.verificationStatus = 'failed';
        this.sessionMap.set(transferId, session);
      }
      this.emitProgressFromOutbound(outbound, 'failed', error);
      this.logRecoveryEvent('transfer-failed-outbound', {
        transferId,
        roomId,
        remotePeerId,
        error,
      });
      return;
    }

    const inbound = this.inboundTransfers.get(transferId);
    if (inbound) {
      this.inboundTransfers.delete(transferId);
      for (const timer of inbound.chunkRetryTimers.values()) {
        clearTimeout(timer);
      }
      inbound.chunkRetryTimers.clear();
      const session = this.sessionMap.get(transferId);
      if (session) {
        session.status = 'failed';
        session.error = error;
        session.verificationStatus = 'failed';
        this.sessionMap.set(transferId, session);
      }
      this.emitProgressFromInbound(inbound, 'failed', error);
      this.logRecoveryEvent('transfer-failed-inbound', {
        transferId,
        roomId,
        remotePeerId,
        error,
      });
      return;
    }

    const session = this.sessionMap.get(transferId);
    if (session) {
      session.status = 'failed';
      session.error = error;
      session.verificationStatus = 'failed';
      this.sessionMap.set(transferId, session);
      this.emit({
        session,
        direction: session.senderPeerId === this.localPeerId ? 'send' : 'receive',
        bytesTransferred: 0,
        totalBytes: session.file.sizeBytes,
        completedChunks: 0,
        totalChunks: 0,
        status: 'failed',
        error,
      });
      return;
    }

    const synthetic: TransferSession = {
      id: transferId,
      roomId,
      senderPeerId: remotePeerId,
      receiverPeerId: this.localPeerId,
      file: {
        id: transferId,
        fileName: 'unknown',
        filePath: '',
        sizeBytes: 0,
        checksum: '',
        mimeType: 'application/octet-stream',
        createdAt: new Date().toISOString(),
      },
      status: 'failed',
      progressPercent: 0,
      startedAt: new Date().toISOString(),
    };

    this.sessionMap.set(transferId, synthetic);
    this.emit({
      session: synthetic,
      direction: 'receive',
      bytesTransferred: 0,
      totalBytes: 0,
      completedChunks: 0,
      totalChunks: 0,
      status: 'failed',
      error,
    });
    this.logRecoveryEvent('transfer-failed-synthetic', {
      transferId,
      roomId,
      remotePeerId,
      error,
    });
  }

  private emitProgressFromOutbound(
    outbound: OutboundTransferState,
    statusOverride?: FileTransferStatus,
    error?: string,
  ): void {
    const session = this.sessionMap.get(outbound.transferId);
    if (!session) {
      return;
    }

    const progressPercent = outbound.file.sizeBytes === 0
      ? 100
      : Math.min(100, Math.floor((outbound.sentBytes / outbound.file.sizeBytes) * 100));
    if (statusOverride !== 'completed') {
      session.progressPercent = progressPercent;
    }
    if (statusOverride === 'failed') {
      session.status = 'failed';
      session.error = error;
      session.verificationStatus = 'failed';
    } else if (statusOverride === 'completed') {
      session.verificationStatus = 'verified';
    }

    this.sessionMap.set(outbound.transferId, session);
    this.emit({
      session,
      direction: 'send',
      bytesTransferred: outbound.sentBytes,
      totalBytes: outbound.file.sizeBytes,
      completedChunks: outbound.sentChunks.size,
      totalChunks: outbound.totalChunks,
      status: statusOverride ?? session.status,
      verificationStatus: session.verificationStatus,
      error,
    });
  }

  private emitProgressFromInbound(
    inbound: InboundTransferState,
    statusOverride?: FileTransferStatus,
    error?: string,
  ): void {
    const session = this.sessionMap.get(inbound.transferId);
    if (!session) {
      return;
    }

    const progressPercent = inbound.file.sizeBytes === 0
      ? 100
      : Math.min(100, Math.floor((inbound.receivedBytes / inbound.file.sizeBytes) * 100));
    if (statusOverride !== 'completed') {
      session.progressPercent = progressPercent;
    }
    if (statusOverride === 'failed') {
      session.status = 'failed';
      session.error = error;
      session.verificationStatus = 'failed';
    } else if (statusOverride === 'completed') {
      session.verificationStatus = 'verified';
    }

    this.sessionMap.set(inbound.transferId, session);
    this.emit({
      session,
      direction: 'receive',
      bytesTransferred: inbound.receivedBytes,
      totalBytes: inbound.file.sizeBytes,
      completedChunks: inbound.chunks.size,
      totalChunks: inbound.totalChunks,
      status: statusOverride ?? session.status,
      verificationStatus: session.verificationStatus,
      error,
    });
  }

  private emit(progress: FileTransferProgress): void {
    for (const listener of this.listeners) {
      listener(progress);
    }
  }

  private logRecoveryEvent(event: string, details: Record<string, unknown>): void {
    console.info('[FileTransferRecovery]', event, details);
  }
}

export class InMemoryFileTransferTransport implements FileTransferTransport {
  private listeners = new Set<(envelope: FileTransferTransportEnvelope) => void>();

  async send(roomId: string, _toPeerId: string, message: FileTransferMessage): Promise<void> {
    const envelope: FileTransferTransportEnvelope = { roomId, message };
    for (const listener of this.listeners) {
      listener(envelope);
    }
  }

  subscribe(handler: (envelope: FileTransferTransportEnvelope) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }
}

function chunkBytes(input: Uint8Array, chunkSizeBytes: number): Uint8Array[] {
  if (input.byteLength === 0) {
    return [new Uint8Array(0)];
  }

  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < input.byteLength; offset += chunkSizeBytes) {
    const end = Math.min(input.byteLength, offset + chunkSizeBytes);
    chunks.push(input.subarray(offset, end));
  }
  return chunks;
}

function mergeChunks(chunks: Map<number, Uint8Array>, totalChunks: number): Uint8Array {
  let totalLength = 0;
  for (let i = 0; i < totalChunks; i += 1) {
    const chunk = chunks.get(i);
    if (!chunk) {
      throw new Error(`Missing chunk ${i}`);
    }
    totalLength += chunk.byteLength;
  }

  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (let i = 0; i < totalChunks; i += 1) {
    const chunk = chunks.get(i);
    if (!chunk) {
      throw new Error(`Missing chunk ${i}`);
    }
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function encodeBytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(base64, 'base64'));
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function computeHashHex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Integrity verification requires Web Crypto support.');
  }

  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await subtle.digest('SHA-256', digestInput.buffer);
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
