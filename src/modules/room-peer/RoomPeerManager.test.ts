import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Peer } from '../../models/types';
import { RoomManager } from './RoomManager';
import {
    InMemoryRoomPeerManager,
    type MembershipEvent
} from './RoomPeerManager';

describe('RoomPeerManager', () => {
  let manager: InMemoryRoomPeerManager;
  let owner: Peer;
  let peer2: Peer;

  beforeEach(() => {
    manager = new InMemoryRoomPeerManager();
    owner = {
      id: 'peer-1',
      displayName: 'Owner',
      status: 'online',
      capabilities: ['admin'],
      lastSeenAt: new Date().toISOString(),
    };
    peer2 = {
      id: 'peer-2',
      displayName: 'Peer 2',
      status: 'online',
      capabilities: ['edit'],
      lastSeenAt: new Date().toISOString(),
    };
  });

  describe('createRoom', () => {
    it('should create a room with unique ID', () => {
      const room1 = manager.createRoom('Room 1', owner, false);
      const room2 = manager.createRoom('Room 2', owner, false);

      expect(room1.id).not.toBe(room2.id);
      expect(room1.name).toBe('Room 1');
      expect(room2.name).toBe('Room 2');
    });

    it('should create local membership on creation', () => {
      const room = manager.createRoom('Test Room', owner, false);
      const membership = manager.getLocalMembership(room.id);

      expect(membership).not.toBeNull();
      expect(membership?.peers.size).toBe(1);
    });
  });

  describe('joinRoom', () => {
    it('should add peer to room', async () => {
      const room = manager.createRoom('Test Room', owner, false);
      const joinedRoom = await manager.joinRoom(room.id, peer2);

      expect(joinedRoom.peers.length).toBeGreaterThan(1);
    });
  });

  describe('leaveRoom', () => {
    it('should remove peer from room metadata', async () => {
      const room = manager.createRoom('Test Room', owner, false);
      await manager.joinRoom(room.id, peer2);

      // Check room has both peers before leave
      let roomData = manager.getRoomMetadata(room.id);
      expect(roomData?.peers.length).toBe(2);

      // Peer2 leaves
      await manager.leaveRoom(room.id, peer2.id);

      // Check room now has only owner
      roomData = manager.getRoomMetadata(room.id);
      expect(roomData?.peers.length).toBe(1);
    });
  });

  describe('broadcastPeerPresence', () => {
    it('should update peer status', async () => {
      const room = manager.createRoom('Test Room', owner, false);
      await manager.joinRoom(room.id, peer2);

      const updatedPeer = { ...peer2, status: 'idle' as const };
      await manager.broadcastPeerPresence(room.id, updatedPeer);

      const membership = manager.getLocalMembership(room.id);
      const status = membership?.peerStatuses.get(peer2.id);
      expect(status).toBe('idle');
    });
  });

  describe('handleMembershipEvent', () => {
    it('should handle peer-joined event', () => {
      const room = manager.createRoom('Test Room', owner, false);

      manager.handleMembershipEvent({
        type: 'peer-joined',
        roomId: room.id,
        peerId: peer2.id,
        peer: peer2,
        timestamp: new Date().toISOString(),
      });

      const membership = manager.getLocalMembership(room.id);
      expect(membership?.peers.has(peer2.id)).toBe(true);
    });

    it('should recover membership from snapshots after churn', async () => {
      const room = manager.createRoom('Test Room', owner, false);
      await manager.joinRoom(room.id, peer2);

      for (let i = 0; i < 3; i += 1) {
        manager.simulatePeerDisconnection(room.id, peer2.id);
        manager.simulatePeerReconnection(room.id, peer2.id, peer2);
      }

      const snapshot = manager.getMembershipSnapshot(room.id);
      expect(snapshot).not.toBeNull();

      if (!snapshot) {
        return;
      }

      manager.handleMembershipEvent({
        type: 'peer-left',
        roomId: room.id,
        peerId: peer2.id,
        timestamp: new Date().toISOString(),
      });

      manager.applyMembershipSnapshot(snapshot);
      const membership = manager.getLocalMembership(room.id);
      expect(membership?.peers.has(peer2.id)).toBe(true);
      expect(membership?.peerStatuses.get(peer2.id)).toBe('online');
    });
  });

  describe('event subscription', () => {
    it('should allow subscribing and unsubscribing to events', () => {
      const events: MembershipEvent[] = [];
      const unsubscribe = manager.onMembershipEvent((event: MembershipEvent) => {
        events.push(event);
      });

      manager.createRoom('Test Room', owner, false);
      expect(events.length).toBeGreaterThan(0);

      unsubscribe();
      const countBefore = events.length;
      manager.createRoom('Another Room', owner, false);

      expect(events.length).toBe(countBefore);
    });
  });
});

describe('RoomManager', () => {
  let manager: RoomManager;
  let owner: Peer;

  beforeEach(() => {
    manager = new RoomManager();
    owner = {
      id: 'peer-1',
      displayName: 'Owner',
      status: 'online',
      capabilities: ['admin'],
      lastSeenAt: new Date().toISOString(),
    };
  });

  afterEach(() => {
    manager.destroy();
  });

  describe('facade methods', () => {
    it('should create room', () => {
      const room = manager.createRoom('Test Room', owner, false);

      expect(room).toBeDefined();
      expect(room.name).toBe('Test Room');
    });

    it('should discover rooms', async () => {
      const room = manager.createRoom('Test Room', owner, false);
      const discovered = await manager.discoverRooms();

      expect(discovered.map((r) => r.id)).toContain(room.id);
    });
  });
});
