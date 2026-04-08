import type { TorrentManifest } from "../../shared/fileTransfer";

// Keep piece payloads comfortably below common RTCDataChannel per-message caps.
// Frame headers add overhead, so using 64 KiB avoids edge-case send failures.
export const DEFAULT_PIECE_SIZE = 64 * 1024;
export const DEFAULT_MAX_INFLIGHT_REQUESTS = 6;
export const DEFAULT_PIECE_REQUEST_TIMEOUT_MS = 12_000;
export const FILE_CONTROL_CHANNEL_LABEL = "file-transfer-control";
export const FILE_DATA_CHANNEL_LABEL = "file-transfer-data";
export const APP_DATA_CHANNEL_LABEL = "app-data";

export type SwarmPieceState = "missing" | "requested" | "received" | "verified" | "failed";

export type SwarmControlMessage =
  | {
      type: "torrent-announcement";
      torrentId: string;
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
      manifest: TorrentManifest;
      announcedAt: number;
    }
  | {
      type: "torrent-join";
      torrentId: string;
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
      interested: boolean;
    }
  | {
      type: "torrent-leave";
      torrentId: string;
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
      reason?: string;
    }
  | {
      type: "torrent-manifest";
      torrentId: string;
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
      manifest: TorrentManifest;
    }
  | {
      type: "bitfield";
      torrentId: string;
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
      availablePieces: string;
      pieceCount: number;
    }
  | {
      type: "have";
      torrentId: string;
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
      pieceIndex: number;
    }
  | {
      type: "interested";
      torrentId: string;
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
    }
  | {
      type: "not-interested";
      torrentId: string;
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
    }
  | {
      type: "request-piece";
      torrentId: string;
      roomId: string;
      senderPeerId: string;
      receiverPeerId: string;
      pieceIndex: number;
      requestId: string;
    }
  | {
      type: "cancel-piece";
      torrentId: string;
      roomId: string;
      senderPeerId: string;
      receiverPeerId: string;
      pieceIndex: number;
      requestId: string;
      reason?: string;
    }
  | {
      type: "reject-piece";
      torrentId: string;
      roomId: string;
      senderPeerId: string;
      receiverPeerId: string;
      pieceIndex: number;
      requestId: string;
      reason: string;
    }
  | {
      type: "piece-verified";
      torrentId: string;
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
      pieceIndex: number;
    }
  | {
      type: "transfer-complete";
      torrentId: string;
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
    }
  | {
      type: "transfer-cancel";
      torrentId: string;
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
      reason: string;
    }
  | {
      type: "transfer-error";
      torrentId: string;
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
      message: string;
    }
  | {
      type: "choke";
      torrentId: string;
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
      reason?: string;
    }
  | {
      type: "unchoke";
      torrentId: string;
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
      reason?: string;
    };

export interface TorrentBinaryFrameHeader {
  type: "piece-data";
  torrentId: string;
  roomId: string;
  senderPeerId: string;
  receiverPeerId: string;
  pieceIndex: number;
  byteLength: number;
  pieceHash: string;
  requestId: string;
}

export interface DecodedTorrentBinaryFrame {
  header: TorrentBinaryFrameHeader;
  payload: Uint8Array;
}

export function encodeControlMessage(message: SwarmControlMessage): string {
  return JSON.stringify(message);
}

export function tryParseControlMessage(raw: string): SwarmControlMessage | null {
  try {
    const parsed = JSON.parse(raw) as SwarmControlMessage;
    if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function encodeBinaryFrame(header: TorrentBinaryFrameHeader, payload: Uint8Array): ArrayBuffer {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const frame = new Uint8Array(4 + headerBytes.length + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, headerBytes.length, true);
  frame.set(headerBytes, 4);
  frame.set(payload, 4 + headerBytes.length);
  return frame.buffer;
}

export function decodeBinaryFrame(data: ArrayBuffer | Uint8Array): DecodedTorrentBinaryFrame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 4) {
    throw new Error("Invalid binary frame");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(0, true);
  if (headerLength <= 0 || 4 + headerLength > bytes.byteLength) {
    throw new Error("Invalid binary frame header");
  }

  const headerBytes = bytes.slice(4, 4 + headerLength);
  const payload = bytes.slice(4 + headerLength);
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as TorrentBinaryFrameHeader;

  if (header.type !== "piece-data") {
    throw new Error("Unsupported binary frame type");
  }

  return { header, payload };
}

export function createBitfield(pieceCount: number): Uint8Array {
  return new Uint8Array(Math.ceil(pieceCount / 8));
}

export function cloneBitfield(bitfield: Uint8Array): Uint8Array {
  return new Uint8Array(bitfield);
}

export function setBitfieldValue(bitfield: Uint8Array, pieceIndex: number, value: boolean): void {
  const byteIndex = Math.floor(pieceIndex / 8);
  const bitIndex = pieceIndex % 8;
  const mask = 1 << bitIndex;

  if (value) {
    bitfield[byteIndex] |= mask;
  } else {
    bitfield[byteIndex] &= ~mask;
  }
}

export function getBitfieldValue(bitfield: Uint8Array, pieceIndex: number): boolean {
  const byteIndex = Math.floor(pieceIndex / 8);
  const bitIndex = pieceIndex % 8;
  const mask = 1 << bitIndex;
  return (bitfield[byteIndex] & mask) !== 0;
}

export function countBitfieldValues(bitfield: Uint8Array, pieceCount: number): number {
  let count = 0;
  for (let pieceIndex = 0; pieceIndex < pieceCount; pieceIndex += 1) {
    if (getBitfieldValue(bitfield, pieceIndex)) {
      count += 1;
    }
  }

  return count;
}

export function bitfieldToBase64(bitfield: Uint8Array): string {
  let binary = "";
  for (const byte of bitfield) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

export function base64ToBitfield(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bitfield = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bitfield[index] = binary.charCodeAt(index);
  }

  return bitfield;
}
