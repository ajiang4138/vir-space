import type { FileManifest } from "../../shared/fileTransfer";

// Keep piece payloads comfortably below common RTCDataChannel per-message caps.
// Frame headers add overhead, so using 64 KiB avoids edge-case send failures.
export const DEFAULT_PIECE_SIZE = 64 * 1024;
export const DEFAULT_MAX_INFLIGHT_REQUESTS = 4;
export const DEFAULT_PIECE_REQUEST_TIMEOUT_MS = 12_000;
export const FILE_CONTROL_CHANNEL_LABEL = "file-transfer-control";
export const FILE_DATA_CHANNEL_LABEL = "file-transfer-data";
export const APP_DATA_CHANNEL_LABEL = "app-data";

export type FilePieceState = "pending" | "requested" | "received" | "verified" | "failed";

export type FileTransferControlMessage =
  | {
      type: "file-offer";
      transferId: string;
      senderPeerId: string;
      senderDisplayName: string;
      manifest: FileManifest;
    }
  | {
      type: "file-manifest";
      transferId: string;
      senderPeerId: string;
      manifest: FileManifest;
    }
  | {
      type: "file-download-request";
      requesterPeerId: string;
      targetSenderPeerId: string;
      roomId: string;
      fileId: string;
      infoHash?: string;
      swarmTransferId?: string;
      pieceShardModulo?: number;
      pieceShardRemainder?: number;
    }
  | {
      type: "file-offer-accepted";
      transferId: string;
      senderPeerId: string;
      receiverPeerId: string;
      roomId: string;
    }
  | {
      type: "file-offer-declined";
      transferId: string;
      senderPeerId: string;
      receiverPeerId: string;
      roomId: string;
      reason?: string;
    }
  | {
      type: "piece-availability";
      transferId: string;
      senderPeerId: string;
      roomId: string;
      availablePieces: string;
      pieceCount: number;
    }
  | {
      type: "piece-request";
      transferId: string;
      senderPeerId: string;
      receiverPeerId: string;
      roomId: string;
      pieceIndex: number;
    }
  | {
      type: "piece-reject";
      transferId: string;
      senderPeerId: string;
      receiverPeerId: string;
      roomId: string;
      pieceIndex: number;
      reason: string;
    }
  | {
      type: "choke";
      transferId: string;
      senderPeerId: string;
      receiverPeerId: string;
      roomId: string;
      reason?: string;
    }
  | {
      type: "unchoke";
      transferId: string;
      senderPeerId: string;
      receiverPeerId: string;
      roomId: string;
      reason?: string;
    }
  | {
      type: "transfer-progress";
      transferId: string;
      senderPeerId: string;
      roomId: string;
      transferredBytes: number;
      completedPieces: number;
      requestedPieces: number;
      inFlightPieces: number;
      speedBytesPerSecond: number;
    }
  | {
      type: "transfer-complete";
      transferId: string;
      senderPeerId: string;
      roomId: string;
      fileId: string;
    }
  | {
      type: "transfer-cancel";
      transferId: string;
      senderPeerId: string;
      roomId: string;
      reason: string;
    }
  | {
      type: "transfer-error";
      transferId: string;
      senderPeerId: string;
      roomId: string;
      message: string;
    };

export interface FileBinaryFrameHeader {
  type: "piece-data";
  transferId: string;
  fileId: string;
  pieceIndex: number;
  byteLength: number;
  pieceHash: string;
}

export interface DecodedFileBinaryFrame {
  header: FileBinaryFrameHeader;
  payload: Uint8Array;
}

export function encodeControlMessage(message: FileTransferControlMessage): string {
  return JSON.stringify(message);
}

export function tryParseControlMessage(raw: string): FileTransferControlMessage | null {
  try {
    const parsed = JSON.parse(raw) as FileTransferControlMessage;
    if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function encodeBinaryFrame(header: FileBinaryFrameHeader, payload: Uint8Array): ArrayBuffer {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const frame = new Uint8Array(4 + headerBytes.length + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, headerBytes.length, true);
  frame.set(headerBytes, 4);
  frame.set(payload, 4 + headerBytes.length);
  return frame.buffer;
}

export function decodeBinaryFrame(data: ArrayBuffer | Uint8Array): DecodedFileBinaryFrame {
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
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as FileBinaryFrameHeader;

  if (header.type !== "piece-data") {
    throw new Error("Unsupported binary frame type");
  }

  return { header, payload };
}

export function createBitfield(pieceCount: number): Uint8Array {
  return new Uint8Array(Math.ceil(pieceCount / 8));
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
