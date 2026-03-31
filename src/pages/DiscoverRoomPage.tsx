import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, StatusBadge } from '../components/ui';
import { Room } from '../models/types';
import { getRoomManager } from '../modules/room-peer/RoomManager';
import { RoomLogger } from '../modules/room-peer/RoomPeerManager';
import { useUIStore } from '../store/useUIStore';

export function DiscoverRoomPage() {
  const navigate = useNavigate();
  const store = useUIStore();
  const roomManager = getRoomManager();

  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [joinLoading, setJoinLoading] = useState<string | null>(null);

  useEffect(() => {
    const discoverRooms = async () => {
      try {
        setLoading(true);
        const discoveredRooms = await roomManager.discoverRooms();
        setRooms(discoveredRooms);
        RoomLogger.info('Rooms discovered', { count: discoveredRooms.length });

        store.addStatusMessage({
          type: 'info',
          message: `Found ${discoveredRooms.length} available room${discoveredRooms.length !== 1 ? 's' : ''}`,
          duration: 3000,
        });
      } catch (error) {
        RoomLogger.error('Failed to discover rooms', {
          error: error instanceof Error ? error.message : String(error),
        });
        store.addStatusMessage({
          type: 'error',
          message: 'Failed to discover rooms',
        });
      } finally {
        setLoading(false);
      }
    };

    discoverRooms();
  }, [roomManager, store]);

  const handleJoinRoom = async (room: Room) => {
    if (!store.currentPeerId) {
      store.addStatusMessage({
        type: 'error',
        message: 'Peer ID not set',
      });
      return;
    }

    setJoinLoading(room.id);
    try {
      const peer = {
        id: store.currentPeerId,
        displayName: store.currentPeerName,
        status: 'online' as const,
        capabilities: ['edit', 'view'],
        lastSeenAt: new Date().toISOString(),
      };

      const joinedRoom = await roomManager.joinRoom(room.id, peer);

      RoomLogger.info('Room joined from discovery', {
        roomId: room.id,
        peerId: peer.id,
      });

      store.setCurrentRoom(joinedRoom);

      // Add the joining peer and all room peers to known peers
      store.addKnownPeer(peer);
      joinedRoom.peers.forEach((p) => {
        if (p.id !== peer.id) {
          store.addKnownPeer(p);
        }
      });

      store.addStatusMessage({
        type: 'success',
        message: `Joined room "${joinedRoom.name}"`,
        duration: 4000,
      });

      navigate('/workspace');
    } catch (error) {
      RoomLogger.error('Failed to join room from discovery', {
        error: error instanceof Error ? error.message : String(error),
        roomId: room.id,
      });
      store.addStatusMessage({
        type: 'error',
        message: 'Failed to join room',
      });
    } finally {
      setJoinLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Available Rooms</h2>
        <p className="mt-1 text-slate-600">
          Browse and join public rooms in your network
        </p>
      </div>

      {loading ? (
        <Card title="Loading..." subtitle="Discovering available rooms...">
          <div className="flex items-center gap-2">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-r-transparent" />
            <p className="text-slate-600">Searching for available rooms...</p>
          </div>
        </Card>
      ) : rooms.length === 0 ? (
        <Card title="No Rooms Found">
          <div className="text-center">
            <p className="text-slate-600">
              No public rooms are currently available. Try creating one instead!
            </p>
            <Button
              variant="primary"
              className="mt-4"
              onClick={() => navigate('/create-room')}
            >
              Create Room
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4">
          {rooms.map((room) => (
            <Card key={room.id} className="hover:shadow-md transition">
              <div className="space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900">
                      {room.name}
                    </h3>
                    <p className="mt-1 text-sm text-slate-600">
                      Created by {room.peers[0]?.displayName || 'Unknown'}
                    </p>
                  </div>
                  {room.isPrivate && (
                    <Badge variant="warning">Private</Badge>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  {room.peers.slice(0, 3).map((peer) => (
                    <div
                      key={peer.id}
                      className="flex items-center gap-2 rounded-full bg-slate-50 px-3 py-1.5"
                    >
                      <span className="text-sm text-slate-700">
                        {peer.displayName}
                      </span>
                      <StatusBadge status={peer.status} />
                    </div>
                  ))}
                  {room.peers.length > 3 && (
                    <div className="rounded-full bg-slate-50 px-3 py-1.5 text-sm text-slate-600">
                      +{room.peers.length - 3} more
                    </div>
                  )}
                </div>

                <div className="text-xs text-slate-500">
                  {room.peers.length} peer{room.peers.length !== 1 ? 's' : ''} •
                  {' '}
                  {Math.floor(
                    (Date.now() - new Date(room.createdAt).getTime()) /
                      (60 * 1000)
                  )}{' '}
                  minutes old
                </div>

                <Button
                  size="sm"
                  onClick={() => handleJoinRoom(room)}
                  loading={joinLoading === room.id}
                  className="w-full"
                >
                  Join Room
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
