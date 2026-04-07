import type { TorrentManifest } from "../shared/fileTransfer";

export type SwarmTransferDirection = "upload" | "download";

export type SwarmTransferStatus =
  | "seeding"
  | "downloading"
  | "partial-seeding"
  | "verifying"
  | "completed"
  | "cancelled"
  | "failed";

export type SwarmIntegrityStatus = "pending" | "verified" | "mismatch" | "failed";

export type SwarmPeerRole = "seeder" | "leecher" | "partial-seeder";

export type PieceState = "missing" | "requested" | "received" | "verified" | "failed";

export interface TorrentAnnouncement {
  torrentId: string;
  roomId: string;
  manifest: TorrentManifest;
  senderPeerId: string;
  senderDisplayName: string;
  announcedAt: number;
}

export interface TorrentSwarmSummary {
  torrentId: string;
  direction: SwarmTransferDirection;
  status: SwarmTransferStatus;
  integrityStatus: SwarmIntegrityStatus;
  manifest: TorrentManifest;
  localRole: SwarmPeerRole;
  downloadedBytes: number;
  uploadedBytes: number;
  verifiedPieces: number;
  requestedPieces: number;
  inFlightPieces: number;
  completedPieces: number;
  speedBytesPerSecond: number;
  progress: number;
  peerCount: number;
  availabilityPercent: number;
  localAvailabilityPercent: number;
  message?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SharedTorrentCatalogItem {
  torrentId: string;
  manifest: TorrentManifest;
  fileName: string;
  mimeType: string;
  fileSize: number;
  pieceSize: number;
  pieceCount: number;
  roomId: string;
  initialSeederPeerId: string;
  initialSeederDisplayName: string;
  knownSeederPeerIds: string[];
  createdAt: number;
  downloadedCount: number;
  lastDownloadedAt: number | null;
}

export interface SharedFilesBySender {
  senderPeerId: string;
  senderDisplayName: string;
  swarms: TorrentSwarmSummary[];
}

export interface FileTransferViewState {
  incomingAnnouncements: TorrentAnnouncement[];
  rejectedAnnouncements: TorrentAnnouncement[];
  activeSwarms: TorrentSwarmSummary[];
  acceptedSwarmsBySender: SharedFilesBySender[];
}
