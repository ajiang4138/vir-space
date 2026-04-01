export type PeerStatus = 'online' | 'idle' | 'offline';

// ==================== Authentication Types ====================
export type AuthenticationMethod = 'password' | 'invite-token';

export interface RoomAuthConfig {
  method: AuthenticationMethod;
  // For password method
  passwordHash?: string;
  // For invite token method
  inviteTokens?: Map<string, { createdAt: string; expiresAt?: string; usedAt?: string; usedByPeerId?: string }>;
  // Authorization settings
  requireAuthForJoin: boolean;
  maxAttempts?: number;
  lockoutDurationMs?: number;
}

export interface AuthAttempt {
  peerId: string;
  roomId: string;
  method: AuthenticationMethod;
  timestamp: string;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface AuthenticationResult {
  authorized: boolean;
  errorCode?: string;
  errorMessage?: string;
  timestamp: string;
}

export interface Room {
  id: string;
  name: string;
  ownerPeerId: string;
  peers: Peer[];
  createdAt: string;
  isPrivate: boolean;
  authConfig?: RoomAuthConfig;
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

export interface FileChunkInfo {
  totalChunks: number;
  chunkSizeBytes: number;
  completedChunks: number;
}

export interface SharedFileMetadata extends FileMetadata {
  fileHash: string;
  chunkInfo: FileChunkInfo;
  version: number;
  logicalTimestamp: number;
  updatedAt: string;
  announcedByPeerId: string;
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
  verificationStatus?: 'pending' | 'verified' | 'failed';
  error?: string;
}

// ==================== Workspace Sync Types ====================

/**
 * Represents a shared canvas element in the workspace
 */
export interface CanvasElement {
  id: string;
  type: 'shape' | 'text' | 'media' | 'note';
  x: number;
  y: number;
  width: number;
  height: number;
  data: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  modifiedAt: string;
  modifiedBy: string;
  zIndex?: number;
}

/**
 * Represents the shared workspace canvas
 */
export interface WorkspaceCanvas {
  width: number;
  height: number;
  elements: Map<string, CanvasElement>;
  viewportX: number;
  viewportY: number;
  zoom: number;
}

/**
 * Shared file directory metadata
 */
export interface SharedFileDirectory {
  id: string;
  name: string;
  parentId?: string;
  children: Map<string, SharedFileDirectory | FileMetadata>;
  createdAt: string;
  createdBy: string;
}

/**
 * Peer presence information including cursors and selections
 */
export interface PeerPresenceMetadata {
  peerId: string;
  color: string;
  displayName: string;
  cursorPosition?: { x: number; y: number };
  selectedElementId?: string;
  lastActivity: string;
  status: 'active' | 'idle' | 'away';
}

/**
 * Enhanced WorkspaceState with CRDT support
 */
export interface WorkspaceStateV2 {
  roomId: string;
  version: number; // Lamport timestamp or version vector
  canvas: WorkspaceCanvas;
  openFiles: string[];
  sharedDirectory: SharedFileDirectory;
  peerPresence: Map<string, PeerPresenceMetadata>;
  activePeers: string[];
  updatedAt: string;
  updatedBy: string;
  // For tracking synchronization
  syncMetadata?: {
    lastSync: string;
    pendingChanges: number;
    isConverged: boolean;
  };
}

/**
 * Operation-based change representation for CRDT
 */
export interface WorkspaceOperation {
  id: string;
  type: 'insert' | 'update' | 'delete' | 'move';
  path: string[]; // e.g., ['canvas', 'elements', 'elem-1']
  value?: unknown;
  previousValue?: unknown;
  peerId: string;
  timestamp: string;
  clock: Record<string, number>; // Lamport or vector clock
}

/**
 * Message envelope for synchronization
 */
export interface SyncMessage {
  id: string;
  type: 'sync' | 'ack' | 'snapshot' | 'delta' | 'heartbeat';
  roomId: string;
  fromPeerId: string;
  toPeerId?: string; // undefined for broadcast
  payload: {
    operations?: WorkspaceOperation[];
    state?: WorkspaceStateV2;
    clock?: Record<string, number>;
    checkpoint?: number;
  };
  timestamp: string;
  sequenceNumber: number;
}

/**
 * Synchronization state for conflict resolution
 */
export interface SyncState {
  roomId: string;
  peerId: string;
  localClock: Record<string, number>; // Lamport or vector clock
  lastReceivedClock: Record<string, number>;
  pendingOperations: WorkspaceOperation[];
  acknowledgedOperations: Set<string>;
  messageQueue: SyncMessage[];
  isConnected: boolean;
  lastSyncTime: string;
}

/**
 * Synchronization metrics for monitoring
 */
export interface SyncMetrics {
  roomId: string;
  peerId: string;
  updateLatencyMs: number;
  messageQueueSize: number;
  pendingOperations: number;
  convergedPeers: number;
  totalPeers: number;
  syncsPerSecond: number;
  lastUpdate: string;
  uptime: number;
}

// ==================== Canvas Operation Types ====================

/**
 * Canvas operation subtypes for collaborative editing
 */
export type CanvasOperationType = 'add' | 'update' | 'delete' | 'move' | 'resize' | 'bringToFront' | 'sendToBack';

/**
 * Specific canvas operation with element details
 */
export interface CanvasOperation {
  type: CanvasOperationType;
  elementId: string;
  elementData?: Partial<CanvasElement>;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  zIndexChange?: number;
  id?: string;
  peerId?: string;
  timestamp?: string;
  clock?: Record<string, number>;
}

/**
 * Canvas state for tracking current workspace elements
 */
export interface CanvasState {
  elements: Map<string, CanvasElement>;
  width: number;
  height: number;
  viewportX: number;
  viewportY: number;
  zoom: number;
  selectedElementIds: Set<string>;
  syncStatus: 'synced' | 'syncing' | 'pending' | 'error' | 'reconnecting' | 'recovering';
  lastSyncTime: string;
  convergenceStatus: 'converged' | 'diverged' | 'syncing';
}

/**
 * Collaborative canvas event
 */
export interface CanvasEvent {
  type: CanvasOperationType;
  elementId: string;
  elementData?: Partial<CanvasElement>;
  peerId: string;
  timestamp: string;
  isLocal: boolean;
}

/**
 * Canvas sync metrics
 */
export interface CanvasSyncMetrics {
  operationsApplied: number;
  pendingOperations: number;
  lastOperationTime: string;
  syncLatencyMs: number;
  isConverged: boolean;
  remoteOperationsApplied: number;
  conflictsResolved: number;
}
