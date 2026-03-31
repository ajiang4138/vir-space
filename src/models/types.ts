export type PeerStatus = 'online' | 'idle' | 'offline';

export interface Room {
  id: string;
  name: string;
  ownerPeerId: string;
  peers: Peer[];
  createdAt: string;
  isPrivate: boolean;
}

export interface Peer {
  id: string;
  displayName: string;
  status: PeerStatus;
  capabilities: string[];
  lastSeenAt: string;
}

export interface WorkspaceState {
  roomId: string;
  activePeers: string[];
  openFiles: string[];
  cursorMap: Record<string, { filePath: string; line: number; column: number }>;
  updatedAt: string;
}

export interface FileMetadata {
  id: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  checksum: string;
  mimeType: string;
  createdAt: string;
}

export interface AuthPayload {
  peerId: string;
  roomId: string;
  token: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

export interface TransferSession {
  id: string;
  roomId: string;
  senderPeerId: string;
  receiverPeerId: string;
  file: FileMetadata;
  status: 'queued' | 'in-progress' | 'completed' | 'failed';
  progressPercent: number;
  startedAt: string;
  completedAt?: string;
}
