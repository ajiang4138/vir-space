import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card } from '../components/ui';
import { FileMetadata } from '../models/types';
import { useUIStore } from '../store/useUIStore';

export function SharedFilePanelPage() {
  const navigate = useNavigate();
  const { sharedFiles, addSharedFile, removeSharedFile, addStatusMessage } =
    useUIStore();
  const [isAdding, setIsAdding] = useState(false);

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
    setIsAdding(true);
    // Simulate adding a file
    setTimeout(() => {
      const mockFile: FileMetadata = {
        id: `file-${Date.now()}`,
        fileName: `document-${Math.random().toString(36).slice(2, 9)}.pdf`,
        filePath: `/workspace/shared/${Math.random().toString(36).slice(2, 9)}.pdf`,
        sizeBytes: Math.floor(Math.random() * 10000000) + 100000,
        checksum: Math.random().toString(36).slice(2),
        mimeType: 'application/pdf',
        createdAt: new Date().toISOString(),
      };
      addSharedFile(mockFile);
      addStatusMessage({
        type: 'success',
        message: `File "${mockFile.fileName}" added to shared files`,
      });
      setIsAdding(false);
    }, 1000);
  };

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
                        <span className="font-medium">Added:</span>{' '}
                        {new Date(file.createdAt).toLocaleString()}
                      </p>
                      <p className="font-mono text-xs">
                        <span className="font-medium">Checksum:</span> {file.checksum.slice(0, 12)}...
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Button size="sm" variant="secondary">
                      Download
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        removeSharedFile(file.id);
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

      <Button variant="secondary" onClick={() => navigate('/workspace')}>
        Back to Workspace
      </Button>
    </div>
  );
}
