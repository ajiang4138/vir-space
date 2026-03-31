import { useCallback, useEffect, useRef } from 'react';
import { useUIStore } from '../store/useUIStore';
import { getRoomManager, type RoomManager } from './room-peer/RoomManager';
import type { MembershipEvent } from './room-peer/RoomPeerManager';
import { RoomLogger } from './room-peer/RoomPeerManager';

/**
 * Hook that integrates RoomManager with the UI store.
 * Handles membership events and updates UI state accordingly.
 */
export function useRoomMembershipIntegration() {
  const roomManager = useRef<RoomManager | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);
  const store = useUIStore();

  // Initialize room manager
  useEffect(() => {
    if (!roomManager.current) {
      roomManager.current = getRoomManager();
      RoomLogger.info('RoomManager integrated with UI');
    }

    return () => {
      // Don't destroy on unmount since it's a singleton
      // But we do clean up the subscription
      if (unsubscribe.current) {
        unsubscribe.current();
        unsubscribe.current = null;
      }
    };
  }, []);

  // Set up membership event subscription
  useEffect(() => {
    if (!roomManager.current) return;

    unsubscribe.current = roomManager.current.onMembershipEvent((event: MembershipEvent) => {
      handleMembershipEvent(event);
    });

    return () => {
      if (unsubscribe.current) {
        unsubscribe.current();
        unsubscribe.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMembershipEvent = useCallback(
    (event: MembershipEvent) => {
      RoomLogger.debug('Processing membership event for UI', {
        eventType: event.type,
        roomId: event.roomId,
      });

      switch (event.type) {
        case 'peer-joined': {
          if (event.peer && event.roomId === store.currentRoomId) {
            store.addKnownPeer(event.peer);
            store.addStatusMessage({
              type: 'info',
              message: `${event.peer.displayName} joined the room`,
              duration: 3000,
            });
            RoomLogger.info('UI updated: Peer joined', {
              peerId: event.peerId,
              displayName: event.peer.displayName,
            });
          }
          break;
        }

        case 'peer-left': {
          if (event.roomId === store.currentRoomId) {
            store.removeKnownPeer(event.peerId);
            store.addStatusMessage({
              type: 'info',
              message: 'A peer left the room',
              duration: 3000,
            });
            RoomLogger.info('UI updated: Peer left', { peerId: event.peerId });
          }
          break;
        }

        case 'peer-disconnected': {
          if (event.roomId === store.currentRoomId) {
            store.updatePeer(event.peerId, { status: 'offline' });
            store.addStatusMessage({
              type: 'warning',
              message: 'A peer disconnected',
              duration: 3000,
            });
            RoomLogger.warn('UI updated: Peer disconnected', {
              peerId: event.peerId,
            });
          }
          break;
        }

        case 'peer-reconnected': {
          if (event.peer && event.roomId === store.currentRoomId) {
            store.updatePeer(event.peerId, {
              status: event.peer.status,
              lastSeenAt: new Date().toISOString(),
            });
            store.addStatusMessage({
              type: 'success',
              message: 'A peer reconnected',
              duration: 3000,
            });
            RoomLogger.info('UI updated: Peer reconnected', {
              peerId: event.peerId,
            });
          }
          break;
        }

        case 'peer-status-changed': {
          if (event.peer && event.roomId === store.currentRoomId) {
            store.updatePeer(event.peerId, {
              status: event.peer.status,
              lastSeenAt: new Date().toISOString(),
            });
            RoomLogger.debug('UI updated: Peer status changed', {
              peerId: event.peerId,
              newStatus: event.peer.status,
            });
          }
          break;
        }

        case 'room-created': {
          if (event.peer) {
            const room = roomManager.current?.getRoomMetadata(event.roomId);
            if (room) {
              store.setCurrentRoom(room);
              store.addStatusMessage({
                type: 'success',
                message: 'Room created successfully',
                duration: 3000,
              });
              RoomLogger.info('UI updated: Room created');
            }
          }
          break;
        }

        case 'room-destroyed': {
          if (store.currentRoomId === event.roomId) {
            store.clearCurrentRoom();
            store.addStatusMessage({
              type: 'warning',
              message: 'Room closed',
              duration: 3000,
            });
            RoomLogger.info('UI updated: Room destroyed');
          }
          break;
        }

        default:
          RoomLogger.warn('Unknown membership event type', {
            eventType: event.type,
          });
      }
    },
    [store],
  );

  return {
    roomManager: roomManager.current,
  };
}
