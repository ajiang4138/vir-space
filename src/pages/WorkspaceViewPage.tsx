'use client';

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { CollaborativeCanvas } from '../components/CollaborativeCanvas';
import { SyncStatusIndicator } from '../components/SyncStatusIndicator';
import { Badge, Button, Card } from '../components/ui';
import { SyncEngine } from '../modules/workspace-sync/SyncEngine';
import { useCollaborativeCanvas } from '../modules/workspace-sync/useCollaborativeCanvas';
import { useUIStore } from '../store/useUIStore';

export function WorkspaceViewPage() {
  const navigate = useNavigate();
  const {
    currentRoom,
    currentPeerId,
    currentPeerName,
    sharedFiles,
    transferSessions,
    systemStatus,
  } = useUIStore();
  const currentRoomId = currentRoom?.id ?? null;

  const syncEngine = useMemo(() => {
    if (!currentRoomId || !currentPeerId) {
      return null;
    }
    return new SyncEngine(currentRoomId, currentPeerId);
  }, [currentPeerId, currentRoomId]);

  const canvasState = useCollaborativeCanvas(
    currentRoom && currentPeerId && syncEngine
      ? {
          roomId: currentRoom.id,
          peerId: currentPeerId,
          syncEngine,
        }
      : null,
  );

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

  if (!canvasState) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card title="Initializing Workspace">
          <p className="mb-4 text-slate-600">
            Setting up collaborative workspace...
          </p>
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
        <div className="flex items-center gap-3">
          {currentRoom.isPrivate && (
            <Badge variant="warning">Private Room</Badge>
          )}
          {canvasState.recoveryPhase !== 'stable' && canvasState.recoveryPhase !== 'recovered' && (
            <Badge variant="info">Recovery: {canvasState.recoveryPhase}</Badge>
          )}
          <SyncStatusIndicator
            syncStatus={canvasState.syncStatus}
            pendingOperations={canvasState.pendingOperations}
            isConverged={canvasState.isConverged}
          />
        </div>
      </div>

      {systemStatus !== 'connected' && systemStatus !== 'authenticated' && (
        <div className="rounded-lg bg-yellow-50 p-4">
          <p className="text-sm text-yellow-900">
            <span className="font-semibold">System Status:</span>{' '}
            <span className="capitalize">{systemStatus}</span>
          </p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Collaborative Canvas Area */}
        <div className="lg:col-span-2">
          <Card title="Collaborative Canvas" className="h-full">
            <div className="h-96 w-full">
              <CollaborativeCanvas
                canvasState={canvasState.canvasState}
                operations={canvasState.operations}
                syncStatus={canvasState.syncStatus}
                peerId={currentPeerId ?? currentPeerName}
                pendingOperations={canvasState.pendingOperations}
                isConverged={canvasState.isConverged}
              />
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

      {/* Canvas Controls and Help */}
      <Card title="Canvas Controls" className="bg-blue-50">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="font-semibold text-slate-900">Canvas Actions</h3>
            <ul className="mt-2 space-y-1 text-sm text-slate-600">
              <li>🖱️ <strong>Click on canvas</strong> to add new shapes</li>
              <li>🔄 <strong>Drag shapes</strong> to move them around</li>
              <li>🗑️ <strong>Press Delete</strong> to remove selected shapes</li>
              <li>📍 <strong>Click shapes</strong> to select/deselect</li>
            </ul>
          </div>
          <div>
            <h3 className="font-semibold text-slate-900">Sync Status</h3>
            <p className="mt-2 text-sm text-slate-600">
              All changes are synchronized in real-time across connected peers. 
              The status indicator shows the current synchronization state.
            </p>
          </div>
        </div>
      </Card>

      {/* Transfer Status/Log Panel */}
      {transferSessions.length > 0 && (
        <Card title={`Transfers (${transferSessions.length})`}>
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
                    {session.status === 'completed' && session.verificationStatus === 'verified'
                      ? 'verified'
                      : session.status}
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

                {session.error && (
                  <p className="mt-2 text-xs text-red-700">
                    {session.error}
                  </p>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

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
            Private
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
