import type { FileMetadata, TransferSession } from '../../models/types';

export interface FileTransferEngine {
  startTransfer(roomId: string, file: FileMetadata, senderPeerId: string): Promise<TransferSession>;
  cancelTransfer(sessionId: string): Promise<void>;
}

export class PlaceholderFileTransferEngine implements FileTransferEngine {
  async startTransfer(
    roomId: string,
    file: FileMetadata,
    senderPeerId: string,
  ): Promise<TransferSession> {
    return {
      id: crypto.randomUUID(),
      roomId,
      senderPeerId,
      receiverPeerId: 'broadcast',
      file,
      status: 'queued',
      progressPercent: 0,
      startedAt: new Date().toISOString(),
    };
  }

  async cancelTransfer(_sessionId: string): Promise<void> {
    void _sessionId;
    return;
  }
}
