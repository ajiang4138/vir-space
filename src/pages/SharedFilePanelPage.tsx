import { type ChangeEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card } from '../components/ui';
import { useFileTransferIntegration } from '../modules/file-transfer/useFileTransferIntegration';
import { useSharedFileDirectoryIntegration } from '../modules/file-transfer/useSharedFileDirectoryIntegration';
import { useUIStore } from '../store/useUIStore';

export function SharedFilePanelPage() {
  const navigate = useNavigate();
  const { sharedFiles, transferSessions, currentPeerId, addStatusMessage } =
    useUIStore();
  const { removeFile } = useSharedFileDirectoryIntegration();
  const { sendFile, requestMissingFile } = useFileTransferIntegration();
  const [isAdding, setIsAdding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const getFileIcon = (mimeType: string): string => {
    if (mimeType.startsWith('image')) return '🖼️';
    if (mimeType.startsWith('video')) return '🎬';
    if (mimeType.startsWith('audio')) return '🎵';
    if (mimeType.includes('pdf')) return '📄';
    if (
      mimeType.includes('word') ||
      mimeType.includes('document')
    )
      return '📝';
    if (mimeType.includes('sheet') || mimeType.includes('csv')) return '📊';
    if (mimeType.includes('json') || mimeType.includes('code'))
      return '💻';
    return '📦';
  };

  const handleAddFile = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) {
      return;
    }

    setIsAdding(true);
    try {
      await sendFile(selectedFile);
      addStatusMessage({
        type: 'success',
        message: `Queued ${selectedFile.name} for peer-to-peer transfer.`,
        duration: 2500,
      });
    } finally {
      setIsAdding(false);
      event.target.value = '';
    }
  };

  const isFileAvailableLocally = (fileId: string): boolean => {
    if (!currentPeerId) {
      return false;
    }

    const related = transferSessions.filter((session) => session.file.id === fileId);
    return related.some(
      (session) =>
        (session.senderPeerId === currentPeerId || session.receiverPeerId === currentPeerId)
        && session.status === 'completed'
        && session.verificationStatus === 'verified',
    );
  };

  const availableFiles = sharedFiles.filter((file) => isFileAvailableLocally(file.id));
  const inProgressTransfers = transferSessions.filter((session) => session.status === 'in-progress');
  const completedTransfers = transferSessions.filter((session) => session.status === 'completed');
  const failedTransfers = transferSessions.filter((session) => session.status === 'failed');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Shared Files</h2>
          <p className="mt-1 text-slate-600">
            Manage files shared within the workspace
          </p>
        </div>
        <Button
          onClick={handleAddFile}
          variant="primary"
          size="sm"
          loading={isAdding}
        >
          + Add File
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileSelected}
        />
      </div>

      {sharedFiles.length === 0 ? (
        <Card title="No Files Shared">
          <div className="text-center">
            <div className="mb-3 text-3xl">📁</div>
            <p className="mb-4 text-slate-600">
              No files have been shared yet. Share files to collaborate!
            </p>
            <Button onClick={handleAddFile} loading={isAdding}>
              Share First File
            </Button>
          </div>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3">
            {sharedFiles.map((file) => (
              <Card key={file.id} className="hover:shadow-md transition">
                <div className="flex items-start gap-4">
                  <div className="text-3xl">
                    {getFileIcon(file.mimeType)}
                  </div>

                  <div className="flex-1">
                    <h4 className="font-semibold text-slate-900">
                      {file.fileName}
                    </h4>
                    <div className="mt-2 space-y-1 text-sm text-slate-600">
                      <p>
                        <span className="font-medium">Size:</span>{' '}
                        {formatFileSize(file.sizeBytes)}
                      </p>
                      <p>
                        <span className="font-medium">Type:</span> {file.mimeType}
                      </p>
                      <p>
                        <span className="font-medium">Version:</span> v{file.version} @ {file.logicalTimestamp}
                      </p>
                      <p>
                        <span className="font-medium">Chunks:</span>{' '}
                        {file.chunkInfo.completedChunks}/{file.chunkInfo.totalChunks}
                      </p>
                      <p>
                        <span className="font-medium">Availability:</span>{' '}
                        {isFileAvailableLocally(file.id) ? 'Available locally' : 'Directory metadata only'}
                      </p>
                      <p>
                        <span className="font-medium">Added:</span>{' '}
                        {new Date(file.createdAt).toLocaleString()}
                      </p>
                      <p className="font-mono text-xs">
                        <span className="font-medium">Hash:</span> {file.fileHash.slice(0, 12)}...
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    {!isFileAvailableLocally(file.id) && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          requestMissingFile(file.id);
                          addStatusMessage({
                            type: 'info',
                            message: `Requested ${file.fileName} from ${file.announcedByPeerId}.`,
                            duration: 2200,
                          });
                        }}
                      >
                        Request File
                      </Button>
                    )}
                    {isFileAvailableLocally(file.id) && (
                      <Button size="sm" variant="secondary">
                        Available
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        removeFile(file.id);
                        addStatusMessage({
                          type: 'info',
                          message: `File "${file.fileName}" removed`,
                        });
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <div className="rounded-lg bg-blue-50 p-4">
            <p className="text-sm text-blue-900">
              <span className="font-semibold">Total Files:</span>{' '}
              {sharedFiles.length} •{' '}
              <span className="font-semibold">Total Size:</span>{' '}
              {formatFileSize(
                sharedFiles.reduce((sum, f) => sum + f.sizeBytes, 0)
              )}
            </p>
          </div>
        </>
      )}

      <Card title={`Available Shared Files (${availableFiles.length})`}>
        {availableFiles.length === 0 ? (
          <p className="text-sm text-slate-600">No shared files have completed local transfer yet.</p>
        ) : (
          <div className="space-y-2">
            {availableFiles.map((file) => (
              <div key={`available-${file.id}`} className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <p className="text-sm font-semibold text-emerald-900">{file.fileName}</p>
                <p className="text-xs text-emerald-800">
                  Verified and ready ({formatFileSize(file.sizeBytes)})
                </p>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={`Transfer Progress (${inProgressTransfers.length})`}>
        {inProgressTransfers.length === 0 ? (
          <p className="text-sm text-slate-600">No active transfers.</p>
        ) : (
          <div className="space-y-3">
            {inProgressTransfers.map((session) => (
              <div key={`progress-${session.id}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-sm font-semibold text-slate-900">{session.file.fileName}</p>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full bg-blue-500 transition-all"
                    style={{ width: `${session.progressPercent}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-slate-600">{session.progressPercent}%</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={`Completed Transfers (${completedTransfers.length})`}>
        {completedTransfers.length === 0 ? (
          <p className="text-sm text-slate-600">No completed transfers yet.</p>
        ) : (
          <div className="space-y-2">
            {completedTransfers.map((session) => (
              <div key={`completed-${session.id}`} className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <p className="text-sm font-semibold text-emerald-900">{session.file.fileName}</p>
                <p className="text-xs text-emerald-800">
                  {session.verificationStatus === 'verified' ? 'Verified' : 'Completed'}
                </p>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={`Failed Transfers (${failedTransfers.length})`}>
        {failedTransfers.length === 0 ? (
          <p className="text-sm text-slate-600">No failed transfers.</p>
        ) : (
          <div className="space-y-2">
            {failedTransfers.map((session) => {
              const file = sharedFiles.find((entry) => entry.id === session.file.id);
              return (
                <div key={`failed-${session.id}`} className="rounded-lg border border-red-200 bg-red-50 p-3">
                  <p className="text-sm font-semibold text-red-900">{session.file.fileName}</p>
                  <p className="mt-1 text-xs text-red-700">{session.error ?? 'Transfer failed.'}</p>
                  {file && file.announcedByPeerId !== currentPeerId && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-2"
                      onClick={() => requestMissingFile(file.id)}
                    >
                      Retry Request
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Button variant="secondary" onClick={() => navigate('/workspace')}>
        Back to Workspace
      </Button>
    </div>
  );
}
