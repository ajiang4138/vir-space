import { useCallback, useEffect } from 'react';
import type { FileChunkInfo, SharedFileMetadata } from '../../models/types';
import { useUIStore } from '../../store/useUIStore';
import {
    getSharedFileDirectorySync,
    type SharedFileAnnouncementInput,
} from './SharedFileDirectorySync';

const defaultChunkInfo: FileChunkInfo = {
  totalChunks: 1,
  chunkSizeBytes: 0,
  completedChunks: 1,
};

interface CreateSharedFileInput {
  id?: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  mimeType: string;
  checksum: string;
  fileHash: string;
  chunkInfo?: FileChunkInfo;
  createdAt?: string;
}

interface SharedDirectoryFileRequest {
  fileId: string;
  fromPeerId: string;
  targetPeerId: string;
}

export function useSharedFileDirectoryIntegration() {
  const {
    currentRoomId,
    currentPeerId,
    replaceSharedFiles,
    systemStatus,
    addStatusMessage,
  } = useUIStore();

  const directorySync = getSharedFileDirectorySync();

  useEffect(() => {
    if (!currentRoomId || !currentPeerId) {
      return;
    }

    directorySync.joinRoom(currentRoomId, currentPeerId);
    replaceSharedFiles(directorySync.getDirectory(currentRoomId));

    const unsubscribe = directorySync.onDirectoryChanged((roomId, files) => {
      if (roomId === currentRoomId) {
        replaceSharedFiles(files);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [currentPeerId, currentRoomId, directorySync, replaceSharedFiles]);

  useEffect(() => {
    if (!currentRoomId || !currentPeerId) {
      return;
    }

    if (systemStatus === 'connected' || systemStatus === 'authenticated') {
      directorySync.handlePeerReconnected(currentRoomId, currentPeerId);
      addStatusMessage({
        type: 'info',
        message: 'Resynchronizing shared directory after reconnect.',
        duration: 2200,
      });
    }

    if (systemStatus === 'synchronizing') {
      directorySync.resynchronizeRoom(currentRoomId, currentPeerId, 'system-synchronizing');
    }
  }, [addStatusMessage, currentPeerId, currentRoomId, directorySync, systemStatus]);

  const announceFile = useCallback(
    (input: CreateSharedFileInput): SharedFileMetadata | null => {
      if (!currentRoomId || !currentPeerId) {
        addStatusMessage({
          type: 'warning',
          message: 'Join a room before sharing files.',
          duration: 2500,
        });
        return null;
      }

      const payload: SharedFileAnnouncementInput = {
        ...input,
        chunkInfo: input.chunkInfo ?? {
          ...defaultChunkInfo,
          chunkSizeBytes: input.sizeBytes,
        },
      };

      return directorySync.announceFile(currentRoomId, currentPeerId, payload);
    },
    [addStatusMessage, currentPeerId, currentRoomId, directorySync],
  );

  const removeFile = useCallback(
    (fileId: string): void => {
      if (!currentRoomId || !currentPeerId) {
        return;
      }
      directorySync.removeFile(currentRoomId, currentPeerId, fileId);
    },
    [currentPeerId, currentRoomId, directorySync],
  );

  const requestFile = useCallback(
    (targetPeerId: string, fileId: string): void => {
      if (!currentRoomId || !currentPeerId) {
        addStatusMessage({
          type: 'warning',
          message: 'Join a room before requesting files.',
          duration: 2500,
        });
        return;
      }

      directorySync.requestFile(currentRoomId, currentPeerId, targetPeerId, fileId);
    },
    [addStatusMessage, currentPeerId, currentRoomId, directorySync],
  );

  const onFileRequest = useCallback(
    (listener: (roomId: string, request: SharedDirectoryFileRequest) => void): (() => void) =>
      directorySync.onFileRequest(listener),
    [directorySync],
  );

  return {
    announceFile,
    removeFile,
    requestFile,
    onFileRequest,
  };
}
