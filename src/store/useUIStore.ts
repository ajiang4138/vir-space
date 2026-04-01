import { createContext, useCallback, useContext, useState } from 'react';
import {
    Peer,
    Room,
    SharedFileMetadata,
    TransferSession,
    WorkspaceState,
} from '../models/types';

export type SystemStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'authenticated'
  | 'synchronizing'
  | 'disconnected'
  | 'error';

export interface StatusMessage {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  message: string;
  timestamp: number;
  duration?: number;
}

export interface UIState {
  currentRoomId: string | null;
  currentRoom: Room | null;
  currentPeerId: string | null;
  currentPeerName: string;
  knownPeers: Peer[];
  workspaceState: WorkspaceState | null;
  sharedFiles: SharedFileMetadata[];
  transferSessions: TransferSession[];
  systemStatus: SystemStatus;
  statusMessages: StatusMessage[];
  isLoading: boolean;
}

export interface UIStore extends UIState {
  setCurrentRoom: (room: Room) => void;
  clearCurrentRoom: () => void;
  setCurrentPeer: (peerId: string, displayName: string) => void;
  addKnownPeer: (peer: Peer) => void;
  updatePeer: (peerId: string, updates: Partial<Peer>) => void;
  removeKnownPeer: (peerId: string) => void;
  setWorkspaceState: (state: WorkspaceState) => void;
  updateWorkspaceState: (updates: Partial<WorkspaceState>) => void;
  addSharedFile: (file: SharedFileMetadata) => void;
  removeSharedFile: (fileId: string) => void;
  updateSharedFile: (fileId: string, updates: Partial<SharedFileMetadata>) => void;
  replaceSharedFiles: (files: SharedFileMetadata[]) => void;
  addTransferSession: (session: TransferSession) => void;
  updateTransferSession: (sessionId: string, updates: Partial<TransferSession>) => void;
  removeTransferSession: (sessionId: string) => void;
  setSystemStatus: (status: SystemStatus) => void;
  addStatusMessage: (message: Omit<StatusMessage, 'id' | 'timestamp'>) => void;
  removeStatusMessage: (messageId: string) => void;
  clearStatusMessages: () => void;
  setIsLoading: (loading: boolean) => void;
  reset: () => void;
}

const initialState: UIState = {
  currentRoomId: null,
  currentRoom: null,
  currentPeerId: null,
  currentPeerName: '',
  knownPeers: [],
  workspaceState: null,
  sharedFiles: [],
  transferSessions: [],
  systemStatus: 'idle',
  statusMessages: [],
  isLoading: false,
};

export function useUIStoreImpl(): UIStore {
  const [state, setState] = useState<UIState>(initialState);

  const removeStatusMessageImpl = useCallback((messageId: string) => {
    setState((s) => ({
      ...s,
      statusMessages: s.statusMessages.filter((m) => m.id !== messageId),
    }));
  }, []);

  const setCurrentRoom = useCallback((room: Room) => {
    setState((s) => ({
      ...s,
      currentRoomId: room.id,
      currentRoom: room,
    }));
  }, []);

  const clearCurrentRoom = useCallback(() => {
    setState((s) => ({
      ...s,
      currentRoomId: null,
      currentRoom: null,
      knownPeers: [],
      workspaceState: null,
      sharedFiles: [],
      transferSessions: [],
    }));
  }, []);

  const setCurrentPeer = useCallback((peerId: string, displayName: string) => {
    setState((s) => ({
      ...s,
      currentPeerId: peerId,
      currentPeerName: displayName,
    }));
  }, []);

  const addKnownPeer = useCallback((peer: Peer) => {
    setState((s) => ({
      ...s,
      knownPeers: s.knownPeers.some((p) => p.id === peer.id)
        ? s.knownPeers
        : [...s.knownPeers, peer],
    }));
  }, []);

  const updatePeer = useCallback((peerId: string, updates: Partial<Peer>) => {
    setState((s) => ({
      ...s,
      knownPeers: s.knownPeers.map((p) =>
        p.id === peerId ? { ...p, ...updates } : p
      ),
    }));
  }, []);

  const removeKnownPeer = useCallback((peerId: string) => {
    setState((s) => ({
      ...s,
      knownPeers: s.knownPeers.filter((p) => p.id !== peerId),
    }));
  }, []);

  const setWorkspaceState = useCallback((workspaceState: WorkspaceState) => {
    setState((s) => ({
      ...s,
      workspaceState,
    }));
  }, []);

  const updateWorkspaceState = useCallback(
    (updates: Partial<WorkspaceState>) => {
      setState((s) => ({
        ...s,
        workspaceState: s.workspaceState
          ? { ...s.workspaceState, ...updates }
          : null,
      }));
    },
    []
  );

  const addSharedFile = useCallback((file: SharedFileMetadata) => {
    setState((s) => ({
      ...s,
      sharedFiles: s.sharedFiles.some((f) => f.id === file.id)
        ? s.sharedFiles
        : [...s.sharedFiles, file],
    }));
  }, []);

  const removeSharedFile = useCallback((fileId: string) => {
    setState((s) => ({
      ...s,
      sharedFiles: s.sharedFiles.filter((f) => f.id !== fileId),
    }));
  }, []);

  const updateSharedFile = useCallback(
    (fileId: string, updates: Partial<SharedFileMetadata>) => {
      setState((s) => ({
        ...s,
        sharedFiles: s.sharedFiles.map((f) =>
          f.id === fileId ? { ...f, ...updates } : f
        ),
      }));
    },
    []
  );

  const replaceSharedFiles = useCallback((files: SharedFileMetadata[]) => {
    setState((s) => ({
      ...s,
      sharedFiles: files,
    }));
  }, []);

  const addTransferSession = useCallback((session: TransferSession) => {
    setState((s) => ({
      ...s,
      transferSessions: s.transferSessions.some((t) => t.id === session.id)
        ? s.transferSessions
        : [...s.transferSessions, session],
    }));
  }, []);

  const updateTransferSession = useCallback(
    (sessionId: string, updates: Partial<TransferSession>) => {
      setState((s) => ({
        ...s,
        transferSessions: s.transferSessions.map((t) =>
          t.id === sessionId ? { ...t, ...updates } : t
        ),
      }));
    },
    []
  );

  const removeTransferSession = useCallback((sessionId: string) => {
    setState((s) => ({
      ...s,
      transferSessions: s.transferSessions.filter((t) => t.id !== sessionId),
    }));
  }, []);

  const setSystemStatus = useCallback((status: SystemStatus) => {
    setState((s) => ({
      ...s,
      systemStatus: status,
    }));
  }, []);

  const addStatusMessage = useCallback(
    (messageData: Omit<StatusMessage, 'id' | 'timestamp'>) => {
      const message: StatusMessage = {
        ...messageData,
        id: `msg-${Date.now()}-${Math.random()}`,
        timestamp: Date.now(),
      };

      setState((s) => ({
        ...s,
        statusMessages: [...s.statusMessages, message],
      }));

      if (messageData.duration !== 0) {
        const duration = messageData.duration ?? 5000;
        setTimeout(() => {
          removeStatusMessageImpl(message.id);
        }, duration);
      }
    },
    [removeStatusMessageImpl]
  );

  const removeStatusMessage = useCallback((messageId: string) => {
    removeStatusMessageImpl(messageId);
  }, [removeStatusMessageImpl]);

  const clearStatusMessages = useCallback(() => {
    setState((s) => ({
      ...s,
      statusMessages: [],
    }));
  }, []);

  const setIsLoading = useCallback((loading: boolean) => {
    setState((s) => ({
      ...s,
      isLoading: loading,
    }));
  }, []);

  const reset = useCallback(() => {
    setState(initialState);
  }, []);

  return {
    ...state,
    setCurrentRoom,
    clearCurrentRoom,
    setCurrentPeer,
    addKnownPeer,
    updatePeer,
    removeKnownPeer,
    setWorkspaceState,
    updateWorkspaceState,
    addSharedFile,
    removeSharedFile,
    updateSharedFile,
    replaceSharedFiles,
    addTransferSession,
    updateTransferSession,
    removeTransferSession,
    setSystemStatus,
    addStatusMessage,
    removeStatusMessage,
    clearStatusMessages,
    setIsLoading,
    reset,
  };
}

const UIStoreContext = createContext<UIStore | undefined>(undefined);

export function useUIStore(): UIStore {
  const store = useContext(UIStoreContext);
  if (!store) {
    throw new Error('useUIStore must be used within UIStoreProvider');
  }
  return store;
}

export { UIStoreContext };
