import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, StatusBadge } from '../components/ui';
import { Peer } from '../models/types';
import { useRoomMembershipIntegration } from '../modules/useRoomMembershipIntegration';
import { useUIStore } from '../store/useUIStore';

export function PeerPresencePanelPage() {
  const navigate = useNavigate();
  const { currentRoom, knownPeers, currentPeerName } = useUIStore();
  const { roomManager } = useRoomMembershipIntegration();

  // Get peers from the room manager's membership data or fall back to UI store
  const allPeers = currentRoom
    ? roomManager?.getRoomPeers(currentRoom.id) || knownPeers
    : knownPeers;

  const onlinePeers = allPeers.filter((p) => p.status === 'online');
  const idlePeers = allPeers.filter((p) => p.status === 'idle');
  const offlinePeers = allPeers.filter((p) => p.status === 'offline');

  interface PeerCardProps {
    peer: Peer;
    isCurrentPeer: boolean;
  }

  const PeerCard = ({
    peer,
    isCurrentPeer,
  }: PeerCardProps) => (
    <Card className="hover:shadow-md transition">
      <div className="space-y-3">
        <div className="flex items-start justify-between">
          <div>
            <h4 className="font-semibold text-slate-900">{peer.displayName}</h4>
            {isCurrentPeer && (
              <p className="text-xs font-medium text-blue-600">(You)</p>
            )}
            <p className="mt-1 text-xs text-slate-500">
              ID: <span className="font-mono">{peer.id.slice(0, 8)}</span>
            </p>
          </div>
          <StatusBadge status={peer.status} />
        </div>

        {peer.capabilities && peer.capabilities.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-slate-700">
              Capabilities:
            </p>
            <div className="flex flex-wrap gap-1">
              {peer.capabilities.map((cap: string) => (
                <Badge key={cap} variant="info" className="text-xs">
                  {cap}
                </Badge>
              ))}
            </div>
          </div>
        )}

        <div className="text-xs text-slate-600">
          <p>
            Last seen:{' '}
            {new Date(peer.lastSeenAt).toLocaleTimeString()}
          </p>
        </div>

        {!isCurrentPeer && peer.status === 'online' && (
          <Button size="sm" variant="secondary" className="w-full">
            Send Message
          </Button>
        )}
      </div>
    </Card>
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Peer Presence</h2>
        <p className="mt-1 text-slate-600">
          Track all peers and their collaboration status
        </p>
      </div>

      {allPeers.length === 0 ? (
        <Card title="No Peers Found">
          <p className="text-slate-600">
            You are currently alone. Invite peers to collaborate!
          </p>
        </Card>
      ) : (
        <>
          {onlinePeers.length > 0 && (
            <div>
              <h3 className="mb-3 flex items-center gap-2 font-semibold text-slate-900">
                <span className="h-2 w-2 rounded-full bg-green-500" />
                Online ({onlinePeers.length})
              </h3>
              <div className="grid gap-3 md:grid-cols-2">
                {onlinePeers.map((peer) => (
                  <PeerCard
                    key={peer.id}
                    peer={peer}
                    isCurrentPeer={peer.id === currentPeerName}
                  />
                ))}
              </div>
            </div>
          )}

          {idlePeers.length > 0 && (
            <div>
              <h3 className="mb-3 flex items-center gap-2 font-semibold text-slate-900">
                <span className="h-2 w-2 rounded-full bg-yellow-500" />
                Idle ({idlePeers.length})
              </h3>
              <div className="grid gap-3 md:grid-cols-2">
                {idlePeers.map((peer) => (
                  <PeerCard
                    key={peer.id}
                    peer={peer}
                    isCurrentPeer={peer.id === currentPeerName}
                  />
                ))}
              </div>
            </div>
          )}

          {offlinePeers.length > 0 && (
            <div>
              <h3 className="mb-3 flex items-center gap-2 font-semibold text-slate-900">
                <span className="h-2 w-2 rounded-full bg-slate-400" />
                Offline ({offlinePeers.length})
              </h3>
              <div className="grid gap-3 md:grid-cols-2">
                {offlinePeers.map((peer) => (
                  <PeerCard
                    key={peer.id}
                    peer={peer}
                    isCurrentPeer={peer.id === currentPeerName}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {currentRoom && (
        <div className="space-y-3">
          <Card>
            <h3 className="font-semibold text-slate-900 mb-2">Room Info</h3>
            <div className="space-y-1 text-sm text-slate-600">
              <p>
                <span className="font-medium">Room ID:</span>{' '}
                <span className="font-mono">{currentRoom.id.slice(0, 8)}...</span>
              </p>
              <p>
                <span className="font-medium">Name:</span> {currentRoom.name}
              </p>
              <p>
                <span className="font-medium">Owner:</span> {currentRoom.ownerPeerId.slice(0, 8)}...
              </p>
              <p>
                <span className="font-medium">Members:</span> {allPeers.length}
              </p>
              <p>
                <span className="font-medium">Type:</span>{' '}
                {currentRoom.isPrivate ? 'Private' : 'Public'}
              </p>
              <p>
                <span className="font-medium">Created:</span>{' '}
                {new Date(currentRoom.createdAt).toLocaleDateString()}
              </p>
            </div>
          </Card>
          <Button
            variant="secondary"
            onClick={() => navigate('/workspace')}
            className="w-full"
          >
            Back to Workspace
          </Button>
        </div>
      )}
    </div>
  );
}
