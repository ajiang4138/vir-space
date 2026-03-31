import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, StatusBadge } from '../components/ui';
import { useUIStore } from '../store/useUIStore';

export function WorkspaceViewPage() {
  const navigate = useNavigate();
  const {
    currentRoom,
    currentPeerName,
    sharedFiles,
    transferSessions,
    systemStatus,
  } = useUIStore();

  if (!currentRoom) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card title="Not in a Room">
          <p className="mb-4 text-slate-600">
            You need to create or join a room first to access the workspace.
          </p>
          <Button onClick={() => navigate('/')}>Back to Home</Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">{currentRoom.name}</h2>
          <p className="mt-1 text-slate-600">
            Room ID: <span className="font-mono text-sm">{currentRoom.id}</span>
          </p>
        </div>
        {currentRoom.isPrivate && (
          <Badge variant="warning">Private Room</Badge>
        )}
      </div>

      {systemStatus !== 'connected' && systemStatus !== 'authenticated' && (
        <div className="rounded-lg bg-yellow-50 p-4">
          <p className="text-sm text-yellow-900">
            <span className="font-semibold">System Status:</span>{' '}
            <span className="capitalize">{systemStatus}</span>
          </p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-4">
        {/* Collaborative Canvas Area */}
        <div className="lg:col-span-2">
          <Card title="Collaborative Canvas" className="h-full">
            <div className="flex h-80 items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50">
              <div className="text-center">
                <div className="mb-3 text-4xl">📐</div>
                <p className="text-slate-600">Collaborative workspace area</p>
                <p className="mt-1 text-sm text-slate-500">
                  Real-time drawing and editing will render here
                </p>
              </div>
            </div>
          </Card>
        </div>

        {/* Peer Presence Panel */}
        <div>
          <Card title={`Peers (${currentRoom.peers.length})`} className="h-full">
            <div className="space-y-3">
              {currentRoom.peers.length === 0 ? (
                <p className="text-sm text-slate-600">No peers in room</p>
              ) : (
                currentRoom.peers.map((peer) => (
                  <div
                    key={peer.id}
                    className="rounded-lg border border-slate-200 bg-slate-50 p-3"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-sm font-medium text-slate-900">
                          {peer.displayName}
                        </p>
                        {peer.id === currentPeerName && (
                          <p className="text-xs text-blue-600">(You)</p>
                        )}
                      </div>
                      <StatusBadge status={peer.status} />
                    </div>
                    {peer.capabilities.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {peer.capabilities.slice(0, 2).map((cap) => (
                          <Badge
                            key={cap}
                            variant="info"
                            className="text-xs"
                          >
                            {cap}
                          </Badge>
                        ))}
                        {peer.capabilities.length > 2 && (
                          <Badge variant="info" className="text-xs">
                            +{peer.capabilities.length - 2}
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>

        {/* Shared Files Panel */}
        <div>
          <Card title={`Files (${sharedFiles.length})`} className="h-full">
            <div className="space-y-2">
              {sharedFiles.length === 0 ? (
                <p className="text-sm text-slate-600">No files shared</p>
              ) : (
                sharedFiles.map((file) => (
                  <div
                    key={file.id}
                    className="rounded-lg border border-slate-200 bg-slate-50 p-2"
                  >
                    <p className="truncate text-sm font-medium text-slate-900">
                      {file.fileName}
                    </p>
                    <p className="text-xs text-slate-500">
                      {(file.sizeBytes / 1024).toFixed(1)} KB
                    </p>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* Transfer Status/Log Panel */}
      <Card title={`Transfers (${transferSessions.length})`}>
        {transferSessions.length === 0 ? (
          <p className="text-sm text-slate-600">No active transfers</p>
        ) : (
          <div className="space-y-3">
            {transferSessions.map((session) => (
              <div
                key={session.id}
                className="rounded-lg border border-slate-200 bg-slate-50 p-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <p className="text-sm font-medium text-slate-900">
                      {session.file.fileName}
                    </p>
                    <p className="text-xs text-slate-600">
                      {session.senderPeerId === currentRoom.peers[0]?.id
                        ? 'Sending'
                        : 'Receiving'}{' '}
                      from {session.senderPeerId}
                    </p>
                  </div>
                  <Badge
                    variant={
                      session.status === 'completed'
                        ? 'success'
                        : session.status === 'failed'
                          ? 'error'
                          : 'info'
                    }
                  >
                    {session.status}
                  </Badge>
                </div>

                {session.status === 'in-progress' && (
                  <div className="mt-2">
                    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                      <div
                        className="h-full bg-blue-500 transition-all"
                        style={{ width: `${session.progressPercent}%` }}
                      />
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      {session.progressPercent}% complete
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="rounded-lg bg-blue-50 p-4">
        <p className="mb-3 text-sm font-semibold text-blue-900">
          Current Session Info
        </p>
        <div className="grid gap-2 text-sm text-blue-900">
          <p>
            <span className="font-semibold">Your Name:</span> {currentPeerName}
          </p>
          <p>
            <span className="font-semibold">Room Status:</span>{' '}
            <span className="capitalize">{systemStatus}</span>
          </p>
          <p>
            <span className="font-semibold">Room Privacy:</span>{' '}
            {currentRoom.isPrivate ? 'Private' : 'Public'}
          </p>
          <p>
            <span className="font-semibold">Created:</span>{' '}
            {new Date(currentRoom.createdAt).toLocaleString()}
          </p>
        </div>
      </div>

      <Button variant="secondary" onClick={() => navigate('/')}>
        Leave Room
      </Button>
    </div>
  );
}
