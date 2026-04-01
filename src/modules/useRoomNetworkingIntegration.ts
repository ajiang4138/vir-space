import { useEffect, useRef } from 'react';
import type { Peer } from '../models/types';
import { useUIStore } from '../store/useUIStore';
import { IntegratedNetworkingManager } from './networking/NetworkingIntegration';
import { RoomLogger } from './room-peer/RoomPeerManager';

export function useRoomNetworkingIntegration() {
  const { currentRoom, currentPeerId, currentPeerName, setSystemStatus } = useUIStore();
  const networkingManagerRef = useRef<IntegratedNetworkingManager | null>(null);
  const activeRoomIdRef = useRef<string | null>(null);
  const initializationRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!networkingManagerRef.current) {
      networkingManagerRef.current = new IntegratedNetworkingManager();
    }

    return () => {
      const networkingManager = networkingManagerRef.current;
      const activeRoomId = activeRoomIdRef.current;

      activeRoomIdRef.current = null;

      if (networkingManager && activeRoomId) {
        void networkingManager.leaveRoom(activeRoomId).catch((error: unknown) => {
          RoomLogger.warn('Failed to leave networking room during cleanup', {
            error: error instanceof Error ? error.message : String(error),
            roomId: activeRoomId,
          });
        });
      }

      void networkingManager?.shutdown().catch((error: unknown) => {
        RoomLogger.warn('Failed to shutdown networking manager during cleanup', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

      networkingManagerRef.current = null;
      initializationRef.current = null;
    };
  }, []);

  useEffect(() => {
    const networkingManager = networkingManagerRef.current;
    if (!networkingManager || !currentRoom || !currentPeerId || !currentPeerName.trim()) {
      return;
    }

    const localPeer: Peer = {
      id: currentPeerId,
      displayName: currentPeerName,
      status: 'online',
      capabilities: ['edit', 'view'],
      lastSeenAt: new Date().toISOString(),
    };

    let cancelled = false;

    const run = async () => {
      if (activeRoomIdRef.current === currentRoom.id) {
        return;
      }

      setSystemStatus('connecting');

      if (!initializationRef.current) {
        initializationRef.current = networkingManager.initialize();
      }

      await initializationRef.current;

      if (cancelled) {
        return;
      }

      if (activeRoomIdRef.current && activeRoomIdRef.current !== currentRoom.id) {
        await networkingManager.leaveRoom(activeRoomIdRef.current).catch((error: unknown) => {
          RoomLogger.warn('Failed to leave previous networking room', {
            error: error instanceof Error ? error.message : String(error),
            roomId: activeRoomIdRef.current,
          });
        });
      }

      await networkingManager.joinRoom(currentRoom, localPeer);
      activeRoomIdRef.current = currentRoom.id;
      setSystemStatus('connected');
    };

    void run().catch((error: unknown) => {
      if (cancelled) {
        return;
      }

      RoomLogger.error('Failed to initialize room networking', {
        error: error instanceof Error ? error.message : String(error),
        roomId: currentRoom.id,
      });
      setSystemStatus('error');
    });

    return () => {
      cancelled = true;
    };
  }, [currentPeerId, currentPeerName, currentRoom, setSystemStatus]);
}
