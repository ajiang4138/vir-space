import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { FileMetadata, SharedFileMetadata } from '../../models/types';
import { useUIStore } from '../../store/useUIStore';
import { getFileTransferEngine } from './FileTransferRuntime';
import { useSharedFileDirectoryIntegration } from './useSharedFileDirectoryIntegration';

const DEFAULT_CHUNK_SIZE_BYTES = 64 * 1024;

interface SendFileOptions {
  targetPeerIds?: string[];
  chunkSizeBytes?: number;
}

const localFileBytesByPeer = new Map<string, Map<string, Uint8Array>>();

function getLocalFileBytesMap(peerId: string): Map<string, Uint8Array> {
  let existing = localFileBytesByPeer.get(peerId);
  if (existing) {
    return existing;
  }

  existing = new Map<string, Uint8Array>();
  localFileBytesByPeer.set(peerId, existing);
  return existing;
}

export function useFileTransferIntegration() {
  const {
    currentRoomId,
    currentPeerId,
    knownPeers,
    sharedFiles,
    transferSessions,
    systemStatus,
    addTransferSession,
    updateTransferSession,
    updateSharedFile,
    addStatusMessage,
  } = useUIStore();
  const { announceFile, requestFile, onFileRequest } = useSharedFileDirectoryIntegration();

  const engine = useMemo(() => {
    if (!currentPeerId) {
      return null;
    }
    return getFileTransferEngine(currentPeerId);
  }, [currentPeerId]);

  const requestedFileIdsRef = useRef<Set<string>>(new Set<string>());
  const requestKeyByTransferIdRef = useRef<Map<string, string>>(new Map<string, string>());

  useEffect(() => {
    if (!engine || !currentPeerId) {
      return;
    }

    return engine.onTransferProgress((progress) => {
      addTransferSession(progress.session);

      const status = progress.status === 'canceled' ? 'failed' : progress.status;
      const updates = {
        status,
        progressPercent: progress.session.progressPercent,
        verificationStatus: progress.verificationStatus ?? progress.session.verificationStatus,
        ...(progress.error ? { error: progress.error } : {}),
        ...(status === 'completed' ? { completedAt: new Date().toISOString() } : {}),
      };
      updateTransferSession(progress.session.id, updates);

      updateSharedFile(progress.session.file.id, {
        chunkInfo: {
          totalChunks: Math.max(progress.totalChunks, 1),
          completedChunks: Math.min(progress.completedChunks, Math.max(progress.totalChunks, 1)),
          chunkSizeBytes: Math.max(1, Math.ceil(progress.totalBytes / Math.max(progress.totalChunks, 1))),
        },
        updatedAt: new Date().toISOString(),
      });

      if (
        status === 'completed'
        && progress.direction === 'receive'
        && progress.verificationStatus === 'verified'
      ) {
        const bytes = engine.getReceivedFileBytes(progress.session.id);
        if (bytes) {
          getLocalFileBytesMap(currentPeerId).set(progress.session.file.id, bytes);
          requestedFileIdsRef.current.delete(progress.session.file.id);
        }
      }

      const requestKey = requestKeyByTransferIdRef.current.get(progress.session.id);
      if (requestKey && (status === 'completed' || status === 'failed')) {
        requestKeyByTransferIdRef.current.delete(progress.session.id);
      }

      if (progress.status === 'failed' && progress.error) {
        addStatusMessage({
          type: 'error',
          message: `Transfer failed: ${progress.error}`,
          duration: 4000,
        });
      }
    });
  }, [
    addStatusMessage,
    addTransferSession,
    currentPeerId,
    engine,
    updateSharedFile,
    updateTransferSession,
  ]);

  useEffect(() => {
    if (!engine || !currentRoomId) {
      return;
    }

    if (systemStatus === 'disconnected' || systemStatus === 'error') {
      for (const peer of knownPeers) {
        if (peer.id !== currentPeerId) {
          engine.setPeerConnectivity(peer.id, false);
        }
      }
      return;
    }

    if (systemStatus === 'connected' || systemStatus === 'authenticated' || systemStatus === 'synchronizing') {
      for (const peer of knownPeers) {
        if (peer.id !== currentPeerId) {
          engine.setPeerConnectivity(peer.id, true);
        }
      }

      void engine.resumePendingTransfers(currentRoomId).catch((error: unknown) => {
        addStatusMessage({
          type: 'warning',
          message: `Unable to resume pending transfers: ${formatError(error)}`,
          duration: 3000,
        });
      });
    }
  }, [addStatusMessage, currentPeerId, currentRoomId, engine, knownPeers, systemStatus]);

  useEffect(() => {
    if (!currentPeerId || !currentRoomId || !onFileRequest || !engine) {
      return;
    }

    return onFileRequest((roomId, request) => {
      if (roomId !== currentRoomId || request.targetPeerId !== currentPeerId) {
        return;
      }

      const bytes = getLocalFileBytesMap(currentPeerId).get(request.fileId);
      if (!bytes) {
        addStatusMessage({
          type: 'warning',
          message: `Cannot fulfill request for file ${request.fileId}: content is unavailable locally.`,
          duration: 3500,
        });
        return;
      }

      const metadata = sharedFiles.find((file) => file.id === request.fileId);
      if (!metadata) {
        addStatusMessage({
          type: 'warning',
          message: `Cannot fulfill request for file ${request.fileId}: metadata is missing.`,
          duration: 3500,
        });
        return;
      }

      const existingSession = transferSessions.find(
        (session) =>
          session.file.id === request.fileId
          && session.senderPeerId === currentPeerId
          && session.receiverPeerId === request.fromPeerId
          && session.status === 'in-progress',
      );
      if (existingSession) {
        return;
      }

      void engine
        .startTransfer({
          roomId: currentRoomId,
          senderPeerId: currentPeerId,
          receiverPeerId: request.fromPeerId,
          file: fileMetadataFromShared(metadata),
          fileBytes: bytes,
          chunkSizeBytes: metadata.chunkInfo.chunkSizeBytes || DEFAULT_CHUNK_SIZE_BYTES,
        })
        .then((session) => {
          requestKeyByTransferIdRef.current.set(
            session.id,
            `${request.fromPeerId}:${request.fileId}`,
          );
        })
        .catch((error: unknown) => {
          addStatusMessage({
            type: 'error',
            message: `Failed to start requested transfer for ${metadata.fileName}: ${formatError(error)}`,
            duration: 4000,
          });
        });
    });
  }, [
    addStatusMessage,
    currentPeerId,
    currentRoomId,
    engine,
    onFileRequest,
    sharedFiles,
    transferSessions,
    systemStatus,
  ]);

  useEffect(() => {
    if (!currentPeerId || !currentRoomId) {
      return;
    }

    const localFiles = getLocalFileBytesMap(currentPeerId);

    for (const file of sharedFiles) {
      if (file.announcedByPeerId === currentPeerId) {
        continue;
      }

      if (localFiles.has(file.id)) {
        continue;
      }

      const hasCompletedInbound = transferSessions.some(
        (session) =>
          session.file.id === file.id
          && session.receiverPeerId === currentPeerId
          && session.status === 'completed'
          && session.verificationStatus === 'verified',
      );
      if (hasCompletedInbound) {
        continue;
      }

      const hasInboundInProgress = transferSessions.some(
        (session) =>
          session.file.id === file.id
          && session.receiverPeerId === currentPeerId
          && session.status === 'in-progress',
      );
      if (hasInboundInProgress || requestedFileIdsRef.current.has(file.id)) {
        continue;
      }

      const ownerKnown = knownPeers.some((peer) => peer.id === file.announcedByPeerId);
      if (!ownerKnown) {
        continue;
      }

      requestedFileIdsRef.current.add(file.id);
      requestFile(file.announcedByPeerId, file.id);
      addStatusMessage({
        type: 'info',
        message: `Requesting ${file.fileName} from ${file.announcedByPeerId}.`,
        duration: 2200,
      });
    }
  }, [
    addStatusMessage,
    currentPeerId,
    currentRoomId,
    knownPeers,
    requestFile,
    sharedFiles,
    transferSessions,
  ]);

  const sendFile = useCallback(
    async (file: File, options?: SendFileOptions): Promise<void> => {
      if (!engine || !currentRoomId || !currentPeerId) {
        addStatusMessage({
          type: 'warning',
          message: 'Join a room before sending files.',
          duration: 2500,
        });
        return;
      }

      const candidates = options?.targetPeerIds?.length
        ? options.targetPeerIds
        : knownPeers
            .map((peer) => peer.id)
            .filter((peerId) => peerId !== currentPeerId);

      if (candidates.length === 0) {
        addStatusMessage({
          type: 'warning',
          message: 'No peers available for direct transfer in this room.',
          duration: 3000,
        });
        return;
      }

      const fileBytes = new Uint8Array(await file.arrayBuffer());
      const checksum = await computeChecksum(fileBytes);
      const metadata: FileMetadata = {
        id: crypto.randomUUID(),
        fileName: file.name,
        filePath: `/workspace/shared/${file.name}`,
        sizeBytes: file.size,
        checksum,
        mimeType: file.type || 'application/octet-stream',
        createdAt: new Date().toISOString(),
      };

      const chunkSize = options?.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
      const announced = announceFile({
        id: metadata.id,
        fileName: metadata.fileName,
        filePath: metadata.filePath,
        sizeBytes: metadata.sizeBytes,
        mimeType: metadata.mimeType,
        checksum: metadata.checksum,
        fileHash: metadata.checksum,
        chunkInfo: {
          totalChunks: Math.max(1, Math.ceil(file.size / chunkSize)),
          completedChunks: 0,
          chunkSizeBytes: chunkSize,
        },
        createdAt: metadata.createdAt,
      });

      if (!announced) {
        return;
      }

      getLocalFileBytesMap(currentPeerId).set(metadata.id, fileBytes);

      await Promise.all(
        candidates.map((peerId) =>
          engine.startTransfer({
            roomId: currentRoomId,
            senderPeerId: currentPeerId,
            receiverPeerId: peerId,
            file: metadata,
            fileBytes,
            chunkSizeBytes: options?.chunkSizeBytes,
          }),
        ),
      );

      addStatusMessage({
        type: 'info',
        message: `Started transfer of ${file.name} to ${candidates.length} peer(s).`,
        duration: 2500,
      });
    },
    [addStatusMessage, announceFile, currentPeerId, currentRoomId, engine, knownPeers],
  );

  const requestMissingFile = useCallback(
    (fileId: string): void => {
      if (!currentPeerId) {
        return;
      }

      const metadata = sharedFiles.find((file) => file.id === fileId);
      if (!metadata) {
        return;
      }

      if (metadata.announcedByPeerId === currentPeerId) {
        return;
      }

      requestedFileIdsRef.current.add(fileId);
      requestFile(metadata.announcedByPeerId, fileId);
    },
    [currentPeerId, requestFile, sharedFiles],
  );

  return {
    sendFile,
    requestMissingFile,
  };
}

function fileMetadataFromShared(file: SharedFileMetadata): FileMetadata {
  return {
    id: file.id,
    fileName: file.fileName,
    filePath: file.filePath,
    sizeBytes: file.sizeBytes,
    checksum: file.checksum,
    mimeType: file.mimeType,
    createdAt: file.createdAt,
  };
}

async function computeChecksum(bytes: Uint8Array): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digestInput = Uint8Array.from(bytes);
    const digest = await crypto.subtle.digest('SHA-256', digestInput);
    return bytesToHex(new Uint8Array(digest));
  }

  return bytesToHex(bytes.slice(0, Math.min(bytes.byteLength, 32)));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown transfer error';
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
