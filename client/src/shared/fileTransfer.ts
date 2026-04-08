export interface TorrentManifest {
  torrentId: string;
  roomId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  pieceSize: number;
  pieceCount: number;
  fullFileHash: string;
  pieceHashes: string[];
  initialSeederPeerId: string;
  createdAt: number;
  protocolVersion: 1;
}

export interface PickedFileInfo {
  filePath: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

export interface ReceiverTransferHandle {
  transferId: string;
  manifest: TorrentManifest;
  tempFilePath: string;
}
