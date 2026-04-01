import { describe, expect, it } from 'vitest';
import type { DirectorySyncMessage } from './SharedFileDirectorySync';
import { SharedFileDirectorySync } from './SharedFileDirectorySync';

const roomId = 'room-sync-test';

function makeFileInput(seed: string) {
  return {
    id: `file-${seed}`,
    fileName: `${seed}.txt`,
    filePath: `/workspace/${seed}.txt`,
    sizeBytes: 1024,
    mimeType: 'text/plain',
    checksum: `checksum-${seed}`,
    fileHash: `hash-${seed}`,
    chunkInfo: {
      totalChunks: 4,
      chunkSizeBytes: 256,
      completedChunks: 4,
    },
  };
}

describe('SharedFileDirectorySync', () => {
  it('propagates file announcements to peers', () => {
    const peerA = new SharedFileDirectorySync();
    const peerB = new SharedFileDirectorySync();

    peerA.joinRoom(roomId, 'peer-a');
    peerB.joinRoom(roomId, 'peer-b');

    const file = peerA.announceFile(roomId, 'peer-a', makeFileInput('a'));

    const announcement: DirectorySyncMessage = {
      type: 'file-announcement',
      roomId,
      fromPeerId: 'peer-a',
      logicalTimestamp: file.logicalTimestamp,
      directoryVersion: 1,
      file,
    };

    peerB.receiveMessage(announcement);

    const peerBDirectory = peerB.getDirectory(roomId);
    expect(peerBDirectory).toHaveLength(1);
    expect(peerBDirectory[0]?.id).toBe(file.id);
    expect(peerBDirectory[0]?.fileHash).toBe(file.fileHash);
  });

  it('converges directory state via snapshot merge', () => {
    const peerA = new SharedFileDirectorySync();
    const peerB = new SharedFileDirectorySync();

    peerA.joinRoom(roomId, 'peer-a');
    peerB.joinRoom(roomId, 'peer-b');

    peerA.announceFile(roomId, 'peer-a', makeFileInput('a1'));
    peerB.announceFile(roomId, 'peer-b', makeFileInput('b1'));

    peerA.mergeSnapshot(roomId, peerB.getDirectory(roomId));
    peerB.mergeSnapshot(roomId, peerA.getDirectory(roomId));

    const aIds = peerA.getDirectory(roomId).map((file) => file.id).sort();
    const bIds = peerB.getDirectory(roomId).map((file) => file.id).sort();
    expect(aIds).toEqual(bIds);
    expect(aIds).toEqual(['file-a1', 'file-b1']);
  });

  it('supports late join resync using snapshot request and response', () => {
    const outboundFromA: DirectorySyncMessage[] = [];
    const outboundFromB: DirectorySyncMessage[] = [];

    const peerA = new SharedFileDirectorySync((msg) => outboundFromA.push(msg));
    const peerB = new SharedFileDirectorySync((msg) => outboundFromB.push(msg));

    peerA.joinRoom(roomId, 'peer-a');
    peerA.announceFile(roomId, 'peer-a', makeFileInput('existing'));

    peerB.joinRoom(roomId, 'peer-b');
    peerB.requestSnapshot(roomId, 'peer-b');

    for (const msg of outboundFromB.splice(0)) {
      peerA.receiveMessage(msg);
    }
    for (const msg of outboundFromA.splice(0)) {
      peerB.receiveMessage(msg);
    }

    const peerBDirectory = peerB.getDirectory(roomId);
    expect(peerBDirectory).toHaveLength(1);
    expect(peerBDirectory[0]?.id).toBe('file-existing');
  });

  it('routes targeted file requests to the file owner', () => {
    const outboundFromA: DirectorySyncMessage[] = [];
    const outboundFromB: DirectorySyncMessage[] = [];
    const receivedRequestsForA: Array<{ fileId: string; fromPeerId: string; targetPeerId: string }> = [];

    const peerA = new SharedFileDirectorySync((msg) => outboundFromA.push(msg));
    const peerB = new SharedFileDirectorySync((msg) => outboundFromB.push(msg));

    peerA.joinRoom(roomId, 'peer-a');
    peerB.joinRoom(roomId, 'peer-b');
    peerA.announceFile(roomId, 'peer-a', makeFileInput('owner-file'));
    peerA.onFileRequest((_room, req) => {
      receivedRequestsForA.push(req);
    });

    peerB.requestFile(roomId, 'peer-b', 'peer-a', 'file-owner-file');

    for (const msg of outboundFromB.splice(0)) {
      peerA.receiveMessage(msg);
    }

    expect(receivedRequestsForA).toHaveLength(1);
    expect(receivedRequestsForA[0]?.fileId).toBe('file-owner-file');
    expect(receivedRequestsForA[0]?.fromPeerId).toBe('peer-b');
    expect(receivedRequestsForA[0]?.targetPeerId).toBe('peer-a');
  });

  it('resists out-of-order announcement after removal using tombstones', () => {
    const peerA = new SharedFileDirectorySync();
    const peerB = new SharedFileDirectorySync();

    peerA.joinRoom(roomId, 'peer-a');
    peerB.joinRoom(roomId, 'peer-b');

    const announced = peerA.announceFile(roomId, 'peer-a', makeFileInput('churn'));
    peerB.receiveMessage({
      type: 'file-removal',
      roomId,
      fromPeerId: 'peer-a',
      fileId: announced.id,
      logicalTimestamp: announced.logicalTimestamp + 1,
      directoryVersion: 2,
    });

    // Reordered older announcement should not resurrect removed entry.
    peerB.receiveMessage({
      type: 'file-announcement',
      roomId,
      fromPeerId: 'peer-a',
      logicalTimestamp: announced.logicalTimestamp,
      directoryVersion: 1,
      file: announced,
    });

    expect(peerB.getDirectory(roomId)).toHaveLength(0);
  });

  it('converges after repeated reconnect resync cycles across peers', () => {
    const outboundA: DirectorySyncMessage[] = [];
    const outboundB: DirectorySyncMessage[] = [];
    const outboundC: DirectorySyncMessage[] = [];
    const peerA = new SharedFileDirectorySync((msg) => outboundA.push(msg));
    const peerB = new SharedFileDirectorySync((msg) => outboundB.push(msg));
    const peerC = new SharedFileDirectorySync((msg) => outboundC.push(msg));

    peerA.joinRoom(roomId, 'peer-a');
    peerB.joinRoom(roomId, 'peer-b');
    peerC.joinRoom(roomId, 'peer-c');

    peerA.announceFile(roomId, 'peer-a', makeFileInput('seed-a'));
    peerB.announceFile(roomId, 'peer-b', makeFileInput('seed-b'));

    for (let i = 0; i < 3; i += 1) {
      peerC.handlePeerReconnected(roomId, 'peer-c');

      for (const msg of outboundC.splice(0)) {
        peerA.receiveMessage(msg);
        peerB.receiveMessage(msg);
      }

      for (const msg of outboundA.splice(0)) {
        peerC.receiveMessage(msg);
      }
      for (const msg of outboundB.splice(0)) {
        peerC.receiveMessage(msg);
      }
    }

    const peerCIds = peerC.getDirectory(roomId).map((file) => file.id).sort();
    expect(peerCIds).toEqual(['file-seed-a', 'file-seed-b']);
    expect(peerC.getRoomRecoveryStatus(roomId).directoryVersion).toBeGreaterThan(0);
  });
});
