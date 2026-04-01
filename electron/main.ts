import { app, BrowserWindow } from 'electron';
import { existsSync } from 'fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Room } from '../src/models/types';

type AuthenticationMethod = 'password' | 'invite-token';

interface SerializedAuthConfig {
  method: AuthenticationMethod;
  passwordHash?: string;
  inviteTokens?: Array<[
    string,
    { createdAt: string; expiresAt?: string; usedAt?: string; usedByPeerId?: string },
  ]>;
  requireAuthForJoin: boolean;
  maxAttempts?: number;
  lockoutDurationMs?: number;
}

interface SerializedRoom extends Omit<Room, 'authConfig'> {
  authConfig?: SerializedAuthConfig;
}

interface DiscoveryRoomRecord {
  room: SerializedRoom;
  updatedAt: string;
  discoveryUrl?: string;
}

interface DiscoveryRoomSummary {
  id: string;
  name: string;
  ownerPeerId: string;
  createdAt: string;
  isPrivate: boolean;
  authMethod: string | null;
  peerCount: number;
  discoveryUrl?: string;
  updatedAt: string;
}

const discoveryRooms = new Map<string, DiscoveryRoomRecord>();
const currentDir = path.dirname(fileURLToPath(import.meta.url));

function resolvePreloadPath(appPath: string): string {
  const candidates = [
    path.join(appPath, 'dist-electron', 'electron', 'preload.js'),
    path.join(currentDir, 'preload.js'),
  ];

  const resolved = candidates.find((candidate) => existsSync(candidate));
  return resolved ?? candidates[0];
}

function serializeRoom(room: Room): SerializedRoom {
  return {
    ...room,
    authConfig: room.authConfig
      ? {
          ...room.authConfig,
          inviteTokens: room.authConfig.inviteTokens ? Array.from(room.authConfig.inviteTokens.entries()) : undefined,
        }
      : undefined,
  };
}

function deserializeRoom(room: SerializedRoom): Room {
  return {
    ...room,
    authConfig: room.authConfig
      ? {
          ...room.authConfig,
          inviteTokens: room.authConfig.inviteTokens ? new Map(room.authConfig.inviteTokens) : undefined,
        }
      : undefined,
  };
}

function getLocalAddress(): string {
  const networkInterfaces = os.networkInterfaces();

  for (const interfaces of Object.values(networkInterfaces)) {
    if (!interfaces) {
      continue;
    }

    for (const networkInterface of interfaces) {
      if (networkInterface.family === 'IPv4' && !networkInterface.internal) {
        return networkInterface.address;
      }
    }
  }

  return '127.0.0.1';
}

function getDiscoveryPort(): number {
  const configuredPort = Number(process.env.VIR_SPACE_DISCOVERY_PORT);
  return Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 47831;
}

function getDiscoveryBaseUrl(): string {
  const configuredUrl = process.env.VIR_SPACE_DISCOVERY_URL;
  if (configuredUrl) {
    return configuredUrl;
  }

  return `http://${getLocalAddress()}:${getDiscoveryPort()}`;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.end(JSON.stringify(body));
}

function getRoomSummary(record: DiscoveryRoomRecord): DiscoveryRoomSummary {
  return {
    id: record.room.id,
    name: record.room.name,
    ownerPeerId: record.room.ownerPeerId,
    createdAt: record.room.createdAt,
    isPrivate: record.room.isPrivate,
    authMethod: record.room.authConfig?.method || null,
    peerCount: record.room.peers.length,
    discoveryUrl: record.discoveryUrl,
    updatedAt: record.updatedAt,
  };
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    request.on('error', reject);
  });
}

async function handleDiscoveryRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url || '/', 'http://localhost');

  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, {
      status: 'ok',
      discoveryUrl: getDiscoveryBaseUrl(),
      roomCount: discoveryRooms.size,
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/rooms') {
    sendJson(response, 200, Array.from(discoveryRooms.values()).map(getRoomSummary));
    return;
  }

  const roomMatch = url.pathname.match(/^\/rooms\/([^/]+)$/);
  if (roomMatch) {
    const roomId = decodeURIComponent(roomMatch[1]);

    if (request.method === 'GET') {
      const record = discoveryRooms.get(roomId);
      if (!record) {
        sendJson(response, 404, { error: 'ROOM_NOT_FOUND' });
        return;
      }

      sendJson(response, 200, record);
      return;
    }

    if (request.method === 'DELETE') {
      const removed = discoveryRooms.delete(roomId);
      sendJson(response, removed ? 200 : 404, { removed });
      return;
    }
  }

  if (request.method === 'POST' && url.pathname === '/rooms') {
    const bodyText = await readRequestBody(request);
    try {
      const payload = JSON.parse(bodyText) as DiscoveryRoomRecord;
      if (!payload?.room?.id) {
        sendJson(response, 400, { error: 'INVALID_ROOM_PAYLOAD' });
        return;
      }

      const updatedRecord: DiscoveryRoomRecord = {
        room: serializeRoom(deserializeRoom(payload.room)),
        updatedAt: payload.updatedAt || new Date().toISOString(),
        discoveryUrl: payload.discoveryUrl,
      };

      discoveryRooms.set(payload.room.id, updatedRecord);
      sendJson(response, 200, getRoomSummary(updatedRecord));
    } catch {
      sendJson(response, 400, { error: 'INVALID_JSON' });
    }
    return;
  }

  sendJson(response, 404, { error: 'NOT_FOUND' });
}

let discoveryServerStarted = false;

async function startDiscoveryServer(): Promise<void> {
  if (discoveryServerStarted) {
    return;
  }

  const port = getDiscoveryPort();
  const server = createServer((request, response) => {
    void handleDiscoveryRequest(request, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      console.log(`[Discovery] Registry listening on ${getDiscoveryBaseUrl()}`);
      resolve();
    });
  });

  discoveryServerStarted = true;
}

const createWindow = async (): Promise<void> => {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const appPath = app.getAppPath();
  const preloadPath = resolvePreloadPath(appPath);

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(appPath, 'dist', 'index.html'));
  }
};

app.whenReady().then(async () => {
  await startDiscoveryServer();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
