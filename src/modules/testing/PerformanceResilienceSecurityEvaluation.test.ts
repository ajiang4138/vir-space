import { describe, expect, it } from 'vitest';
import type { CanvasElement, FileMetadata, Peer } from '../../models/types';
import { ChunkedFileTransferEngine, InMemoryFileTransferTransport, type FileTransferProgress } from '../file-transfer/FileTransferEngine';
import { SharedFileDirectorySync, type DirectorySyncMessage } from '../file-transfer/SharedFileDirectorySync';
import { AuthenticationError, InMemoryRoomPeerManager } from '../room-peer/RoomPeerManager';
import { TransportEncryptionManager } from '../security/TransportEncryption';
import { SyncEngine } from '../workspace-sync/SyncEngine';
import { DecentralizedWorkspaceSyncService } from '../workspace-sync/WorkspaceSyncService';

interface MetricStats {
  minMs: number;
  maxMs: number;
  meanMs: number;
  p95Ms: number;
}

interface FileTransferTrialResult {
  sizeBytes: number;
  latencyMs: number;
  throughputBytesPerSec: number;
}

interface DisruptionTrialResult {
  scenario: 'membership-churn' | 'workspace-reconnect' | 'directory-reconnect';
  success: boolean;
  convergenceMs: number;
}

describe('Performance, Resilience, and Security Evaluation', () => {
  it('collects metrics across lifecycle, synchronization, transfers, disruption, and security', async () => {
    const roomMetrics = await measureRoomLifecycleMetrics(40);
    const workspaceMetrics = await measureWorkspaceSyncMetrics(40);
    const fileTransferMetrics = await measureFileTransferMetrics(3);
    const resilienceMetrics = await measureResilienceMetrics(10);
    const securityMetrics = await measureSecurityMetrics(20);

    const report = {
      generatedAt: new Date().toISOString(),
      roomLifecycle: roomMetrics,
      workspaceSync: workspaceMetrics,
      fileTransfer: fileTransferMetrics,
      resilience: resilienceMetrics,
      security: securityMetrics,
    };

    // This output is used to build the markdown evaluation report.
    console.log('EVALUATION_METRICS_JSON_START');
    console.log(JSON.stringify(report, null, 2));
    console.log('EVALUATION_METRICS_JSON_END');

    expect(roomMetrics.create.meanMs).toBeGreaterThanOrEqual(0);
    expect(workspaceMetrics.updatePropagation.meanMs).toBeGreaterThanOrEqual(0);
    expect(fileTransferMetrics.summary.meanThroughputBytesPerSec).toBeGreaterThan(0);
    expect(resilienceMetrics.successRatePercent).toBeGreaterThanOrEqual(90);
    expect(securityMetrics.unauthorizedBlockedRatePercent).toBe(100);
    expect(securityMetrics.encryptedEnvelopeRatePercent).toBe(100);
  });
});

async function measureRoomLifecycleMetrics(trials: number) {
  const manager = new InMemoryRoomPeerManager();
  const createLatencies: number[] = [];
  const discoverLatencies: number[] = [];
  const joinLatencies: number[] = [];

  for (let i = 0; i < trials; i += 1) {
    const owner = makePeer(`owner-${i}`);
    const joiner = makePeer(`joiner-${i}`);

    const createStart = performance.now();
    const room = manager.createRoom(`room-${i}`, owner, true);
    createLatencies.push(performance.now() - createStart);

    const discoverStart = performance.now();
    await manager.discoverRooms();
    discoverLatencies.push(performance.now() - discoverStart);

    const joinStart = performance.now();
    await manager.joinRoom(room.id, joiner);
    joinLatencies.push(performance.now() - joinStart);
  }

  return {
    trials,
    create: summarize(createLatencies),
    discover: summarize(discoverLatencies),
    join: summarize(joinLatencies),
  };
}

async function measureWorkspaceSyncMetrics(trials: number) {
  const roomId = 'workspace-metrics-room';
  const peerA = new DecentralizedWorkspaceSyncService('ws-peer-a');
  const peerB = new DecentralizedWorkspaceSyncService('ws-peer-b');

  peerA.setPeerConnected(roomId, 'ws-peer-a', true);
  peerA.setPeerConnected(roomId, 'ws-peer-b', true);
  peerB.setPeerConnected(roomId, 'ws-peer-a', true);
  peerB.setPeerConnected(roomId, 'ws-peer-b', true);

  const updatePropagationLatencies: number[] = [];
  const joinResyncLatencies: number[] = [];
  const disconnectResyncLatencies: number[] = [];

  for (let i = 0; i < trials; i += 1) {
    const element: CanvasElement = {
      id: `elem-${i}`,
      type: 'shape',
      x: i,
      y: i,
      width: 50,
      height: 50,
      data: { i },
      createdBy: 'ws-peer-a',
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      modifiedBy: 'ws-peer-a',
    };

    const updateStart = performance.now();
    await peerA.addCanvasElement(roomId, element);
    const delta = await peerA.createSyncMessage(roomId, 'delta');
    await peerB.receiveSyncMessage(delta);
    updatePropagationLatencies.push(performance.now() - updateStart);

    const joinResyncStart = performance.now();
    const lateJoiner = new DecentralizedWorkspaceSyncService(`late-${i}`);
    const snapshot = await peerA.createSnapshot(roomId);
    await lateJoiner.restoreFromSnapshot(roomId, snapshot);
    joinResyncLatencies.push(performance.now() - joinResyncStart);

    const disconnectResyncStart = performance.now();
    peerB.setPeerConnected(roomId, 'ws-peer-a', false);
    peerB.setPeerConnected(roomId, 'ws-peer-a', true);
    const postDisconnectSnapshot = await peerA.createSnapshot(roomId);
    await peerB.restoreFromSnapshot(roomId, postDisconnectSnapshot);
    disconnectResyncLatencies.push(performance.now() - disconnectResyncStart);
  }

  return {
    trials,
    updatePropagation: summarize(updatePropagationLatencies),
    resyncAfterJoin: summarize(joinResyncLatencies),
    resyncAfterDisconnect: summarize(disconnectResyncLatencies),
  };
}

async function measureFileTransferMetrics(trialsPerSize: number) {
  const sizes = [64 * 1024, 512 * 1024, 1024 * 1024, 4 * 1024 * 1024];
  const results: FileTransferTrialResult[] = [];

  for (const sizeBytes of sizes) {
    for (let trial = 0; trial < trialsPerSize; trial += 1) {
      const transport = new InMemoryFileTransferTransport();
      const sender = new ChunkedFileTransferEngine({
        localPeerId: 'ft-peer-a',
        transport,
        chunkSizeBytes: 64 * 1024,
      });
      const receiver = new ChunkedFileTransferEngine({
        localPeerId: 'ft-peer-b',
        transport,
        chunkSizeBytes: 64 * 1024,
      });

      const fileBytes = makePatternBytes(sizeBytes);
      const fileMetadata: FileMetadata = {
        id: `file-${sizeBytes}-${trial}`,
        fileName: `file-${sizeBytes}.bin`,
        filePath: `/tmp/file-${sizeBytes}.bin`,
        sizeBytes: fileBytes.byteLength,
        checksum: 'pending',
        mimeType: 'application/octet-stream',
        createdAt: new Date().toISOString(),
      };

      let completed = false;
      const receiverEvents: FileTransferProgress[] = [];
      receiver.onTransferProgress((progress) => {
        receiverEvents.push(progress);
        if (progress.status === 'completed') {
          completed = true;
        }
      });

      const startedAt = performance.now();
      await sender.startTransfer({
        roomId: 'file-transfer-room',
        senderPeerId: 'ft-peer-a',
        receiverPeerId: 'ft-peer-b',
        file: fileMetadata,
        fileBytes,
      });

      await waitFor(() => completed, 5000);
      const elapsedMs = performance.now() - startedAt;
      const throughputBytesPerSec = fileBytes.byteLength / Math.max(elapsedMs / 1000, 0.001);

      expect(receiverEvents.some((event) => event.status === 'completed')).toBe(true);

      results.push({
        sizeBytes,
        latencyMs: elapsedMs,
        throughputBytesPerSec,
      });

      sender.dispose();
      receiver.dispose();
    }
  }

  const grouped = sizes.map((sizeBytes) => {
    const rows = results.filter((result) => result.sizeBytes === sizeBytes);
    return {
      sizeBytes,
      trials: rows.length,
      latency: summarize(rows.map((row) => row.latencyMs)),
      throughputBytesPerSec: summarize(rows.map((row) => row.throughputBytesPerSec)),
    };
  });

  return {
    trialsPerSize,
    byFileSize: grouped,
    summary: {
      meanLatencyMs: average(results.map((row) => row.latencyMs)),
      meanThroughputBytesPerSec: average(results.map((row) => row.throughputBytesPerSec)),
    },
  };
}

async function measureResilienceMetrics(trialsPerScenario: number) {
  const disruptionTrials: DisruptionTrialResult[] = [];

  for (let i = 0; i < trialsPerScenario; i += 1) {
    disruptionTrials.push(await measureMembershipChurnTrial(i));
    disruptionTrials.push(await measureWorkspaceReconnectTrial(i));
    disruptionTrials.push(measureDirectoryReconnectTrial(i));
  }

  const successes = disruptionTrials.filter((trial) => trial.success).length;
  const successRatePercent = (successes / disruptionTrials.length) * 100;
  const convergenceTimes = disruptionTrials.map((trial) => trial.convergenceMs);

  return {
    trialsPerScenario,
    totalTrials: disruptionTrials.length,
    successes,
    successRatePercent,
    convergence: summarize(convergenceTimes),
    byScenario: ['membership-churn', 'workspace-reconnect', 'directory-reconnect'].map((scenario) => {
      const rows = disruptionTrials.filter((trial) => trial.scenario === scenario);
      const scenarioSuccesses = rows.filter((trial) => trial.success).length;
      return {
        scenario,
        trials: rows.length,
        successRatePercent: (scenarioSuccesses / rows.length) * 100,
        convergence: summarize(rows.map((row) => row.convergenceMs)),
      };
    }),
  };
}

async function measureMembershipChurnTrial(seed: number): Promise<DisruptionTrialResult> {
  const manager = new InMemoryRoomPeerManager();
  const owner = makePeer(`owner-r-${seed}`);
  const churnPeer = makePeer(`churn-r-${seed}`);
  const room = manager.createRoom(`membership-room-${seed}`, owner, true);

  const startedAt = performance.now();
  await manager.joinRoom(room.id, churnPeer);

  for (let i = 0; i < 3; i += 1) {
    manager.simulatePeerDisconnection(room.id, churnPeer.id);
    manager.simulatePeerReconnection(room.id, churnPeer.id, churnPeer);
  }

  const snapshot = manager.getMembershipSnapshot(room.id);
  if (!snapshot) {
    return {
      scenario: 'membership-churn',
      success: false,
      convergenceMs: performance.now() - startedAt,
    };
  }

  manager.applyMembershipSnapshot(snapshot);
  const membership = manager.getLocalMembership(room.id);
  const success = membership?.peers.has(churnPeer.id) === true;

  return {
    scenario: 'membership-churn',
    success,
    convergenceMs: performance.now() - startedAt,
  };
}

async function measureWorkspaceReconnectTrial(seed: number): Promise<DisruptionTrialResult> {
  const roomId = `sync-room-${seed}`;
  const engine = new SyncEngine(roomId, `sync-peer-${seed}`);
  const phases: string[] = [];

  engine.onRecoveryStatus((status) => {
    phases.push(status.phase);
  });

  engine.setConnected(true);
  const startedAt = performance.now();

  engine.setConnected(false);
  engine.markIntermittentConnectivity('simulated-jitter');
  engine.requestResynchronization(
    ['workspace-state', 'room-membership', 'shared-directory-state', 'file-transfers'],
    'resilience-evaluation',
  );
  engine.setConnected(true);
  engine.markResyncInProgress('workspace-state');
  engine.markResyncComplete('workspace-state');

  await sleep(5);

  const success = phases.includes('disconnected') && phases.includes('recovered');
  return {
    scenario: 'workspace-reconnect',
    success,
    convergenceMs: performance.now() - startedAt,
  };
}

function measureDirectoryReconnectTrial(seed: number): DisruptionTrialResult {
  const roomId = `directory-room-${seed}`;
  const outboundA: DirectorySyncMessage[] = [];
  const outboundB: DirectorySyncMessage[] = [];
  const outboundC: DirectorySyncMessage[] = [];
  const peerA = new SharedFileDirectorySync((msg) => outboundA.push(msg));
  const peerB = new SharedFileDirectorySync((msg) => outboundB.push(msg));
  const peerC = new SharedFileDirectorySync((msg) => outboundC.push(msg));

  peerA.joinRoom(roomId, 'peer-a');
  peerB.joinRoom(roomId, 'peer-b');
  peerC.joinRoom(roomId, 'peer-c');

  peerA.announceFile(roomId, 'peer-a', makeDirectoryInput(`seed-a-${seed}`));
  peerB.announceFile(roomId, 'peer-b', makeDirectoryInput(`seed-b-${seed}`));

  const startedAt = performance.now();
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

  const files = peerC.getDirectory(roomId);
  const success = files.length >= 2;
  return {
    scenario: 'directory-reconnect',
    success,
    convergenceMs: performance.now() - startedAt,
  };
}

async function measureSecurityMetrics(trials: number) {
  let unauthorizedBlocked = 0;
  let encryptedEnvelopeCount = 0;
  let wrongSecretRejected = 0;

  for (let i = 0; i < trials; i += 1) {
    const manager = new InMemoryRoomPeerManager();
    const owner = makePeer(`secure-owner-${i}`);
    const intruder = makePeer(`intruder-${i}`);
    const room = manager.createRoom(`secure-room-${i}`, owner, true, 'password');
    manager.setRoomPassword(room.id, 'correct-password');

    try {
      await manager.joinRoom(room.id, intruder, { credential: 'wrong-password' });
    } catch (error) {
      if (error instanceof AuthenticationError) {
        unauthorizedBlocked += 1;
      }
    }

    const sender = new TransportEncryptionManager();
    const receiver = new TransportEncryptionManager();
    sender.setRoomSecret(room.id, 'alpha-secret');
    receiver.setRoomSecret(room.id, 'beta-secret');

    const payload = { kind: 'workspace-update', value: i, token: `token-${i}` };
    const envelope = await sender.encryptPayload(room.id, payload);
    if (sender.isEncryptedEnvelope(envelope) && !envelope.ciphertext.includes('workspace-update')) {
      encryptedEnvelopeCount += 1;
    }

    try {
      await receiver.decryptPayload(room.id, envelope);
    } catch {
      wrongSecretRejected += 1;
    }
  }

  return {
    trials,
    unauthorizedBlocked,
    unauthorizedBlockedRatePercent: (unauthorizedBlocked / trials) * 100,
    encryptedEnvelopeCount,
    encryptedEnvelopeRatePercent: (encryptedEnvelopeCount / trials) * 100,
    wrongSecretRejected,
    wrongSecretRejectedRatePercent: (wrongSecretRejected / trials) * 100,
  };
}

function makePeer(id: string): Peer {
  return {
    id,
    displayName: id,
    status: 'online',
    capabilities: ['edit'],
    lastSeenAt: new Date().toISOString(),
  };
}

function makePatternBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = i % 251;
  }
  return bytes;
}

function makeDirectoryInput(seed: string) {
  return {
    id: `file-${seed}`,
    fileName: `${seed}.txt`,
    filePath: `/workspace/${seed}.txt`,
    sizeBytes: 4096,
    mimeType: 'text/plain',
    checksum: `checksum-${seed}`,
    fileHash: `hash-${seed}`,
    chunkInfo: {
      totalChunks: 4,
      chunkSizeBytes: 1024,
      completedChunks: 4,
    },
  };
}

function summarize(values: number[]): MetricStats {
  if (values.length === 0) {
    return { minMs: 0, maxMs: 0, meanMs: 0, p95Ms: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const p95Index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));

  return {
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    meanMs: average(values),
    p95Ms: sorted[p95Index] ?? 0,
  };
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }

  throw new Error('Timed out waiting for condition.');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}