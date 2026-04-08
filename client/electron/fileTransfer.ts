import { app, dialog } from "electron";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { PickedFileInfo, ReceiverTransferHandle, TorrentManifest } from "../src/shared/fileTransfer.js";

function guessMimeType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();

  switch (extension) {
    case ".txt":
    case ".md":
    case ".log":
    case ".csv":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".html":
    case ".htm":
      return "text/html";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".pdf":
      return "application/pdf";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

function preserveOriginalExtension(savedPath: string, originalFileName: string): string {
  const originalExtension = path.extname(originalFileName);
  if (!originalExtension) {
    return savedPath;
  }

  if (path.extname(savedPath)) {
    return savedPath;
  }

  return `${savedPath}${originalExtension}`;
}

function createTorrentId(
  roomId: string,
  fileName: string,
  fileSize: number,
  pieceSize: number,
  fullFileHash: string,
  pieceHashes: string[],
  initialSeederPeerId: string,
): string {
  const hash = createHash("sha256");
  hash.update(roomId);
  hash.update("|");
  hash.update(fileName);
  hash.update("|");
  hash.update(String(fileSize));
  hash.update("|");
  hash.update(String(pieceSize));
  hash.update("|");
  hash.update(fullFileHash);
  hash.update("|");
  hash.update(pieceHashes.join(""));
  hash.update("|");
  hash.update(initialSeederPeerId);
  hash.update("|");
  hash.update("1");
  return hash.digest("hex");
}

function createTempDirectory(transferId: string): string {
  return path.join(app.getPath("temp"), "vir-space-transfers", transferId);
}

async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function hashFile(filePath: string, pieceSize: number): Promise<string> {
  const fileHandle = await fs.open(filePath, "r");
  const fullHash = createHash("sha256");

  try {
    const stat = await fileHandle.stat();
    const buffer = Buffer.alloc(pieceSize);

    for (let offset = 0; offset < stat.size; offset += pieceSize) {
      const bytesToRead = Math.min(pieceSize, stat.size - offset);
      const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offset);
      const piece = Buffer.from(buffer.subarray(0, bytesRead));
      fullHash.update(piece);
    }
  } finally {
    await fileHandle.close();
  }

  return fullHash.digest("hex");
}

async function hashFilePieces(filePath: string, pieceSize: number): Promise<string[]> {
  const fileHandle = await fs.open(filePath, "r");
  const pieceHashes: string[] = [];

  try {
    const stat = await fileHandle.stat();
    const buffer = Buffer.alloc(pieceSize);

    for (let offset = 0; offset < stat.size; offset += pieceSize) {
      const bytesToRead = Math.min(pieceSize, stat.size - offset);
      const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offset);
      const piece = Buffer.from(buffer.subarray(0, bytesRead));
      const pieceHash = createHash("sha256").update(piece).digest("hex");
      pieceHashes.push(pieceHash);
    }
  } finally {
    await fileHandle.close();
  }

  return pieceHashes;
}

export async function selectFileForSharing(): Promise<PickedFileInfo | null> {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  const stats = await fs.stat(filePath);
  const fileName = path.basename(filePath);

  return {
    filePath,
    fileName,
    mimeType: guessMimeType(fileName),
    fileSize: stats.size,
  };
}

export async function buildFileManifest(
  filePath: string,
  roomId: string,
  senderPeerId: string,
  pieceSize: number,
): Promise<TorrentManifest> {
  const stats = await fs.stat(filePath);
  const fileName = path.basename(filePath);
  const createdAt = Date.now();
  const pieceCount = stats.size === 0 ? 0 : Math.ceil(stats.size / pieceSize);
  const fullFileHash = await hashFile(filePath, pieceSize);
  const pieceHashes = await hashFilePieces(filePath, pieceSize);
  const torrentId = createTorrentId(roomId, fileName, stats.size, pieceSize, fullFileHash, pieceHashes, senderPeerId);

  return {
    torrentId,
    protocolVersion: 1,
    fileName,
    mimeType: guessMimeType(fileName),
    fileSize: stats.size,
    pieceSize,
    pieceCount,
    fullFileHash,
    pieceHashes,
    createdAt,
    roomId,
    initialSeederPeerId: senderPeerId,
  };
}

export async function readFilePiece(filePath: string, pieceIndex: number, pieceSize: number): Promise<Uint8Array> {
  const fileHandle = await fs.open(filePath, "r");

  try {
    const stats = await fileHandle.stat();
    const offset = pieceIndex * pieceSize;
    if (offset >= stats.size) {
      return new Uint8Array();
    }

    const bytesToRead = Math.min(pieceSize, stats.size - offset);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offset);
    return new Uint8Array(buffer.subarray(0, bytesRead));
  } finally {
    await fileHandle.close();
  }
}

interface ReceiverTransferRecord {
  handle: ReceiverTransferHandle;
  tempDirectory: string;
  receivedPieces: Set<number>;
}

const receiverTransfers = new Map<string, ReceiverTransferRecord>();

export async function createReceiverTransfer(manifest: TorrentManifest): Promise<ReceiverTransferHandle> {
  const transferId = manifest.torrentId;
  const existing = receiverTransfers.get(transferId);
  if (existing) {
    return existing.handle;
  }

  const tempDirectory = createTempDirectory(transferId);
  await ensureDirectory(tempDirectory);

  const tempFilePath = path.join(tempDirectory, manifest.fileName);
  const fileHandle = await fs.open(tempFilePath, "w");
  try {
    await fileHandle.truncate(manifest.fileSize);
  } finally {
    await fileHandle.close();
  }

  const handle: ReceiverTransferHandle = {
    transferId,
    manifest,
    tempFilePath,
  };

  receiverTransfers.set(transferId, {
    handle,
    tempDirectory,
    receivedPieces: new Set<number>(),
  });

  return handle;
}

export async function writeReceiverPiece(transferId: string, pieceIndex: number, data: Uint8Array): Promise<void> {
  const record = receiverTransfers.get(transferId);
  if (!record) {
    throw new Error("Unknown receiver transfer");
  }

  if (record.receivedPieces.has(pieceIndex)) {
    return;
  }

  const { manifest, tempFilePath } = record.handle;
  const fileHandle = await fs.open(tempFilePath, "r+");
  try {
    const offset = pieceIndex * manifest.pieceSize;
    await fileHandle.write(Buffer.from(data), 0, data.byteLength, offset);
    record.receivedPieces.add(pieceIndex);
  } finally {
    await fileHandle.close();
  }
}

async function hashFileStream(filePath: string): Promise<string> {
  const stream = createReadStream(filePath);
  const hash = createHash("sha256");

  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }

  return hash.digest("hex");
}

export async function finalizeReceiverTransfer(transferId: string): Promise<{ savedPath: string; verifiedHash: string }> {
  const record = receiverTransfers.get(transferId);
  if (!record) {
    throw new Error("Unknown receiver transfer");
  }

  const { handle, tempDirectory } = record;
  const verifiedHash = await hashFileStream(handle.tempFilePath);
  if (verifiedHash !== handle.manifest.fullFileHash) {
    throw new Error("Full-file integrity mismatch");
  }

  const saveResult = await dialog.showSaveDialog({
    defaultPath: handle.manifest.fileName,
    filters: path.extname(handle.manifest.fileName)
      ? [
          {
            name: `${path.extname(handle.manifest.fileName).slice(1).toUpperCase()} files`,
            extensions: [path.extname(handle.manifest.fileName).slice(1)],
          },
        ]
      : undefined,
  });

  if (saveResult.canceled || !saveResult.filePath) {
    throw new Error("Save cancelled");
  }

  const finalPath = preserveOriginalExtension(saveResult.filePath, handle.manifest.fileName);

  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.copyFile(handle.tempFilePath, finalPath);
  await removeReceiverTransfer(transferId);

  return {
    savedPath: finalPath,
    verifiedHash,
  };
}

export async function removeReceiverTransfer(transferId: string): Promise<void> {
  const record = receiverTransfers.get(transferId);
  if (!record) {
    return;
  }

  receiverTransfers.delete(transferId);

  try {
    await fs.rm(record.tempDirectory, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
}
