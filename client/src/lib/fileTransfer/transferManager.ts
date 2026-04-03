import type { FileManifest } from "../../shared/fileTransfer";
import type {
    FileTransferSummary,
    FileTransferViewState,
    IncomingFileOffer,
    SharedFileCatalogItem,
    SharedFilesBySender,
} from "../../types/fileTransfer";
import { sha256Hex } from "./hash";
import { PieceScheduler } from "./pieceScheduler";
import {
    DEFAULT_PIECE_SIZE,
    base64ToBitfield,
    bitfieldToBase64,
    createBitfield,
    decodeBinaryFrame,
    encodeBinaryFrame,
    encodeControlMessage,
    type FileTransferControlMessage,
} from "./protocol";

type TransferRole = "sender" | "receiver";

interface TransferContext {
  roomId: string;
  myPeerId: string;
  myDisplayName: string;
  remotePeerId: string;
}

interface FileTransferBridge {
  selectFileForSharing: () => Promise<{ filePath: string; fileName: string; mimeType: string; fileSize: number } | null>;
  buildFileManifest: (filePath: string, roomId: string, senderPeerId: string, pieceSize: number) => Promise<FileManifest>;
  readFilePiece: (filePath: string, pieceIndex: number, pieceSize: number) => Promise<Uint8Array>;
  createReceiverTransfer: (manifest: FileManifest) => Promise<{ transferId: string; manifest: FileManifest; tempFilePath: string }>;
  writeReceiverPiece: (transferId: string, pieceIndex: number, data: Uint8Array) => Promise<void>;
  finalizeReceiverTransfer: (transferId: string) => Promise<{ savedPath: string; verifiedHash: string }>;
  cancelReceiverTransfer: (transferId: string) => Promise<void>;
}

export interface FileTransferTransport {
  sendFileControlMessage: (text: string) => boolean;
  sendFileDataMessage: (data: ArrayBuffer) => boolean;
  isFileTransferReady: () => boolean;
}

interface FileTransferCallbacks {
  onUpdate: (state: FileTransferViewState) => void;
  onEvent: (text: string) => void;
}

interface SenderSession {
  role: "sender";
  transferId: string;
  manifest: FileManifest;
  filePath: string;
  fileName: string;
  senderDisplayName: string;
  receiverDisplayName: string;
  status: FileTransferSummary["status"];
  integrityStatus: FileTransferSummary["integrityStatus"];
  createdAt: number;
  updatedAt: number;
  transferredBytes: number;
  verifiedPieces: number;
  requestedPieces: number;
  inFlightPieces: number;
  completedPieces: number;
  speedBytesPerSecond: number;
  message?: string;
  pieceAvailability: Uint8Array;
  pendingRequests: number[];
  requestQueueRunning: boolean;
  acceptedAt?: number;
}

interface ReceiverSession {
  role: "receiver";
  transferId: string;
  manifest: FileManifest;
  senderDisplayName: string;
  receiverDisplayName: string;
  status: FileTransferSummary["status"];
  integrityStatus: FileTransferSummary["integrityStatus"];
  createdAt: number;
  updatedAt: number;
  transferredBytes: number;
  verifiedPieces: number;
  requestedPieces: number;
  inFlightPieces: number;
  completedPieces: number;
  speedBytesPerSecond: number;
  message?: string;
  scheduler: PieceScheduler;
  receivedBitfield: Uint8Array;
  receiverTransferId?: string;
  finalizeRequested: boolean;
  completionStartedAt?: number;
  requestTimer: number | null;
  remoteAvailabilityReceived: boolean;
}

interface LocalSharedFileRecord {
  manifest: FileManifest;
  filePath: string;
  senderDisplayName: string;
}

export interface PreparedLocalShare {
  filePath: string;
  manifest: FileManifest;
  senderDisplayName: string;
}

interface DownloadHistoryEntry {
  count: number;
  lastDownloadedAt: number;
}

type TransferSession = SenderSession | ReceiverSession;

function now(): number {
  return Date.now();
}

function emptyViewState(): FileTransferViewState {
  return {
    incomingOffers: [],
    activeTransfers: [],
    sharedFilesBySender: [],
  };
}

function buildSummary(session: TransferSession): FileTransferSummary {
  const base = {
    transferId: session.transferId,
    manifest: session.manifest,
    senderDisplayName: session.senderDisplayName,
    receiverDisplayName: session.receiverDisplayName,
    transferredBytes: session.transferredBytes,
    verifiedPieces: session.verifiedPieces,
    requestedPieces: session.requestedPieces,
    inFlightPieces: session.inFlightPieces,
    completedPieces: session.completedPieces,
    speedBytesPerSecond: session.speedBytesPerSecond,
    message: session.message,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    progress: session.manifest.fileSize === 0 ? 1 : Math.min(1, session.transferredBytes / session.manifest.fileSize),
  };

  return {
    ...base,
    direction: session.role === "sender" ? "upload" : "download",
    status: session.status,
    integrityStatus: session.integrityStatus,
  };
}

function bitfieldAllOnes(pieceCount: number): Uint8Array {
  const bitfield = createBitfield(pieceCount);
  for (let index = 0; index < pieceCount; index += 1) {
    const byteIndex = Math.floor(index / 8);
    const bitIndex = index % 8;
    bitfield[byteIndex] |= 1 << bitIndex;
  }
  return bitfield;
}

export class FileTransferManager {
  private readonly bridge: FileTransferBridge;
  private readonly callbacks: FileTransferCallbacks;
  private transport: FileTransferTransport | null = null;
  private context: TransferContext | null = null;
  private readonly incomingOffers = new Map<string, IncomingFileOffer>();
  private readonly sessions = new Map<string, TransferSession>();
  private readonly localSharedFiles = new Map<string, LocalSharedFileRecord>();
  private readonly sharedCatalog = new Map<string, SharedFileCatalogItem>();
  private readonly downloadHistory = new Map<string, DownloadHistoryEntry>();

  constructor(bridge: FileTransferBridge, callbacks: FileTransferCallbacks) {
    this.bridge = bridge;
    this.callbacks = callbacks;
  }

  setTransport(transport: FileTransferTransport | null): void {
    this.transport = transport;
  }

  setContext(context: TransferContext | null): void {
    this.context = context;
    this.emitState();
  }

  async prepareShareFile(): Promise<PreparedLocalShare | null> {
    if (!this.context) {
      this.callbacks.onEvent("error: not in a room");
      return null;
    }

    if (!this.transport?.isFileTransferReady()) {
      this.callbacks.onEvent("error: file transfer channel is not ready");
      return null;
    }

    const selected = await this.bridge.selectFileForSharing();
    if (!selected) {
      return null;
    }

    const pieceSize = DEFAULT_PIECE_SIZE;

    let manifest: FileManifest;
    try {
      manifest = await this.bridge.buildFileManifest(selected.filePath, this.context.roomId, this.context.myPeerId, pieceSize);
    } catch (error) {
      this.callbacks.onEvent(error instanceof Error ? `error: ${error.message}` : "error: failed to build file manifest");
      return null;
    }

    return {
      filePath: selected.filePath,
      manifest,
      senderDisplayName: this.context.myDisplayName,
    };
  }

  sharePreparedFile(preparedShare: PreparedLocalShare): string | null {
    if (!this.context || !this.transport?.isFileTransferReady()) {
      return null;
    }

    const localRecord: LocalSharedFileRecord = {
      manifest: preparedShare.manifest,
      filePath: preparedShare.filePath,
      senderDisplayName: preparedShare.senderDisplayName,
    };

    this.localSharedFiles.set(preparedShare.manifest.fileId, localRecord);
    const transferId = this.startSenderTransfer(localRecord, "Waiting for acceptance");
    if (!transferId) {
      return null;
    }

    this.callbacks.onEvent(`file shared: ${preparedShare.manifest.fileName}`);
    this.emitState();
    return transferId;
  }

  async shareFile(): Promise<void> {
    const preparedShare = await this.prepareShareFile();
    if (!preparedShare) {
      return;
    }
    this.sharePreparedFile(preparedShare);
  }

  requestDownload(fileId: string, senderPeerId: string): void {
    if (!this.context || !this.transport?.isFileTransferReady()) {
      return;
    }

    const catalogKey = `${senderPeerId}:${fileId}`;
    const catalogItem = this.sharedCatalog.get(catalogKey);
    if (!catalogItem || !catalogItem.hasAcceptedOffer) {
      this.callbacks.onEvent("download blocked: accept an incoming offer for this file first");
      return;
    }

    this.sendControl({
      type: "file-download-request",
      requesterPeerId: this.context.myPeerId,
      targetSenderPeerId: senderPeerId,
      roomId: this.context.roomId,
      fileId,
    });
  }

  acceptIncomingOffer(transferId: string): void {
    const offer = this.incomingOffers.get(transferId);
    if (!offer || !this.context || !this.transport?.isFileTransferReady()) {
      return;
    }

    offer.status = "accepted";
    this.markOfferAccepted(offer.manifest);
    this.sendControl({
      type: "file-offer-accepted",
      transferId,
      senderPeerId: offer.manifest.senderPeerId,
      receiverPeerId: this.context.myPeerId,
      roomId: this.context.roomId,
    });
    this.emitState();
  }

  downloadAcceptedOffer(transferId: string): void {
    const offer = this.incomingOffers.get(transferId);
    if (!offer || offer.status !== "accepted") {
      this.callbacks.onEvent("download blocked: accept this offer first");
      return;
    }

    if (this.sessions.has(transferId)) {
      return;
    }

    void this.startReceiverSession(offer.manifest, offer.senderDisplayName, transferId).catch((error) => {
      this.callbacks.onEvent(error instanceof Error ? `error: ${error.message}` : "error: failed to start download");
    });
  }

  declineIncomingOffer(transferId: string, reason = "Declined by receiver"): void {
    const offer = this.incomingOffers.get(transferId);
    if (!offer || !this.context) {
      return;
    }

    offer.status = "declined";
    this.sendControl({
      type: "file-offer-declined",
      transferId,
      senderPeerId: offer.manifest.senderPeerId,
      receiverPeerId: this.context.myPeerId,
      roomId: this.context.roomId,
      reason,
    });
    this.emitState();
  }

  cancelTransfer(transferId: string, reason = "Cancelled by user"): void {
    const session = this.sessions.get(transferId);
    if (!session || !this.context) {
      return;
    }

    this.sendControl({
      type: "transfer-cancel",
      transferId,
      senderPeerId: this.context.myPeerId,
      roomId: this.context.roomId,
      reason,
    });

    void this.cleanupSession(session, "cancelled", reason);
  }

  resetRoom(reason: string): void {
    if (this.context) {
      for (const session of this.sessions.values()) {
        this.sendControl({
          type: "transfer-cancel",
          transferId: session.transferId,
          senderPeerId: this.context.myPeerId,
          roomId: this.context.roomId,
          reason,
        });
      }
    }

    for (const session of this.sessions.values()) {
      void this.cleanupSession(session, "cancelled", reason);
    }

    this.incomingOffers.clear();
    this.sessions.clear();
    this.localSharedFiles.clear();
    this.sharedCatalog.clear();
    this.downloadHistory.clear();
    this.emitState();
  }

  async handleControlMessage(raw: string): Promise<void> {
    let message: FileTransferControlMessage | null = null;

    try {
      message = JSON.parse(raw) as FileTransferControlMessage;
    } catch {
      return;
    }

    if (!message || typeof message !== "object" || !("type" in message)) {
      return;
    }

    switch (message.type) {
      case "file-offer":
        this.upsertSharedCatalog(message.manifest, message.senderDisplayName, message.transferId);
        {
          const existingOffer = this.incomingOffers.get(message.transferId);
          const nextStatus = existingOffer?.status ?? "offered";
        this.incomingOffers.set(message.transferId, {
          transferId: message.transferId,
          manifest: message.manifest,
          senderDisplayName: message.senderDisplayName,
          status: nextStatus,
          createdAt: now(),
        });
        }
        this.callbacks.onEvent(`incoming file offer: ${message.manifest.fileName}`);
        this.emitState();
        return;

      case "file-manifest":
        this.upsertSharedCatalog(
          message.manifest,
          this.incomingOffers.get(message.transferId)?.senderDisplayName ?? "Peer",
          message.transferId,
        );
        this.incomingOffers.set(message.transferId, {
          transferId: message.transferId,
          manifest: message.manifest,
          senderDisplayName: this.incomingOffers.get(message.transferId)?.senderDisplayName ?? "Peer",
          status: this.incomingOffers.get(message.transferId)?.status ?? "offered",
          createdAt: this.incomingOffers.get(message.transferId)?.createdAt ?? now(),
        });
        this.emitState();
        return;

      case "file-download-request":
        await this.handleDownloadRequest(message.fileId, message.targetSenderPeerId, message.requesterPeerId);
        return;

      case "file-offer-accepted":
        await this.handleOfferAccepted(message.transferId, message.receiverPeerId);
        return;

      case "file-offer-declined":
        await this.handleOfferDeclined(message.transferId, message.reason ?? "Declined");
        return;

      case "piece-availability":
        await this.handlePieceAvailability(message.transferId, message.availablePieces, message.pieceCount);
        return;

      case "piece-request":
        await this.handlePieceRequest(message.transferId, message.pieceIndex);
        return;

      case "piece-reject":
        this.callbacks.onEvent(`piece rejected: ${message.pieceIndex}`);
        return;

      case "transfer-progress":
        this.applyRemoteProgress(message.transferId, message.transferredBytes, message.completedPieces, message.requestedPieces, message.inFlightPieces, message.speedBytesPerSecond);
        return;

      case "transfer-complete":
        await this.handleRemoteComplete(message.transferId);
        return;

      case "transfer-cancel":
        await this.handleRemoteCancel(message.transferId, message.reason);
        return;

      case "transfer-error":
        await this.handleRemoteError(message.transferId, message.message);
        return;
    }
  }

  async handleBinaryMessage(data: ArrayBuffer | Uint8Array): Promise<void> {
    const frame = decodeBinaryFrame(data);
    const session = this.sessions.get(frame.header.transferId);
    if (!session || session.role !== "receiver") {
      return;
    }

    const receiver = session;
    if (frame.header.byteLength !== frame.payload.byteLength) {
      receiver.message = "Corrupt piece received";
      receiver.status = "retrying";
      receiver.updatedAt = now();
      this.emitState();
      return;
    }

    const pieceIndex = frame.header.pieceIndex;
    const expectedHash = receiver.manifest.pieceHashes[pieceIndex];
    const actualHash = await sha256Hex(frame.payload);
    if (actualHash !== expectedHash) {
      receiver.scheduler.markFailed(pieceIndex);
      receiver.inFlightPieces = Math.max(0, receiver.inFlightPieces - 1);
      receiver.message = `Piece ${pieceIndex} failed integrity verification`;
      receiver.status = "retrying";
      receiver.updatedAt = now();
      this.sendControl({
        type: "piece-reject",
        transferId: receiver.transferId,
        senderPeerId: this.context?.myPeerId ?? receiver.manifest.senderPeerId,
        receiverPeerId: receiver.manifest.senderPeerId,
        roomId: receiver.manifest.roomId,
        pieceIndex,
        reason: "Integrity mismatch",
      });
      this.emitState();
      this.requestMorePieces(receiver);
      return;
    }

    try {
      await this.bridge.writeReceiverPiece(receiver.receiverTransferId ?? receiver.transferId, pieceIndex, frame.payload);
    } catch (error) {
      receiver.scheduler.markFailed(pieceIndex);
      receiver.message = error instanceof Error ? error.message : "Failed to persist piece";
      receiver.status = "failed";
      receiver.integrityStatus = "failed";
      receiver.updatedAt = now();
      this.emitState();
      return;
    }

    receiver.scheduler.markVerified(pieceIndex);
    receiver.receivedBitfield[Math.floor(pieceIndex / 8)] |= 1 << (pieceIndex % 8);
    receiver.transferredBytes += frame.payload.byteLength;
    receiver.completedPieces = receiver.scheduler.getCompletedCount();
    receiver.inFlightPieces = Math.max(0, receiver.inFlightPieces - 1);
    receiver.verifiedPieces = receiver.completedPieces;
    receiver.status = receiver.scheduler.isComplete() ? "verifying" : "transferring";
    receiver.message = undefined;
    receiver.updatedAt = now();
    this.callbacks.onEvent(`receiver stored piece ${pieceIndex} for ${receiver.transferId}; completed ${receiver.completedPieces}/${receiver.manifest.pieceCount}`);
    this.emitState();

    if (receiver.scheduler.isComplete()) {
      await this.completeReceiverTransfer(receiver);
      return;
    }

    this.requestMorePieces(receiver);
  }

  private async startReceiverSession(manifest: FileManifest, senderDisplayName: string, transferId: string): Promise<void> {
    if (!this.context) {
      return;
    }

    const handle = await this.bridge.createReceiverTransfer(manifest);
    const session: ReceiverSession = {
      role: "receiver",
      transferId,
      manifest,
      senderDisplayName,
      receiverDisplayName: this.context.myDisplayName,
      status: "accepted",
      integrityStatus: "pending",
      createdAt: now(),
      updatedAt: now(),
      transferredBytes: 0,
      verifiedPieces: 0,
      requestedPieces: 0,
      inFlightPieces: 0,
      completedPieces: 0,
      speedBytesPerSecond: 0,
      scheduler: new PieceScheduler(manifest.pieceCount, 1, 12_000),
      receivedBitfield: createBitfield(manifest.pieceCount),
      receiverTransferId: handle.transferId,
      finalizeRequested: false,
      requestTimer: window.setInterval(() => {
        const active = this.sessions.get(transferId);
        if (active && active.role === "receiver") {
          const timedOut = active.scheduler.consumeTimedOutPieces(now());
          if (timedOut.length > 0) {
            active.status = "retrying";
            active.message = `Retrying ${timedOut.length} timed out piece(s)`;
            active.updatedAt = now();
            this.emitState();
            this.requestMorePieces(active);
          }
        }
      }, 2500),
      remoteAvailabilityReceived: false,
    };

    this.sessions.set(transferId, session);
    if (session.scheduler.isComplete()) {
      await this.completeReceiverTransfer(session);
      return;
    }

    this.requestMorePieces(session);
    this.emitState();
  }

  private async handleOfferAccepted(transferId: string, receiverPeerId: string): Promise<void> {
    const session = this.sessions.get(transferId);
    if (!session || session.role !== "sender") {
      return;
    }

    const context = this.context;
    if (!context) {
      return;
    }

    session.status = "accepted";
    session.receiverDisplayName = receiverPeerId;
    session.acceptedAt = now();
    session.updatedAt = now();
    this.sendControl({
      type: "piece-availability",
      transferId,
      senderPeerId: context.myPeerId,
      roomId: session.manifest.roomId,
      availablePieces: bitfieldToBase64(session.pieceAvailability),
      pieceCount: session.manifest.pieceCount,
    });

    this.sendControl({
      type: "file-manifest",
      transferId,
      senderPeerId: context.myPeerId,
      manifest: session.manifest,
    });

    if (session.manifest.pieceCount === 0) {
      this.sendControl({
        type: "transfer-complete",
        transferId,
        senderPeerId: context.myPeerId,
        roomId: session.manifest.roomId,
        fileId: session.manifest.fileId,
      });
    }

    this.emitState();
  }

  private async handleDownloadRequest(fileId: string, targetSenderPeerId: string, requesterPeerId: string): Promise<void> {
    const context = this.context;
    if (!context || context.myPeerId !== targetSenderPeerId) {
      return;
    }

    const localRecord = this.localSharedFiles.get(fileId);
    if (!localRecord) {
      this.sendControl({
        type: "transfer-error",
        transferId: crypto.randomUUID(),
        senderPeerId: context.myPeerId,
        roomId: context.roomId,
        message: "Requested file is no longer available on sender",
      });
      return;
    }

    const transferId = this.startSenderTransfer(localRecord, requesterPeerId);
    if (transferId) {
      this.callbacks.onEvent(`resend requested for ${localRecord.manifest.fileName}`);
      this.emitState();
    }
  }

  private async handleOfferDeclined(transferId: string, reason: string): Promise<void> {
    const session = this.sessions.get(transferId);
    if (!session) {
      return;
    }

    session.status = "declined";
    session.message = reason;
    session.updatedAt = now();
    this.emitState();
  }

  private async handlePieceAvailability(transferId: string, availablePieces: string, pieceCount: number): Promise<void> {
    const session = this.sessions.get(transferId);
    if (!session || session.role !== "receiver") {
      return;
    }

    session.scheduler.setAvailability(base64ToBitfield(availablePieces));
    session.remoteAvailabilityReceived = true;
    session.requestedPieces = session.scheduler.getRequestedCount();
    session.inFlightPieces = session.scheduler.getInflightCount();
    session.updatedAt = now();
    this.requestMorePieces(session);
    this.emitState();
  }

  private async handlePieceRequest(transferId: string, pieceIndex: number): Promise<void> {
    const session = this.sessions.get(transferId);
    const context = this.context;
    if (!session || session.role !== "sender" || !context || !this.transport) {
      return;
    }

    session.pendingRequests.push(pieceIndex);
    session.requestedPieces += 1;
    session.inFlightPieces = session.pendingRequests.length;
    session.updatedAt = now();
    this.callbacks.onEvent(`sender queued piece ${pieceIndex} for ${transferId}; pending ${session.pendingRequests.length}`);
    this.emitState();
    await this.flushSenderQueue(session);
  }

  private async flushSenderQueue(session: SenderSession): Promise<void> {
    if (session.requestQueueRunning) {
      return;
    }

    const context = this.context;
    if (!context) {
      return;
    }

    session.requestQueueRunning = true;

    try {
      while (session.pendingRequests.length > 0 && this.transport?.isFileTransferReady()) {
        const pieceIndex = session.pendingRequests[0];
        const payload = await this.bridge.readFilePiece(session.filePath, pieceIndex, session.manifest.pieceSize);
        const frame = encodeBinaryFrame(
          {
            type: "piece-data",
            transferId: session.transferId,
            fileId: session.manifest.fileId,
            pieceIndex,
            byteLength: payload.byteLength,
          },
          payload,
        );

        if (!this.transport.sendFileDataMessage(frame)) {
          window.setTimeout(() => {
            void this.flushSenderQueue(session);
          }, 50);
          return;
        }

        session.pendingRequests.shift();
        session.transferredBytes += payload.byteLength;
        session.completedPieces += 1;
        session.verifiedPieces = session.completedPieces;
        session.inFlightPieces = session.pendingRequests.length;
        session.status = "transferring";
        session.speedBytesPerSecond = this.calculateSpeed(session.transferredBytes, session.createdAt);
        session.updatedAt = now();
        this.callbacks.onEvent(`sender sent piece ${pieceIndex} for ${session.transferId}; completed ${session.completedPieces}/${session.manifest.pieceCount}`);

        this.sendControl({
          type: "transfer-progress",
          transferId: session.transferId,
          senderPeerId: context.myPeerId,
          roomId: context.roomId,
          transferredBytes: session.transferredBytes,
          completedPieces: session.completedPieces,
          requestedPieces: session.requestedPieces,
          inFlightPieces: session.inFlightPieces,
          speedBytesPerSecond: session.speedBytesPerSecond,
        });
      }

      if (
        session.pendingRequests.length === 0
        && session.status === "transferring"
        && session.completedPieces >= session.manifest.pieceCount
      ) {
        this.sendControl({
          type: "transfer-complete",
          transferId: session.transferId,
          senderPeerId: context.myPeerId,
          roomId: context.roomId,
          fileId: session.manifest.fileId,
        });
      }

      this.emitState();
    } catch (error) {
      session.status = "failed";
      session.message = error instanceof Error ? error.message : "Failed to send piece";
      session.updatedAt = now();
      this.sendControl({
        type: "transfer-error",
        transferId: session.transferId,
        senderPeerId: context.myPeerId,
        roomId: context.roomId,
        message: session.message,
      });
      this.emitState();
    } finally {
      session.requestQueueRunning = false;

      if (session.pendingRequests.length > 0 && this.transport?.isFileTransferReady()) {
        window.setTimeout(() => {
          void this.flushSenderQueue(session);
        }, 0);
      }
    }
  }

  private async handleRemoteComplete(transferId: string): Promise<void> {
    const session = this.sessions.get(transferId);
    if (!session || session.role !== "receiver") {
      return;
    }

    if (session.scheduler.isComplete() && !session.finalizeRequested) {
      await this.completeReceiverTransfer(session);
    }
  }

  private async completeReceiverTransfer(session: ReceiverSession): Promise<void> {
    if (session.finalizeRequested) {
      return;
    }

    session.finalizeRequested = true;
    session.status = "verifying";
    session.integrityStatus = "pending";
    session.message = "Verifying completed file";
    session.updatedAt = now();
    this.emitState();

    try {
      const result = await this.bridge.finalizeReceiverTransfer(session.receiverTransferId ?? session.transferId);
      session.status = "completed";
      session.integrityStatus = "verified";
      session.message = `Saved to ${result.savedPath}`;
      session.updatedAt = now();
      this.markFileDownloaded(session.manifest);
      this.emitState();
    } catch (error) {
      session.status = "failed";
      session.integrityStatus = "mismatch";
      session.message = error instanceof Error ? error.message : "Failed to save received file";
      session.updatedAt = now();
      this.emitState();
    }
  }

  private async handleRemoteCancel(transferId: string, reason: string): Promise<void> {
    const session = this.sessions.get(transferId);
    if (!session) {
      return;
    }

    await this.cleanupSession(session, "cancelled", reason);
  }

  private async handleRemoteError(transferId: string, message: string): Promise<void> {
    const session = this.sessions.get(transferId);
    if (!session) {
      return;
    }

    session.status = "failed";
    session.message = message;
    session.updatedAt = now();
    this.emitState();
  }

  private requestMorePieces(session: ReceiverSession): void {
    if (!this.transport?.isFileTransferReady()) {
      return;
    }

    const context = this.context;
    if (!context) {
      return;
    }

    const nowMs = now();
    const nextPieces = session.scheduler.getNextRequestPieces(nowMs);
    session.requestedPieces = session.scheduler.getRequestedCount();
    session.inFlightPieces = session.scheduler.getInflightCount();

    if (nextPieces.length > 0) {
      this.callbacks.onEvent(`receiver requesting piece(s) ${nextPieces.join(",")} for ${session.transferId}`);
    }

    for (const pieceIndex of nextPieces) {
      this.sendControl({
        type: "piece-request",
        transferId: session.transferId,
        senderPeerId: context?.myPeerId ?? "",
        receiverPeerId: session.manifest.senderPeerId,
        roomId: session.manifest.roomId,
        pieceIndex,
      });
    }

    session.status = session.scheduler.isComplete() ? "verifying" : "transferring";
    session.speedBytesPerSecond = this.calculateSpeed(session.transferredBytes, session.createdAt);
    session.updatedAt = now();
    this.emitState();
  }

  private calculateSpeed(bytesTransferred: number, startedAt: number): number {
    const elapsedSeconds = Math.max(1, (now() - startedAt) / 1000);
    return bytesTransferred / elapsedSeconds;
  }

  private applyRemoteProgress(
    transferId: string,
    transferredBytes: number,
    completedPieces: number,
    requestedPieces: number,
    inFlightPieces: number,
    speedBytesPerSecond: number,
  ): void {
    const session = this.sessions.get(transferId);
    if (!session) {
      return;
    }

    session.transferredBytes = transferredBytes;
    session.completedPieces = completedPieces;
    session.verifiedPieces = completedPieces;
    session.requestedPieces = requestedPieces;
    session.inFlightPieces = inFlightPieces;
    session.speedBytesPerSecond = speedBytesPerSecond;
    session.status = "transferring";
    session.updatedAt = now();
    this.emitState();
  }

  private async cleanupSession(session: TransferSession, status: FileTransferSummary["status"], message: string): Promise<void> {
    if (session.role === "receiver" && session.requestTimer !== null) {
      window.clearInterval(session.requestTimer);
      session.requestTimer = null;
      if (session.receiverTransferId) {
        await this.bridge.cancelReceiverTransfer(session.receiverTransferId).catch(() => undefined);
      }
    }

    session.status = status;
    session.message = message;
    session.updatedAt = now();
    this.emitState();
    this.sessions.delete(session.transferId);
  }

  private sendControl(message: FileTransferControlMessage): void {
    if (!this.transport?.isFileTransferReady()) {
      return;
    }

    this.transport.sendFileControlMessage(encodeControlMessage(message));
  }

  private startSenderTransfer(localRecord: LocalSharedFileRecord, receiverDisplayName: string): string | null {
    const context = this.context;
    if (!context) {
      return null;
    }

    const transferId = crypto.randomUUID();
    const session: SenderSession = {
      role: "sender",
      transferId,
      manifest: localRecord.manifest,
      filePath: localRecord.filePath,
      fileName: localRecord.manifest.fileName,
      senderDisplayName: localRecord.senderDisplayName,
      receiverDisplayName,
      status: "waiting-for-acceptance",
      integrityStatus: "pending",
      createdAt: now(),
      updatedAt: now(),
      transferredBytes: 0,
      verifiedPieces: 0,
      requestedPieces: 0,
      inFlightPieces: 0,
      completedPieces: 0,
      speedBytesPerSecond: 0,
      pieceAvailability: bitfieldAllOnes(localRecord.manifest.pieceCount),
      pendingRequests: [],
      requestQueueRunning: false,
    };

    this.sessions.set(transferId, session);
    this.upsertSharedCatalog(localRecord.manifest, localRecord.senderDisplayName, transferId);

    this.sendControl({
      type: "file-offer",
      transferId,
      senderPeerId: context.myPeerId,
      senderDisplayName: localRecord.senderDisplayName,
      manifest: localRecord.manifest,
    });
    this.sendControl({
      type: "file-manifest",
      transferId,
      senderPeerId: context.myPeerId,
      manifest: localRecord.manifest,
    });

    return transferId;
  }

  private upsertSharedCatalog(manifest: FileManifest, senderDisplayName: string, transferId: string): void {
    const key = `${manifest.senderPeerId}:${manifest.fileId}`;
    const existing = this.sharedCatalog.get(key);
    const downloadHistory = this.downloadHistory.get(key);
    const next: SharedFileCatalogItem = {
      fileId: manifest.fileId,
      transferId,
      fileName: manifest.fileName,
      mimeType: manifest.mimeType,
      fileSize: manifest.fileSize,
      pieceSize: manifest.pieceSize,
      pieceCount: manifest.pieceCount,
      roomId: manifest.roomId,
      senderPeerId: manifest.senderPeerId,
      senderDisplayName,
      createdAt: existing?.createdAt ?? manifest.createdAt,
      downloadedCount: downloadHistory?.count ?? 0,
      lastDownloadedAt: downloadHistory?.lastDownloadedAt ?? null,
      hasAcceptedOffer: existing?.hasAcceptedOffer ?? false,
    };

    this.sharedCatalog.set(key, next);
  }

  private markOfferAccepted(manifest: FileManifest): void {
    const key = `${manifest.senderPeerId}:${manifest.fileId}`;
    const existing = this.sharedCatalog.get(key);
    if (existing) {
      existing.hasAcceptedOffer = true;
      this.sharedCatalog.set(key, existing);
      return;
    }

    this.upsertSharedCatalog(manifest, "Peer", crypto.randomUUID());
    const created = this.sharedCatalog.get(key);
    if (created) {
      created.hasAcceptedOffer = true;
      this.sharedCatalog.set(key, created);
    }
  }

  private markFileDownloaded(manifest: FileManifest): void {
    const key = `${manifest.senderPeerId}:${manifest.fileId}`;
    const existing = this.downloadHistory.get(key);
    const next: DownloadHistoryEntry = {
      count: (existing?.count ?? 0) + 1,
      lastDownloadedAt: now(),
    };

    this.downloadHistory.set(key, next);

    const catalogItem = this.sharedCatalog.get(key);
    if (catalogItem) {
      catalogItem.downloadedCount = next.count;
      catalogItem.lastDownloadedAt = next.lastDownloadedAt;
      this.sharedCatalog.set(key, catalogItem);
    }
  }

  private emitState(): void {
    const state = emptyViewState();

    for (const offer of this.incomingOffers.values()) {
      state.incomingOffers.push(offer);
    }

    for (const session of this.sessions.values()) {
      state.activeTransfers.push(buildSummary(session));
    }

    const groupedBySender = new Map<string, SharedFilesBySender>();
    for (const item of this.sharedCatalog.values()) {
      const existingGroup = groupedBySender.get(item.senderPeerId);
      if (!existingGroup) {
        groupedBySender.set(item.senderPeerId, {
          senderPeerId: item.senderPeerId,
          senderDisplayName: item.senderDisplayName,
          files: [item],
        });
        continue;
      }

      existingGroup.files.push(item);
    }

    state.sharedFilesBySender = Array.from(groupedBySender.values()).map((group) => ({
      ...group,
      files: group.files.sort((left, right) => right.createdAt - left.createdAt),
    }));
    state.sharedFilesBySender.sort((left, right) => left.senderDisplayName.localeCompare(right.senderDisplayName));

    state.incomingOffers.sort((left, right) => right.createdAt - left.createdAt);
    state.activeTransfers.sort((left, right) => right.updatedAt - left.updatedAt);
    this.callbacks.onUpdate(state);
  }
}
