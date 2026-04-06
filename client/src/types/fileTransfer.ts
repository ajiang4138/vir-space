import type { FileManifest } from "../shared/fileTransfer";

export type FileTransferDirection = "upload" | "download";

export type FileTransferStatus =
  | "offered"
  | "waiting-for-acceptance"
  | "accepted"
  | "transferring"
  | "retrying"
  | "verifying"
  | "saving"
  | "completed"
  | "declined"
  | "cancelled"
  | "failed";

export type FileTransferIntegrityStatus = "pending" | "verified" | "mismatch" | "failed";

export interface IncomingFileOffer {
  transferId: string;
  manifest: FileManifest;
  senderDisplayName: string;
  status: "offered" | "accepted" | "declined";
  createdAt: number;
}

export interface FileTransferSummary {
  transferId: string;
  direction: FileTransferDirection;
  status: FileTransferStatus;
  integrityStatus: FileTransferIntegrityStatus;
  manifest: FileManifest;
  senderDisplayName: string;
  receiverDisplayName: string;
  transferredBytes: number;
  verifiedPieces: number;
  requestedPieces: number;
  inFlightPieces: number;
  completedPieces: number;
  speedBytesPerSecond: number;
  progress: number;
  message?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SharedFileCatalogItem {
  fileId: string;
  infoHash: string;
  magnetUri: string;
  transferId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  pieceSize: number;
  pieceCount: number;
  roomId: string;
  senderPeerId: string;
  senderDisplayName: string;
  createdAt: number;
  downloadedCount: number;
  lastDownloadedAt: number | null;
  hasAcceptedOffer: boolean;
}

export interface SharedFilesBySender {
  senderPeerId: string;
  senderDisplayName: string;
  files: SharedFileCatalogItem[];
}

export interface FileTransferViewState {
  incomingOffers: IncomingFileOffer[];
  activeTransfers: FileTransferSummary[];
  sharedFilesBySender: SharedFilesBySender[];
}
