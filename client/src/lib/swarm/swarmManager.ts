import type { TorrentManifest } from "../../shared/fileTransfer";
import type {
    FileTransferViewState,
    SharedFilesBySender,
    SwarmIntegrityStatus,
    SwarmPeerRole,
    SwarmTransferDirection,
    SwarmTransferStatus,
    TorrentAnnouncement,
    TorrentSwarmSummary,
} from "../../types/fileTransfer";
import { sha256Hex } from "../fileTransfer/hash";
import { PieceScheduler } from "../fileTransfer/pieceScheduler";
import {
    DEFAULT_MAX_INFLIGHT_REQUESTS,
    DEFAULT_PIECE_REQUEST_TIMEOUT_MS,
    DEFAULT_PIECE_SIZE,
    base64ToBitfield,
    bitfieldToBase64,
    countBitfieldValues,
    createBitfield,
    decodeBinaryFrame,
    encodeBinaryFrame,
    encodeControlMessage,
    getBitfieldValue,
    setBitfieldValue,
    tryParseControlMessage,
    type SwarmControlMessage,
    type TorrentBinaryFrameHeader
} from "../fileTransfer/protocol";

type TransferRole = "seeder" | "leecher" | "partial-seeder";

interface TransferContext {
  roomId: string;
  myPeerId: string;
  myDisplayName: string;
  remotePeerId: string;
}

interface FileTransferBridge {
  selectFileForSharing: () => Promise<{ filePath: string; fileName: string; mimeType: string; fileSize: number } | null>;
  buildFileManifest: (filePath: string, roomId: string, senderPeerId: string, pieceSize: number) => Promise<TorrentManifest>;
  readFilePiece: (filePath: string, pieceIndex: number, pieceSize: number) => Promise<Uint8Array>;
  createReceiverTransfer: (manifest: TorrentManifest) => Promise<{ transferId: string; manifest: TorrentManifest; tempFilePath: string }>;
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
  onSeedableDownloadReady?: (preparedShare: PreparedLocalShare) => void;
}

export interface PreparedLocalShare {
  filePath: string;
  manifest: TorrentManifest;
  senderDisplayName: string;
}

interface LocalShareRecord {
  manifest: TorrentManifest;
  filePath: string;
  senderDisplayName: string;
  createdAt: number;
}

interface PeerTorrentState {
  peerId: string;
  displayName: string;
  bitfield: Uint8Array;
  interested: boolean;
  choked: boolean;
  uploadedBytes: number;
  downloadedBytes: number;
  inFlightUploads: number;
  inFlightDownloads: number;
  lastSeenAt: number;
  role: TransferRole;
}

interface TorrentRuntimeState {
  manifest: TorrentManifest;
  localRole: TransferRole;
  status: SwarmTransferStatus;
  integrityStatus: SwarmIntegrityStatus;
  filePath?: string;
  receiverTransferId?: string;
  pieceScheduler: PieceScheduler;
  localBitfield: Uint8Array;
  peerStates: Map<string, PeerTorrentState>;
  downloadedBytes: number;
  uploadedBytes: number;
  verifiedPieces: number;
  requestedPieces: number;
  inFlightPieces: number;
  completedPieces: number;
  speedBytesPerSecond: number;
  createdAt: number;
  updatedAt: number;
  finalizeRequested: boolean;
  message?: string;
  joinRequested: boolean;
  preferredSourcePeerId?: string;
  requestTimer: number | null;
  knownAnnouncements: Map<string, TorrentAnnouncement>;
  activeRequests: Map<number, { requestId: string; sourcePeerId: string; requestedAt: number }>;
  sourceManifestReceived: boolean;
}

interface RoomSwarmState {
  roomId: string;
  localShares: Map<string, LocalShareRecord>;
  torrents: Map<string, TorrentRuntimeState>;
  announcements: Map<string, TorrentAnnouncement>;
  acceptedAnnouncements: Map<string, TorrentAnnouncement>;
  rejectedAnnouncements: Map<string, TorrentAnnouncement>;
  downloadHistory: Map<string, { count: number; lastDownloadedAt: number }>;
}

interface DownloadRequestOptions {
  swarmTransferId?: string;
}

interface SharePreparedOptions {
  excludePeerIds?: string[];
}

function now(): number {
  return Date.now();
}

function isSaveCancelledError(error: unknown): boolean {
  return error instanceof Error && error.message === "Save cancelled";
}

function emptyViewState(): FileTransferViewState {
  return {
    incomingAnnouncements: [],
    rejectedAnnouncements: [],
    activeSwarms: [],
    acceptedSwarmsBySender: [],
  };
}

function formatDisplayRole(role: TransferRole): SwarmPeerRole {
  return role;
}

function roleToDirection(role: TransferRole): SwarmTransferDirection {
  return role === "seeder" ? "upload" : "download";
}

function createRoomState(roomId: string): RoomSwarmState {
  return {
    roomId,
    localShares: new Map<string, LocalShareRecord>(),
    torrents: new Map<string, TorrentRuntimeState>(),
    announcements: new Map<string, TorrentAnnouncement>(),
    acceptedAnnouncements: new Map<string, TorrentAnnouncement>(),
    rejectedAnnouncements: new Map<string, TorrentAnnouncement>(),
    downloadHistory: new Map<string, { count: number; lastDownloadedAt: number }>(),
  };
}

function summarizeCatalogKey(torrentId: string): string {
  return torrentId;
}

export class FileTransferManager {
  private static readonly peerManagers = new Map<string, FileTransferManager>();
  private static readonly roomStates = new Map<string, RoomSwarmState>();

  private readonly bridge: FileTransferBridge;
  private readonly callbacks: FileTransferCallbacks;
  private transport: FileTransferTransport | null = null;
  private context: TransferContext | null = null;

  constructor(bridge: FileTransferBridge, callbacks: FileTransferCallbacks) {
    this.bridge = bridge;
    this.callbacks = callbacks;
  }

  setTransport(transport: FileTransferTransport | null): void {
    this.transport = transport;
  }

  setContext(context: TransferContext | null): void {
    const previousRemotePeerId = this.context?.remotePeerId;
    if (previousRemotePeerId && FileTransferManager.peerManagers.get(previousRemotePeerId) === this) {
      FileTransferManager.peerManagers.delete(previousRemotePeerId);
    }

    this.context = context;

    if (context) {
      FileTransferManager.peerManagers.set(context.remotePeerId, this);
      this.ensureRoomState(context.roomId);
    }

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

    try {
      const manifest = await this.bridge.buildFileManifest(selected.filePath, this.context.roomId, this.context.myPeerId, pieceSize);
      return {
        filePath: selected.filePath,
        manifest,
        senderDisplayName: this.context.myDisplayName,
      };
    } catch (error) {
      this.callbacks.onEvent(error instanceof Error ? `error: ${error.message}` : "error: failed to build file manifest");
      return null;
    }
  }

  async shareFile(): Promise<void> {
    const preparedShare = await this.prepareShareFile();
    if (!preparedShare) {
      return;
    }

    this.sharePreparedFile(preparedShare);
  }

  sharePreparedFile(preparedShare: PreparedLocalShare, options?: SharePreparedOptions): string | null {
    if (!this.context || !this.transport?.isFileTransferReady()) {
      return null;
    }

    const excludedPeers = new Set(options?.excludePeerIds ?? []);

    const room = this.ensureRoomState(this.context.roomId);
    const knownTorrentAlreadyOffered =
      room.announcements.has(preparedShare.manifest.torrentId)
      || room.acceptedAnnouncements.has(preparedShare.manifest.torrentId)
      || room.rejectedAnnouncements.has(preparedShare.manifest.torrentId);

    room.localShares.set(preparedShare.manifest.torrentId, {
      manifest: preparedShare.manifest,
      filePath: preparedShare.filePath,
      senderDisplayName: preparedShare.senderDisplayName,
      createdAt: now(),
    });

    const session = this.ensureSeederSession(room, preparedShare.manifest, preparedShare.filePath, preparedShare.senderDisplayName);
    if (!knownTorrentAlreadyOffered) {
      this.broadcastTorrentAnnouncement(session.manifest, preparedShare.senderDisplayName, excludedPeers);
      this.broadcastTorrentManifest(session.manifest, preparedShare.senderDisplayName, excludedPeers);
      this.broadcastTorrentJoin(session.manifest, true, excludedPeers);
      this.broadcastBitfield(session.manifest.torrentId, session.manifest, session.localBitfield, excludedPeers);
    }

    this.emitState();
    this.callbacks.onEvent(
      knownTorrentAlreadyOffered
        ? `seeding enabled without rebroadcast: ${preparedShare.manifest.fileName}`
        : `file shared as private swarm: ${preparedShare.manifest.fileName}`,
    );
    return preparedShare.manifest.torrentId;
  }

  requestDownload(torrentId: string, sourcePeerId: string, options?: DownloadRequestOptions): void {
    if (!this.context || !this.transport?.isFileTransferReady()) {
      return;
    }

    const room = this.ensureRoomState(this.context.roomId);
    const catalogItem = room.announcements.get(summarizeCatalogKey(torrentId));
    const acceptedItem = room.acceptedAnnouncements.get(torrentId);
    const rejectedItem = room.rejectedAnnouncements.get(torrentId);
    const localShare = room.localShares.get(torrentId);
    const manifest = localShare?.manifest ?? catalogItem?.manifest ?? acceptedItem?.manifest ?? rejectedItem?.manifest;

    if (!manifest) {
      this.callbacks.onEvent("download blocked: no manifest available for this swarm yet");
      return;
    }

    const senderDisplayName = catalogItem?.senderDisplayName
      ?? acceptedItem?.senderDisplayName
      ?? rejectedItem?.senderDisplayName
      ?? sourcePeerId;

    const session = this.ensureDownloadSession(room, manifest, senderDisplayName);

    // Move item into Accepted list whenever a peer joins/rejoins the swarm.
    const acceptedAnnouncement: TorrentAnnouncement = catalogItem
      ?? acceptedItem
      ?? rejectedItem
      ?? {
        torrentId,
        roomId: manifest.roomId,
        manifest,
        senderPeerId: sourcePeerId,
        senderDisplayName,
        announcedAt: now(),
      };

    room.announcements.delete(torrentId);
    room.rejectedAnnouncements.delete(torrentId);
    room.acceptedAnnouncements.set(torrentId, acceptedAnnouncement);

    session.joinRequested = true;
    session.preferredSourcePeerId = sourcePeerId;
    session.status = session.localRole === "leecher" ? "downloading" : session.status;

    if (options?.swarmTransferId && options.swarmTransferId !== torrentId) {
      this.callbacks.onEvent("warning: ignored mismatched swarm transfer id");
    }

    this.broadcastTorrentJoin(session.manifest, true);
    this.sendToPeer(sourcePeerId, {
      type: "interested",
      torrentId: session.manifest.torrentId,
      roomId: session.manifest.roomId,
      senderPeerId: this.context.myPeerId,
      senderDisplayName: this.context.myDisplayName,
    });

    if (!session.filePath || !session.receiverTransferId) {
      session.message = "Preparing download storage..."
      session.updatedAt = now();
      this.emitState();
      this.callbacks.onEvent(`joining swarm for ${session.manifest.fileName}; waiting for local storage`);
      return;
    }

    this.requestMorePieces(session);
    this.emitState();
    this.callbacks.onEvent(`joined swarm for ${session.manifest.fileName}`);
  }

  cancelTransfer(torrentId: string, reason = "Cancelled by user"): void {
    const room = this.currentRoomState();
    if (!room || !this.context) {
      return;
    }

    const session = room.torrents.get(torrentId);
    if (!session) {
      return;
    }

    session.joinRequested = false;
    session.preferredSourcePeerId = undefined;

    this.sendToAllPeers({
      type: "transfer-cancel",
      torrentId,
      roomId: this.context.roomId,
      senderPeerId: this.context.myPeerId,
      senderDisplayName: this.context.myDisplayName,
      reason,
    });

    void this.cleanupTorrentSession(session, "cancelled", reason);
  }

  rejectAnnouncement(torrentId: string, senderPeerId: string, reason = "Declined by receiver"): void {
    const room = this.currentRoomState();
    if (!room || !this.context) {
      return;
    }

    const announcement = room.announcements.get(summarizeCatalogKey(torrentId))
      ?? room.acceptedAnnouncements.get(torrentId)
      ?? room.rejectedAnnouncements.get(torrentId);
    if (announcement) {
      room.rejectedAnnouncements.set(torrentId, announcement);
    }
    room.announcements.delete(summarizeCatalogKey(torrentId));
    room.acceptedAnnouncements.delete(torrentId);

    this.sendToPeer(senderPeerId, {
      type: "not-interested",
      torrentId,
      roomId: this.context.roomId,
      senderPeerId: this.context.myPeerId,
      senderDisplayName: this.context.myDisplayName,
    });

    this.sendToPeer(senderPeerId, {
      type: "transfer-cancel",
      torrentId,
      roomId: this.context.roomId,
      senderPeerId: this.context.myPeerId,
      senderDisplayName: this.context.myDisplayName,
      reason,
    });

    const session = room.torrents.get(torrentId);
    if (session && session.localRole === "leecher") {
      void this.cleanupTorrentSession(session, "cancelled", reason);
      room.torrents.delete(torrentId);
    }

    this.emitState();
    this.callbacks.onEvent(`rejected incoming file announcement for ${torrentId.slice(0, 12)}...`);
  }

  detachFromPeer(peerId: string): void {
    const context = this.context;
    if (context && context.remotePeerId === peerId) {
      FileTransferManager.peerManagers.delete(peerId);
    }

    for (const room of FileTransferManager.roomStates.values()) {
      for (const session of room.torrents.values()) {
        if (!session.peerStates.has(peerId)) {
          continue;
        }

        session.peerStates.delete(peerId);
        const affectedPieces = session.pieceScheduler.clearPeerAssignments(peerId);
        for (const pieceIndex of affectedPieces) {
          session.pieceScheduler.markMissing(pieceIndex);
          session.activeRequests.delete(pieceIndex);
        }

        if (session.status === "downloading") {
          this.requestMorePieces(session);
        }
      }
    }

    this.emitState();
  }

  resetRoom(reason: string): void {
    const context = this.context;
    if (!context) {
      return;
    }

    const room = FileTransferManager.roomStates.get(context.roomId);
    if (room) {
      for (const session of room.torrents.values()) {
        void this.cleanupTorrentSession(session, "cancelled", reason);
      }

      FileTransferManager.roomStates.delete(context.roomId);
    }

    if (FileTransferManager.peerManagers.get(context.remotePeerId) === this) {
      FileTransferManager.peerManagers.delete(context.remotePeerId);
    }

    this.emitState();
  }

  async handleControlMessage(raw: string): Promise<void> {
    const message = tryParseControlMessage(raw);
    if (!message || !this.context) {
      return;
    }

    const room = this.ensureRoomState(this.context.roomId);

    switch (message.type) {
      case "torrent-announcement":
        if (room.rejectedAnnouncements.has(message.torrentId) || room.acceptedAnnouncements.has(message.torrentId)) {
          return;
        }
        room.announcements.set(summarizeCatalogKey(message.torrentId), {
          torrentId: message.torrentId,
          roomId: message.roomId,
          manifest: message.manifest,
          senderPeerId: message.senderPeerId,
          senderDisplayName: message.senderDisplayName,
          announcedAt: message.announcedAt,
        });
        this.emitState();
        return;

      case "torrent-join": {
        const session = room.torrents.get(message.torrentId);
        if (!session) {
          return;
        }

        const peerState = this.ensurePeerState(session, message.senderPeerId, message.senderDisplayName);
        peerState.interested = message.interested;
        peerState.lastSeenAt = now();
        if (session.localRole !== "leecher") {
          this.sendManifestAndBitfield(session, message.senderPeerId);
          if (session.localRole === "seeder" || session.localRole === "partial-seeder") {
            this.sendToPeer(message.senderPeerId, {
              type: "unchoke",
              torrentId: session.manifest.torrentId,
              roomId: session.manifest.roomId,
              senderPeerId: this.context.myPeerId,
              senderDisplayName: this.context.myDisplayName,
              reason: "ready",
            });
          }
        }

        this.emitState();
        return;
      }

      case "torrent-leave":
        this.detachFromPeer(message.senderPeerId);
        return;

      case "torrent-manifest": {
        if (room.rejectedAnnouncements.has(message.torrentId) || room.acceptedAnnouncements.has(message.torrentId)) {
          return;
        }
        room.announcements.set(summarizeCatalogKey(message.torrentId), {
          torrentId: message.torrentId,
          roomId: message.roomId,
          manifest: message.manifest,
          senderPeerId: message.senderPeerId,
          senderDisplayName: message.senderDisplayName,
          announcedAt: now(),
        });
        this.emitState();
        return;
      }

      case "bitfield": {
        const session = room.torrents.get(message.torrentId);
        if (!session) {
          return;
        }

        const peerState = this.ensurePeerState(session, message.senderPeerId, message.senderDisplayName);
        peerState.bitfield = base64ToBitfield(message.availablePieces);
        peerState.lastSeenAt = now();
        this.requestMorePieces(session);
        this.emitState();
        return;
      }

      case "have": {
        const session = room.torrents.get(message.torrentId);
        if (!session) {
          return;
        }

        const peerState = this.ensurePeerState(session, message.senderPeerId, message.senderDisplayName);
        setBitfieldValue(peerState.bitfield, message.pieceIndex, true);
        peerState.lastSeenAt = now();
        this.requestMorePieces(session);
        this.emitState();
        return;
      }

      case "interested": {
        const session = room.torrents.get(message.torrentId);
        if (!session) {
          return;
        }

        const peerState = this.ensurePeerState(session, message.senderPeerId, message.senderDisplayName);
        peerState.interested = true;
        peerState.lastSeenAt = now();
        this.emitState();
        return;
      }

      case "not-interested": {
        const session = room.torrents.get(message.torrentId);
        if (!session) {
          return;
        }

        const peerState = this.ensurePeerState(session, message.senderPeerId, message.senderDisplayName);
        peerState.interested = false;
        peerState.lastSeenAt = now();
        this.emitState();
        return;
      }

      case "request-piece":
        await this.handlePieceRequest(message);
        return;

      case "cancel-piece":
        this.handleCancelledPiece(message);
        return;

      case "reject-piece":
        this.handleRejectedPiece(message);
        return;

      case "piece-verified":
        this.handlePeerVerifiedPiece(message);
        return;

      case "transfer-complete":
        this.handlePeerComplete(message);
        return;

      case "transfer-cancel":
        this.handlePeerCancelled(message);
        return;

      case "transfer-error":
        this.handlePeerError(message);
        return;

      case "choke":
        this.handleChoke(message);
        return;

      case "unchoke":
        this.handleUnchoke(message);
        return;
    }
  }

  async handleBinaryMessage(data: ArrayBuffer | Uint8Array): Promise<void> {
    const frame = decodeBinaryFrame(data);
    const room = FileTransferManager.roomStates.get(frame.header.roomId);
    const session = room?.torrents.get(frame.header.torrentId);
    if (!room || !session || !this.context) {
      return;
    }

    const record = session.activeRequests.get(frame.header.pieceIndex);
    if (!record) {
      return;
    }

    if (record.requestId !== frame.header.requestId) {
      return;
    }

    if (frame.header.byteLength !== frame.payload.byteLength) {
      await this.requeueFailedPiece(session, frame.header.pieceIndex, record.sourcePeerId, "corrupt piece received");
      return;
    }

    const expectedHash = frame.header.pieceHash || session.manifest.pieceHashes[frame.header.pieceIndex];
    const actualHash = await sha256Hex(frame.payload);
    if (expectedHash !== actualHash) {
      await this.requeueFailedPiece(session, frame.header.pieceIndex, record.sourcePeerId, "integrity mismatch");
      this.sendToPeer(record.sourcePeerId, {
        type: "reject-piece",
        torrentId: session.manifest.torrentId,
        roomId: session.manifest.roomId,
        senderPeerId: this.context.myPeerId,
        receiverPeerId: record.sourcePeerId,
        pieceIndex: frame.header.pieceIndex,
        requestId: record.requestId,
        reason: "integrity mismatch",
      });
      return;
    }

    const receiverTransferId = session.receiverTransferId ?? session.manifest.torrentId;

    try {
      await this.bridge.writeReceiverPiece(receiverTransferId, frame.header.pieceIndex, frame.payload);
    } catch (error) {
      await this.requeueFailedPiece(session, frame.header.pieceIndex, record.sourcePeerId, error instanceof Error ? error.message : "failed to persist piece");
      return;
    }

    setBitfieldValue(session.localBitfield, frame.header.pieceIndex, true);
    session.pieceScheduler.markVerified(frame.header.pieceIndex);
    session.activeRequests.delete(frame.header.pieceIndex);
    session.requestedPieces = session.pieceScheduler.getRequestedCount();
    session.completedPieces = session.pieceScheduler.getCompletedCount();
    session.verifiedPieces = session.completedPieces;
    session.inFlightPieces = session.pieceScheduler.getInflightCount();
    session.downloadedBytes += frame.payload.byteLength;
    session.updatedAt = now();
    session.message = undefined;

    this.broadcastHave(session.manifest, frame.header.pieceIndex);
    this.broadcastPieceVerified(session.manifest, frame.header.pieceIndex);
    this.callbacks.onEvent(`verified piece ${frame.header.pieceIndex} for ${session.manifest.fileName}`);

    if (session.pieceScheduler.isComplete()) {
      await this.completeReceiverTransfer(session);
      return;
    }

    this.requestMorePieces(session);
    this.emitState();
  }

  private ensureRoomState(roomId: string): RoomSwarmState {
    const existing = FileTransferManager.roomStates.get(roomId);
    if (existing) {
      return existing;
    }

    const created = createRoomState(roomId);
    FileTransferManager.roomStates.set(roomId, created);
    return created;
  }

  private currentRoomState(): RoomSwarmState | null {
    if (!this.context) {
      return null;
    }

    return FileTransferManager.roomStates.get(this.context.roomId) ?? null;
  }

  private ensureSeederSession(room: RoomSwarmState, manifest: TorrentManifest, filePath: string, senderDisplayName: string): TorrentRuntimeState {
    const existing = room.torrents.get(manifest.torrentId);
    if (existing) {
      existing.localRole = "seeder";
      existing.status = "seeding";
      existing.integrityStatus = "verified";
      existing.filePath = filePath;
      existing.updatedAt = now();
      existing.message = undefined;
      return existing;
    }

    const localBitfield = createBitfield(manifest.pieceCount);
    for (let pieceIndex = 0; pieceIndex < manifest.pieceCount; pieceIndex += 1) {
      setBitfieldValue(localBitfield, pieceIndex, true);
    }

    const session: TorrentRuntimeState = {
      manifest,
      localRole: "seeder",
      status: "seeding",
      integrityStatus: "verified",
      filePath,
      pieceScheduler: new PieceScheduler(manifest.pieceCount, DEFAULT_MAX_INFLIGHT_REQUESTS, DEFAULT_PIECE_REQUEST_TIMEOUT_MS),
      localBitfield,
      peerStates: new Map<string, PeerTorrentState>(),
      downloadedBytes: 0,
      uploadedBytes: 0,
      verifiedPieces: manifest.pieceCount,
      requestedPieces: 0,
      inFlightPieces: 0,
      completedPieces: manifest.pieceCount,
      speedBytesPerSecond: 0,
      createdAt: now(),
      updatedAt: now(),
      finalizeRequested: false,
      joinRequested: false,
      preferredSourcePeerId: undefined,
      requestTimer: null,
      knownAnnouncements: new Map<string, TorrentAnnouncement>(),
      activeRequests: new Map<number, { requestId: string; sourcePeerId: string; requestedAt: number }>(),
      sourceManifestReceived: true,
    };

    room.torrents.set(manifest.torrentId, session);
    this.ensurePeerState(session, manifest.initialSeederPeerId, senderDisplayName).role = "seeder";
    return session;
  }

  private ensureDownloadSession(room: RoomSwarmState, manifest: TorrentManifest, senderDisplayName: string): TorrentRuntimeState {
    const existing = room.torrents.get(manifest.torrentId);
    if (existing) {
      existing.knownAnnouncements.set(manifest.initialSeederPeerId, {
        torrentId: manifest.torrentId,
        roomId: manifest.roomId,
        manifest,
        senderPeerId: manifest.initialSeederPeerId,
        senderDisplayName,
        announcedAt: now(),
      });
      return existing;
    }

    const receiverTransfer = this.bridge.createReceiverTransfer(manifest);
    const session: TorrentRuntimeState = {
      manifest,
      localRole: "leecher",
      status: manifest.pieceCount === 0 ? "verifying" : "downloading",
      integrityStatus: "pending",
      filePath: undefined,
      pieceScheduler: new PieceScheduler(manifest.pieceCount, DEFAULT_MAX_INFLIGHT_REQUESTS, DEFAULT_PIECE_REQUEST_TIMEOUT_MS),
      localBitfield: createBitfield(manifest.pieceCount),
      peerStates: new Map<string, PeerTorrentState>(),
      downloadedBytes: 0,
      uploadedBytes: 0,
      verifiedPieces: 0,
      requestedPieces: 0,
      inFlightPieces: 0,
      completedPieces: 0,
      speedBytesPerSecond: 0,
      createdAt: now(),
      updatedAt: now(),
      finalizeRequested: false,
      joinRequested: false,
      preferredSourcePeerId: undefined,
      requestTimer: null,
      knownAnnouncements: new Map<string, TorrentAnnouncement>(),
      activeRequests: new Map<number, { requestId: string; sourcePeerId: string; requestedAt: number }>(),
      sourceManifestReceived: true,
    };

    room.torrents.set(manifest.torrentId, session);
    void receiverTransfer.then((handle) => {
      const active = room.torrents.get(manifest.torrentId);
      if (!active) {
        void this.bridge.cancelReceiverTransfer(handle.transferId).catch(() => undefined);
        return;
      }

      active.receiverTransferId = handle.transferId;
      active.filePath = handle.tempFilePath;
      if (active.joinRequested && active.preferredSourcePeerId && this.context) {
        this.sendToPeer(active.preferredSourcePeerId, {
          type: "interested",
          torrentId: active.manifest.torrentId,
          roomId: active.manifest.roomId,
          senderPeerId: this.context.myPeerId,
          senderDisplayName: this.context.myDisplayName,
        });
      }
      if (active.pieceScheduler.isComplete()) {
        void this.completeReceiverTransfer(active);
      } else {
        this.startDownloadTimer(active);
        if (active.joinRequested) {
          active.message = "Download started";
          this.requestMorePieces(active);
        }
      }
      this.emitState();
    }).catch((error) => {
      session.status = "failed";
      session.message = error instanceof Error ? error.message : "failed to create receiver transfer";
      session.integrityStatus = "failed";
      session.updatedAt = now();
      this.emitState();
    });

    return session;
  }

  private ensurePeerState(session: TorrentRuntimeState, peerId: string, displayName: string): PeerTorrentState {
    const existing = session.peerStates.get(peerId);
    if (existing) {
      existing.displayName = displayName;
      existing.lastSeenAt = now();
      return existing;
    }

    const peerState: PeerTorrentState = {
      peerId,
      displayName,
      bitfield: createBitfield(session.manifest.pieceCount),
      interested: false,
      choked: false,
      uploadedBytes: 0,
      downloadedBytes: 0,
      inFlightUploads: 0,
      inFlightDownloads: 0,
      lastSeenAt: now(),
      role: "leecher",
    };

    session.peerStates.set(peerId, peerState);
    return peerState;
  }

  private startDownloadTimer(session: TorrentRuntimeState): void {
    if (session.requestTimer !== null) {
      return;
    }

    session.requestTimer = window.setInterval(() => {
      const room = this.currentRoomState();
      const active = room?.torrents.get(session.manifest.torrentId);
      if (!active) {
        if (session.requestTimer !== null) {
          window.clearInterval(session.requestTimer);
          session.requestTimer = null;
        }
        return;
      }

      const timedOutPieces = active.pieceScheduler.consumeTimedOutPieces(now());
      if (timedOutPieces.length > 0) {
        for (const timeout of timedOutPieces) {
          if (timeout.sourcePeerId) {
            this.sendToPeer(timeout.sourcePeerId, {
              type: "cancel-piece",
              torrentId: active.manifest.torrentId,
              roomId: active.manifest.roomId,
              senderPeerId: this.context?.myPeerId ?? active.manifest.initialSeederPeerId,
              receiverPeerId: timeout.sourcePeerId,
              pieceIndex: timeout.pieceIndex,
              requestId: active.activeRequests.get(timeout.pieceIndex)?.requestId ?? crypto.randomUUID(),
              reason: "request timed out",
            });
          }
          active.activeRequests.delete(timeout.pieceIndex);
        }
        active.status = "downloading";
        active.message = `retrying ${timedOutPieces.length} timed out piece(s)`;
        active.updatedAt = now();
        this.requestMorePieces(active);
      }

      this.emitState();
    }, 2500);
  }

  private buildPeerInflightMap(session: TorrentRuntimeState): Map<string, number> {
    const map = new Map<string, number>();
    for (const [peerId, peer] of session.peerStates.entries()) {
      map.set(peerId, peer.inFlightUploads);
    }

    return map;
  }

  private requestMorePieces(session: TorrentRuntimeState): void {
    if (!this.context || !this.transport?.isFileTransferReady() || session.status === "cancelled" || session.status === "failed") {
      return;
    }

    if (session.localRole === "seeder") {
      return;
    }

    const peerBitfields = new Map<string, Uint8Array>();
    for (const [peerId, peerState] of session.peerStates.entries()) {
      if (peerState.choked) {
        continue;
      }

      if (countBitfieldValues(peerState.bitfield, session.manifest.pieceCount) === 0) {
        continue;
      }

      peerBitfields.set(peerId, peerState.bitfield);
    }

    if (peerBitfields.size === 0) {
      return;
    }

    const requests = session.pieceScheduler.selectRequests(
      session.localBitfield,
      peerBitfields,
      this.buildPeerInflightMap(session),
      now(),
    );

    for (const request of requests) {
      const sourcePeer = session.peerStates.get(request.sourcePeerId);
      if (!sourcePeer) {
        continue;
      }

      sourcePeer.inFlightUploads += 1;
      session.inFlightPieces = session.pieceScheduler.getInflightCount();
      session.requestedPieces = session.pieceScheduler.getRequestedCount();
      const requestId = crypto.randomUUID();
      session.activeRequests.set(request.pieceIndex, {
        requestId,
        sourcePeerId: request.sourcePeerId,
        requestedAt: now(),
      });

      this.sendToPeer(request.sourcePeerId, {
        type: "request-piece",
        torrentId: session.manifest.torrentId,
        roomId: session.manifest.roomId,
        senderPeerId: this.context.myPeerId,
        receiverPeerId: request.sourcePeerId,
        pieceIndex: request.pieceIndex,
        requestId,
      });
    }

    session.status = session.pieceScheduler.isComplete() ? "verifying" : session.localRole === "leecher" ? "downloading" : "partial-seeding";
    session.updatedAt = now();
    this.emitState();
  }

  private async handlePieceRequest(message: Extract<SwarmControlMessage, { type: "request-piece" }>): Promise<void> {
    const room = this.currentRoomState();
    if (!room || !this.context) {
      return;
    }

    const session = room.torrents.get(message.torrentId);
    if (!session || !session.filePath) {
      this.sendToPeer(message.senderPeerId, {
        type: "reject-piece",
        torrentId: message.torrentId,
        roomId: message.roomId,
        senderPeerId: this.context.myPeerId,
        receiverPeerId: message.senderPeerId,
        pieceIndex: message.pieceIndex,
        requestId: message.requestId,
        reason: "swarm unavailable",
      });
      return;
    }

    const sourcePieceAvailable = getBitfieldValue(session.localBitfield, message.pieceIndex);
    if (!sourcePieceAvailable) {
      this.sendToPeer(message.senderPeerId, {
        type: "reject-piece",
        torrentId: session.manifest.torrentId,
        roomId: session.manifest.roomId,
        senderPeerId: this.context.myPeerId,
        receiverPeerId: message.senderPeerId,
        pieceIndex: message.pieceIndex,
        requestId: message.requestId,
        reason: "piece not verified yet",
      });
      return;
    }

    const peerState = this.ensurePeerState(session, message.senderPeerId, message.senderPeerId);
    if (peerState.choked) {
      this.sendToPeer(message.senderPeerId, {
        type: "reject-piece",
        torrentId: session.manifest.torrentId,
        roomId: session.manifest.roomId,
        senderPeerId: this.context.myPeerId,
        receiverPeerId: message.senderPeerId,
        pieceIndex: message.pieceIndex,
        requestId: message.requestId,
        reason: "peer choked",
      });
      return;
    }

    peerState.inFlightUploads += 1;
    session.status = session.localRole === "seeder" ? "seeding" : "partial-seeding";
    session.updatedAt = now();

    try {
      const payload = await this.bridge.readFilePiece(session.filePath, message.pieceIndex, session.manifest.pieceSize);
      const header: TorrentBinaryFrameHeader = {
        type: "piece-data",
        torrentId: session.manifest.torrentId,
        roomId: session.manifest.roomId,
        senderPeerId: this.context.myPeerId,
        receiverPeerId: message.senderPeerId,
        pieceIndex: message.pieceIndex,
        byteLength: payload.byteLength,
        pieceHash: session.manifest.pieceHashes[message.pieceIndex],
        requestId: message.requestId,
      };

      const frame = encodeBinaryFrame(header, payload);
      if (!this.transport?.sendFileDataMessage(frame)) {
        this.sendToPeer(message.senderPeerId, {
          type: "reject-piece",
          torrentId: session.manifest.torrentId,
          roomId: session.manifest.roomId,
          senderPeerId: this.context.myPeerId,
          receiverPeerId: message.senderPeerId,
          pieceIndex: message.pieceIndex,
          requestId: message.requestId,
          reason: "upload buffer full",
        });
        return;
      }

      peerState.uploadedBytes += payload.byteLength;
      session.uploadedBytes += payload.byteLength;
      session.speedBytesPerSecond = this.calculateSpeed(session.uploadedBytes, session.createdAt);
      session.updatedAt = now();
      this.sendToPeer(message.senderPeerId, {
        type: "unchoke",
        torrentId: session.manifest.torrentId,
        roomId: session.manifest.roomId,
        senderPeerId: this.context.myPeerId,
        senderDisplayName: this.context.myDisplayName,
        reason: "piece in flight",
      });
      this.callbacks.onEvent(`served piece ${message.pieceIndex} for ${session.manifest.fileName}`);
      this.emitState();
    } catch (error) {
      this.sendToPeer(message.senderPeerId, {
        type: "reject-piece",
        torrentId: session.manifest.torrentId,
        roomId: session.manifest.roomId,
        senderPeerId: this.context.myPeerId,
        receiverPeerId: message.senderPeerId,
        pieceIndex: message.pieceIndex,
        requestId: message.requestId,
        reason: error instanceof Error ? error.message : "failed to read piece",
      });
    } finally {
      peerState.inFlightUploads = Math.max(0, peerState.inFlightUploads - 1);
    }
  }

  private handleCancelledPiece(message: Extract<SwarmControlMessage, { type: "cancel-piece" }>): void {
    const room = this.currentRoomState();
    const session = room?.torrents.get(message.torrentId);
    if (!room || !session) {
      return;
    }

    session.activeRequests.delete(message.pieceIndex);
    const sourcePeer = session.peerStates.get(message.receiverPeerId);
    if (sourcePeer) {
      sourcePeer.inFlightUploads = Math.max(0, sourcePeer.inFlightUploads - 1);
    }
    session.pieceScheduler.markFailed(message.pieceIndex);
    this.requestMorePieces(session);
  }

  private handleRejectedPiece(message: Extract<SwarmControlMessage, { type: "reject-piece" }>): void {
    const room = this.currentRoomState();
    const session = room?.torrents.get(message.torrentId);
    if (!room || !session) {
      return;
    }

    session.activeRequests.delete(message.pieceIndex);
    session.pieceScheduler.markFailed(message.pieceIndex);
    session.message = message.reason;
    session.updatedAt = now();
    this.requestMorePieces(session);
    this.emitState();
  }

  private handlePeerVerifiedPiece(message: Extract<SwarmControlMessage, { type: "piece-verified" }>): void {
    const room = this.currentRoomState();
    const session = room?.torrents.get(message.torrentId);
    if (!room || !session) {
      return;
    }

    const peerState = this.ensurePeerState(session, message.senderPeerId, message.senderDisplayName);
    setBitfieldValue(peerState.bitfield, message.pieceIndex, true);
    this.requestMorePieces(session);
  }

  private handlePeerComplete(message: Extract<SwarmControlMessage, { type: "transfer-complete" }>): void {
    const room = this.currentRoomState();
    const session = room?.torrents.get(message.torrentId);
    if (!room || !session) {
      return;
    }

    const peerState = this.ensurePeerState(session, message.senderPeerId, message.senderDisplayName);
    peerState.role = "seeder";
    peerState.lastSeenAt = now();
    this.emitState();
  }

  private handlePeerCancelled(message: Extract<SwarmControlMessage, { type: "transfer-cancel" }>): void {
    const room = this.currentRoomState();
    const session = room?.torrents.get(message.torrentId);
    if (!room || !session) {
      return;
    }

    const peerState = session.peerStates.get(message.senderPeerId);
    if (peerState) {
      peerState.choked = false;
      peerState.interested = false;
      peerState.lastSeenAt = now();
    }

    if (message.senderPeerId === this.context?.myPeerId) {
      void this.cleanupTorrentSession(session, "cancelled", message.reason);
    }
    this.emitState();
  }

  private handlePeerError(message: Extract<SwarmControlMessage, { type: "transfer-error" }>): void {
    const room = this.currentRoomState();
    const session = room?.torrents.get(message.torrentId);
    if (!room || !session) {
      return;
    }

    session.status = "failed";
    session.message = message.message;
    session.updatedAt = now();
    this.emitState();
  }

  private handleChoke(message: Extract<SwarmControlMessage, { type: "choke" }>): void {
    const room = this.currentRoomState();
    const session = room?.torrents.get(message.torrentId);
    if (!room || !session) {
      return;
    }

    const peerState = this.ensurePeerState(session, message.senderPeerId, message.senderDisplayName);
    peerState.choked = true;
    peerState.lastSeenAt = now();
    session.message = message.reason ?? session.message;
    this.emitState();
  }

  private handleUnchoke(message: Extract<SwarmControlMessage, { type: "unchoke" }>): void {
    const room = this.currentRoomState();
    const session = room?.torrents.get(message.torrentId);
    if (!room || !session) {
      return;
    }

    const peerState = this.ensurePeerState(session, message.senderPeerId, message.senderDisplayName);
    peerState.choked = false;
    peerState.lastSeenAt = now();
    if (message.senderPeerId === this.context?.myPeerId) {
      session.message = message.reason;
    }
    this.requestMorePieces(session);
    this.emitState();
  }

  private async completeReceiverTransfer(session: TorrentRuntimeState): Promise<void> {
    if (session.finalizeRequested || !this.context) {
      return;
    }

    session.finalizeRequested = true;
    session.status = "verifying";
    session.integrityStatus = "pending";
    session.message = "verifying completed file";
    session.updatedAt = now();
    this.emitState();

    try {
      const result = await this.bridge.finalizeReceiverTransfer(session.receiverTransferId ?? session.manifest.torrentId);
      session.status = "completed";
      session.integrityStatus = "verified";
      session.message = `saved to ${result.savedPath}`;
      session.updatedAt = now();
      session.localRole = "partial-seeder";
      this.markFileDownloaded(session.manifest);

      this.callbacks.onSeedableDownloadReady?.({
        filePath: result.savedPath,
        manifest: {
          ...session.manifest,
          initialSeederPeerId: this.context.myPeerId,
          createdAt: now(),
        },
        senderDisplayName: this.context.myDisplayName,
      });

      this.sendToAllPeers({
        type: "transfer-complete",
        torrentId: session.manifest.torrentId,
        roomId: session.manifest.roomId,
        senderPeerId: this.context.myPeerId,
        senderDisplayName: this.context.myDisplayName,
      });

      this.emitState();
    } catch (error) {
      if (isSaveCancelledError(error)) {
        session.status = "cancelled";
        session.integrityStatus = "pending";
        session.message = "Save cancelled";
        session.updatedAt = now();
        if (session.receiverTransferId) {
          await this.bridge.cancelReceiverTransfer(session.receiverTransferId).catch(() => undefined);
        }
        this.emitState();
        return;
      }

      session.status = "failed";
      session.integrityStatus = "mismatch";
      session.message = error instanceof Error ? error.message : "failed to save received file";
      session.updatedAt = now();
      this.emitState();
    }
  }

  private async requeueFailedPiece(session: TorrentRuntimeState, pieceIndex: number, sourcePeerId: string, reason: string): Promise<void> {
    session.activeRequests.delete(pieceIndex);
    session.pieceScheduler.markFailed(pieceIndex);
    const sourcePeer = session.peerStates.get(sourcePeerId);
    if (sourcePeer) {
      sourcePeer.inFlightUploads = Math.max(0, sourcePeer.inFlightUploads - 1);
    }

    session.status = "downloading";
    session.message = reason;
    session.updatedAt = now();
    this.requestMorePieces(session);
    this.emitState();
  }

  private async cleanupTorrentSession(session: TorrentRuntimeState, status: SwarmTransferStatus, message: string): Promise<void> {
    if (session.requestTimer !== null) {
      window.clearInterval(session.requestTimer);
      session.requestTimer = null;
    }

    if (session.receiverTransferId) {
      await this.bridge.cancelReceiverTransfer(session.receiverTransferId).catch(() => undefined);
      session.receiverTransferId = undefined;
    }

    session.status = status;
    session.message = message;
    session.updatedAt = now();
    this.emitState();
  }

  private markFileDownloaded(manifest: TorrentManifest): void {
    const room = this.currentRoomState();
    if (!room) {
      return;
    }

    const key = summarizeCatalogKey(manifest.torrentId);
    const existing = room.downloadHistory.get(key);
    const nextCount = (existing?.count ?? 0) + 1;
    room.downloadHistory.set(key, {
      count: nextCount,
      lastDownloadedAt: now(),
    });
  }

  private sendManifestAndBitfield(session: TorrentRuntimeState, peerId: string): void {
    if (!this.context) {
      return;
    }

    this.sendToPeer(peerId, {
      type: "torrent-manifest",
      torrentId: session.manifest.torrentId,
      roomId: session.manifest.roomId,
      senderPeerId: this.context.myPeerId,
      senderDisplayName: this.context.myDisplayName,
      manifest: session.manifest,
    });

    this.sendToPeer(peerId, {
      type: "bitfield",
      torrentId: session.manifest.torrentId,
      roomId: session.manifest.roomId,
      senderPeerId: this.context.myPeerId,
      senderDisplayName: this.context.myDisplayName,
      availablePieces: bitfieldToBase64(session.localBitfield),
      pieceCount: session.manifest.pieceCount,
    });
  }

  private broadcastTorrentAnnouncement(manifest: TorrentManifest, senderDisplayName: string, excludedPeerIds?: Set<string>): void {
    if (!this.context) {
      return;
    }

    this.sendToAllPeers({
      type: "torrent-announcement",
      torrentId: manifest.torrentId,
      roomId: manifest.roomId,
      senderPeerId: this.context.myPeerId,
      senderDisplayName,
      manifest,
      announcedAt: now(),
    }, excludedPeerIds);
  }

  private broadcastTorrentManifest(manifest: TorrentManifest, senderDisplayName: string, excludedPeerIds?: Set<string>): void {
    if (!this.context) {
      return;
    }

    this.sendToAllPeers({
      type: "torrent-manifest",
      torrentId: manifest.torrentId,
      roomId: manifest.roomId,
      senderPeerId: this.context.myPeerId,
      senderDisplayName,
      manifest,
    }, excludedPeerIds);
  }

  private broadcastTorrentJoin(manifest: TorrentManifest, interested: boolean, excludedPeerIds?: Set<string>): void {
    if (!this.context) {
      return;
    }

    this.sendToAllPeers({
      type: "torrent-join",
      torrentId: manifest.torrentId,
      roomId: manifest.roomId,
      senderPeerId: this.context.myPeerId,
      senderDisplayName: this.context.myDisplayName,
      interested,
    }, excludedPeerIds);
  }

  private broadcastBitfield(torrentId: string, manifest: TorrentManifest, bitfield: Uint8Array, excludedPeerIds?: Set<string>): void {
    if (!this.context) {
      return;
    }

    this.sendToAllPeers({
      type: "bitfield",
      torrentId,
      roomId: manifest.roomId,
      senderPeerId: this.context.myPeerId,
      senderDisplayName: this.context.myDisplayName,
      availablePieces: bitfieldToBase64(bitfield),
      pieceCount: manifest.pieceCount,
    }, excludedPeerIds);
  }

  private broadcastHave(manifest: TorrentManifest, pieceIndex: number): void {
    if (!this.context) {
      return;
    }

    this.sendToAllPeers({
      type: "have",
      torrentId: manifest.torrentId,
      roomId: manifest.roomId,
      senderPeerId: this.context.myPeerId,
      senderDisplayName: this.context.myDisplayName,
      pieceIndex,
    });
  }

  private broadcastPieceVerified(manifest: TorrentManifest, pieceIndex: number): void {
    if (!this.context) {
      return;
    }

    this.sendToAllPeers({
      type: "piece-verified",
      torrentId: manifest.torrentId,
      roomId: manifest.roomId,
      senderPeerId: this.context.myPeerId,
      senderDisplayName: this.context.myDisplayName,
      pieceIndex,
    });
  }

  private sendToPeer(peerId: string, message: SwarmControlMessage): void {
    const manager = FileTransferManager.peerManagers.get(peerId);
    if (!manager || !manager.transport?.isFileTransferReady()) {
      return;
    }

    const sent = manager.transport.sendFileControlMessage(encodeControlMessage(message));
    if (!sent) {
      this.callbacks.onEvent(`file swarm control send failed: ${message.type}`);
    }
  }

  private sendToAllPeers(message: SwarmControlMessage, excludedPeerIds?: Set<string>): void {
    for (const [peerId, manager] of FileTransferManager.peerManagers.entries()) {
      if (excludedPeerIds?.has(peerId)) {
        continue;
      }

      if (!manager.transport?.isFileTransferReady()) {
        continue;
      }

      manager.transport.sendFileControlMessage(encodeControlMessage(message));
    }
  }

  private calculateSpeed(bytesTransferred: number, startedAt: number): number {
    const elapsedSeconds = Math.max(1, (now() - startedAt) / 1000);
    return bytesTransferred / elapsedSeconds;
  }

  private summarizeTorrent(session: TorrentRuntimeState, room: RoomSwarmState): TorrentSwarmSummary {
    const peerCount = session.peerStates.size + 1;
    const verifiedPieces = session.pieceScheduler.getCompletedCount();
    const progress = session.manifest.pieceCount === 0 ? 1 : verifiedPieces / session.manifest.pieceCount;
    const localAvailabilityPercent = session.manifest.pieceCount === 0 ? 100 : Math.round((countBitfieldValues(session.localBitfield, session.manifest.pieceCount) / session.manifest.pieceCount) * 100);

    let availablePieces = 0;
    for (let pieceIndex = 0; pieceIndex < session.manifest.pieceCount; pieceIndex += 1) {
      let pieceAvailable = getBitfieldValue(session.localBitfield, pieceIndex);
      if (!pieceAvailable) {
        for (const peerState of session.peerStates.values()) {
          if (getBitfieldValue(peerState.bitfield, pieceIndex)) {
            pieceAvailable = true;
            break;
          }
        }
      }

      if (pieceAvailable) {
        availablePieces += 1;
      }
    }

    const availabilityPercent = session.manifest.pieceCount === 0 ? 100 : Math.round((availablePieces / session.manifest.pieceCount) * 100);
    const downloadedHistory = room.downloadHistory.get(session.manifest.torrentId);

    return {
      torrentId: session.manifest.torrentId,
      direction: roleToDirection(session.localRole),
      status: session.status,
      integrityStatus: session.integrityStatus,
      manifest: session.manifest,
      localRole: formatDisplayRole(session.localRole),
      downloadedBytes: session.downloadedBytes,
      uploadedBytes: session.uploadedBytes,
      verifiedPieces,
      requestedPieces: session.requestedPieces,
      inFlightPieces: session.inFlightPieces,
      completedPieces: session.completedPieces,
      speedBytesPerSecond: session.speedBytesPerSecond,
      progress,
      peerCount,
      availabilityPercent,
      localAvailabilityPercent,
      message: session.message ?? (downloadedHistory ? `downloaded ${downloadedHistory.count} time(s)` : undefined),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private buildViewState(room: RoomSwarmState): FileTransferViewState {
    const state = emptyViewState();

    for (const announcement of room.announcements.values()) {
      state.incomingAnnouncements.push(announcement);
    }

    for (const announcement of room.rejectedAnnouncements.values()) {
      state.rejectedAnnouncements.push(announcement);
    }

    for (const session of room.torrents.values()) {
      state.activeSwarms.push(this.summarizeTorrent(session, room));
    }

    const groupedBySender = new Map<string, SharedFilesBySender>();
    for (const accepted of room.acceptedAnnouncements.values()) {
      const senderPeerId = accepted.senderPeerId;
      const senderDisplayName = accepted.senderDisplayName;
      const existingGroup = groupedBySender.get(senderPeerId);
      const acceptedSession = room.torrents.get(accepted.torrentId);
      const nextItem = acceptedSession
        ? this.summarizeTorrent(acceptedSession, room)
        : {
            torrentId: accepted.torrentId,
            direction: "download" as const,
            status: "cancelled" as const,
            integrityStatus: "pending" as const,
            manifest: accepted.manifest,
            localRole: "leecher" as const,
            downloadedBytes: 0,
            uploadedBytes: 0,
            verifiedPieces: 0,
            requestedPieces: 0,
            inFlightPieces: 0,
            completedPieces: 0,
            speedBytesPerSecond: 0,
            progress: 0,
            peerCount: 1,
            availabilityPercent: 0,
            localAvailabilityPercent: 0,
            message: "Not currently in active transfer",
            createdAt: accepted.manifest.createdAt,
            updatedAt: accepted.announcedAt,
          };

      if (!existingGroup) {
        groupedBySender.set(senderPeerId, {
          senderPeerId,
          senderDisplayName,
          swarms: [nextItem],
        });
        continue;
      }

      existingGroup.swarms.push(nextItem);
    }

    state.acceptedSwarmsBySender = Array.from(groupedBySender.values()).map((group) => ({
      ...group,
      swarms: group.swarms.sort((left, right) => right.createdAt - left.createdAt),
    }));
    state.acceptedSwarmsBySender.sort((left, right) => left.senderDisplayName.localeCompare(right.senderDisplayName));
    state.incomingAnnouncements.sort((left, right) => right.announcedAt - left.announcedAt);
    state.rejectedAnnouncements.sort((left, right) => right.announcedAt - left.announcedAt);
    state.activeSwarms.sort((left, right) => right.updatedAt - left.updatedAt);

    return state;
  }

  private emitState(): void {
    const room = this.currentRoomState();
    if (!room) {
      this.callbacks.onUpdate(emptyViewState());
      return;
    }

    this.callbacks.onUpdate(this.buildViewState(room));
  }
}

function sessionPeerIds(session: TorrentRuntimeState | undefined): Set<string> {
  const peers = new Set<string>();
  if (!session) {
    return peers;
  }

  for (const peerId of session.peerStates.keys()) {
    peers.add(peerId);
  }

  return peers;
}