import type { FilePieceState } from "./protocol";

interface SchedulerEntry {
  state: FilePieceState;
  requestedAt: number | null;
  attemptCount: number;
}

export class PieceScheduler {
  private readonly entries: SchedulerEntry[];
  private availability: Uint8Array | null = null;

  constructor(
    private readonly pieceCount: number,
    private readonly maxInflightPieces: number,
    private readonly retryTimeoutMs: number,
  ) {
    this.entries = Array.from({ length: pieceCount }, () => ({
      state: "pending",
      requestedAt: null,
      attemptCount: 0,
    }));
  }

  setAvailability(bitfield: Uint8Array): void {
    this.availability = bitfield;
  }

  markRequested(pieceIndex: number, now: number): void {
    const entry = this.entries[pieceIndex];
    if (!entry || entry.state === "verified") {
      return;
    }

    entry.state = "requested";
    entry.requestedAt = now;
    entry.attemptCount += 1;
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
  }

  markFailed(pieceIndex: number): void {
    const entry = this.entries[pieceIndex];
    if (!entry) {
      return;
    }

    entry.state = "failed";
    entry.requestedAt = null;
  }

  getState(pieceIndex: number): FilePieceState {
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

  consumeTimedOutPieces(now: number): number[] {
    const timedOut: number[] = [];

    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (entry.state !== "requested" || entry.requestedAt === null) {
        continue;
      }

      if (now - entry.requestedAt >= this.retryTimeoutMs) {
        entry.state = "failed";
        entry.requestedAt = null;
        timedOut.push(index);
      }
    }

    return timedOut;
  }

  getNextRequestPieces(now: number): number[] {
    const requests: number[] = [];

    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (entry.state === "verified" || entry.state === "requested") {
        continue;
      }

      if (this.availability && this.availability.length > 0) {
        const byteIndex = Math.floor(index / 8);
        const bitIndex = index % 8;
        const mask = 1 << bitIndex;
        if ((this.availability[byteIndex] & mask) === 0) {
          continue;
        }
      }

      requests.push(index);
      this.markRequested(index, now);

      if (this.getInflightCount() >= this.maxInflightPieces) {
        break;
      }
    }

    return requests;
  }
}
