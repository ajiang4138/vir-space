export interface FileManifest {
  fileId: string;
  // SHA-1 content identity inspired by BitTorrent info hash semantics.
  infoHash: string;
  torrentVersion: 1;
  fileName: string;
  mimeType: string;
  fileSize: number;
  pieceSize: number;
  pieceCount: number;
  fullFileHash: string;
  pieceHashes?: string[];
  createdAt: number;
  senderPeerId: string;
  roomId: string;
}

export interface PickedFileInfo {
  filePath: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

export interface ReceiverTransferHandle {
  transferId: string;
  manifest: FileManifest;
  tempFilePath: string;
}
