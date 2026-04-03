import { app, dialog } from "electron";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { FileManifest, PickedFileInfo, ReceiverTransferHandle } from "../src/shared/fileTransfer.js";

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

function createFileId(filePath: string, fileSize: number, createdAt: number): string {
  const hash = createHash("sha256");
  hash.update(filePath);
  hash.update(String(fileSize));
  hash.update(String(createdAt));
  return hash.digest("hex").slice(0, 24);
}

function createTempDirectory(transferId: string): string {
  return path.join(app.getPath("temp"), "vir-space-transfers", transferId);
}

async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function hashFileByPieces(filePath: string, pieceSize: number): Promise<{ fullFileHash: string; pieceHashes: string[] }> {
  const fileHandle = await fs.open(filePath, "r");
  const pieceHashes: string[] = [];
  const fullHash = createHash("sha256");

  try {
    const stat = await fileHandle.stat();
    const buffer = Buffer.alloc(pieceSize);

    for (let offset = 0; offset < stat.size; offset += pieceSize) {
      const bytesToRead = Math.min(pieceSize, stat.size - offset);
      const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offset);
      const piece = Buffer.from(buffer.subarray(0, bytesRead));
      pieceHashes.push(createHash("sha256").update(piece).digest("hex"));
      fullHash.update(piece);
    }
  } finally {
    await fileHandle.close();
  }

  return {
    fullFileHash: fullHash.digest("hex"),
    pieceHashes,
  };
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
): Promise<FileManifest> {
  const stats = await fs.stat(filePath);
  const fileName = path.basename(filePath);
  const createdAt = Date.now();
  const fileId = createFileId(filePath, stats.size, createdAt);
  const pieceCount = stats.size === 0 ? 0 : Math.ceil(stats.size / pieceSize);
  const hashes = await hashFileByPieces(filePath, pieceSize);

  return {
    fileId,
    fileName,
    mimeType: guessMimeType(fileName),
    fileSize: stats.size,
    pieceSize,
    pieceCount,
    fullFileHash: hashes.fullFileHash,
    pieceHashes: hashes.pieceHashes,
    createdAt,
    senderPeerId,
    roomId,
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

export async function createReceiverTransfer(manifest: FileManifest): Promise<ReceiverTransferHandle> {
  const transferId = manifest.fileId;
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

async function hashFile(filePath: string): Promise<string> {
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
  const verifiedHash = await hashFile(handle.tempFilePath);
  if (verifiedHash !== handle.manifest.fullFileHash) {
    throw new Error("Full-file integrity mismatch");
  }

  const saveResult = await dialog.showSaveDialog({
    defaultPath: handle.manifest.fileName,
  });

  if (saveResult.canceled || !saveResult.filePath) {
    throw new Error("Save cancelled");
  }

  await fs.mkdir(path.dirname(saveResult.filePath), { recursive: true });
  await fs.copyFile(handle.tempFilePath, saveResult.filePath);
  await removeReceiverTransfer(transferId);

  return {
    savedPath: saveResult.filePath,
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
