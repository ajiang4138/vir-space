import type { SwarmPieceState } from "./protocol";
import { getBitfieldValue } from "./protocol";

interface SchedulerEntry {
  state: SwarmPieceState;
  requestedAt: number | null;
  attemptCount: number;
  assignedPeerId: string | null;
}

export interface SchedulerRequest {
  pieceIndex: number;
  sourcePeerId: string;
}

export class PieceScheduler {
  private readonly entries: SchedulerEntry[];
  private maxInflightPieces: number;

  constructor(
    private readonly pieceCount: number,
    maxInflightPieces: number,
    private readonly retryTimeoutMs: number,
  ) {
    this.maxInflightPieces = Math.max(1, Math.floor(maxInflightPieces));
    this.entries = Array.from({ length: pieceCount }, () => ({
      state: "missing",
      requestedAt: null,
      attemptCount: 0,
      assignedPeerId: null,
    }));
  }

  setMaxInflightPieces(maxInflightPieces: number): void {
    this.maxInflightPieces = Math.max(1, Math.floor(maxInflightPieces));
  }

  markRequested(pieceIndex: number, sourcePeerId: string, now: number): void {
    const entry = this.entries[pieceIndex];
    if (!entry || entry.state === "verified") {
      return;
    }

    entry.state = "requested";
    entry.requestedAt = now;
    entry.attemptCount += 1;
    entry.assignedPeerId = sourcePeerId;
  }

  markReceived(pieceIndex: number): void {
    const entry = this.entries[pieceIndex];
    if (!entry) {
      return;
    }

    entry.state = "received";
    entry.requestedAt = null;
  }

  markVerified(pieceIndex: number): void {
    const entry = this.entries[pieceIndex];
    if (!entry) {
      return;
    }

    entry.state = "verified";
    entry.requestedAt = null;
    entry.assignedPeerId = null;
  }

  markFailed(pieceIndex: number): void {
    const entry = this.entries[pieceIndex];
    if (!entry) {
      return;
    }

    entry.state = "failed";
    entry.requestedAt = null;
    entry.assignedPeerId = null;
  }

  markMissing(pieceIndex: number): void {
    const entry = this.entries[pieceIndex];
    if (!entry || entry.state === "verified") {
      return;
    }

    entry.state = "missing";
    entry.requestedAt = null;
    entry.assignedPeerId = null;
  }

  getState(pieceIndex: number): SwarmPieceState {
    return this.entries[pieceIndex]?.state ?? "failed";
  }

  getCompletedCount(): number {
    return this.entries.filter((entry) => entry.state === "verified").length;
  }

  getRequestedCount(): number {
    return this.entries.filter((entry) => entry.state === "requested").length;
  }

  getInflightCount(): number {
    return this.getRequestedCount();
  }

  isComplete(): boolean {
    return this.entries.every((entry) => entry.state === "verified");
  }

  consumeTimedOutPieces(now: number): Array<{ pieceIndex: number; sourcePeerId: string | null }> {
    const timedOut: Array<{ pieceIndex: number; sourcePeerId: string | null }> = [];

    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (entry.state !== "requested" || entry.requestedAt === null) {
        continue;
      }

      if (now - entry.requestedAt >= this.retryTimeoutMs) {
        timedOut.push({ pieceIndex: index, sourcePeerId: entry.assignedPeerId });
        entry.state = "failed";
        entry.requestedAt = null;
        entry.assignedPeerId = null;
      }
    }

    return timedOut;
  }

  clearPeerAssignments(peerId: string): number[] {
    const affected: number[] = [];

    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (entry.assignedPeerId !== peerId) {
        continue;
      }

      if (entry.state === "requested") {
        entry.state = "failed";
      } else if (entry.state === "received") {
        entry.state = "missing";
      }

      entry.requestedAt = null;
      entry.assignedPeerId = null;
      affected.push(index);
    }

    return affected;
  }

  selectRequests(
    localBitfield: Uint8Array,
    peerBitfields: Map<string, Uint8Array>,
    peerInflightCounts: Map<string, number>,
    now: number,
  ): SchedulerRequest[] {
    if (this.getInflightCount() >= this.maxInflightPieces) {
      return [];
    }

    const candidates: Array<{ pieceIndex: number; rarity: number; sourcePeers: string[] }> = [];

    for (let pieceIndex = 0; pieceIndex < this.entries.length; pieceIndex += 1) {
      const entry = this.entries[pieceIndex];
      if (entry.state === "verified" || entry.state === "requested") {
        continue;
      }

      if (getBitfieldValue(localBitfield, pieceIndex)) {
        continue;
      }

      const sourcePeers = Array.from(peerBitfields.entries())
        .filter(([, bitfield]) => getBitfieldValue(bitfield, pieceIndex))
        .map(([peerId]) => peerId);

      if (sourcePeers.length === 0) {
        continue;
      }

      candidates.push({ pieceIndex, rarity: sourcePeers.length, sourcePeers });
    }

    candidates.sort((left, right) => {
      if (left.rarity !== right.rarity) {
        return left.rarity - right.rarity;
      }

      const leftAttempts = this.entries[left.pieceIndex]?.attemptCount ?? 0;
      const rightAttempts = this.entries[right.pieceIndex]?.attemptCount ?? 0;
      if (leftAttempts !== rightAttempts) {
        return leftAttempts - rightAttempts;
      }

      return left.pieceIndex - right.pieceIndex;
    });

    const requests: SchedulerRequest[] = [];
    for (const candidate of candidates) {
      if (this.getInflightCount() + requests.length >= this.maxInflightPieces) {
        break;
      }

      const orderedSources = candidate.sourcePeers.sort((left, right) => {
        const leftInflight = peerInflightCounts.get(left) ?? 0;
        const rightInflight = peerInflightCounts.get(right) ?? 0;
        if (leftInflight !== rightInflight) {
          return leftInflight - rightInflight;
        }

        return left.localeCompare(right);
      });

      const sourcePeerId = orderedSources[0];
      if (!sourcePeerId) {
        continue;
      }

      this.markRequested(candidate.pieceIndex, sourcePeerId, now);
      requests.push({ pieceIndex: candidate.pieceIndex, sourcePeerId });
    }

    return requests;
  }
}
