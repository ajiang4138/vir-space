import type { Room } from '../../models/types';

interface SerializedAuthConfig {
  method: NonNullable<Room['authConfig']>['method'];
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

export interface DiscoveryRoomSummary {
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

interface DiscoveryRoomRecord {
  room: SerializedRoom;
  updatedAt: string;
  discoveryUrl?: string;
}

interface DiscoveryServiceInfo {
  discoveryUrl: string | null;
  available: boolean;
}

export class RoomDiscoveryClient {
  private baseUrl: string | null = null;

  private serializeRoom(room: Room): SerializedRoom {
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

  private deserializeRoom(room: SerializedRoom): Room {
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

  setBaseUrl(baseUrl: string | null): void {
    this.baseUrl = baseUrl?.trim() || null;
  }

  getBaseUrl(): string | null {
    if (this.baseUrl) {
      return this.baseUrl;
    }

    if (typeof window !== 'undefined') {
      const discoveryUrl = window.virSpace?.discovery?.discoveryUrl;
      if (discoveryUrl) {
        return discoveryUrl;
      }
    }

    return null;
  }

  getServiceInfo(): DiscoveryServiceInfo {
    const discoveryUrl = this.getBaseUrl();
    return {
      discoveryUrl,
      available: Boolean(discoveryUrl && typeof fetch === 'function'),
    };
  }

  async listRooms(): Promise<DiscoveryRoomSummary[]> {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl || typeof fetch !== 'function') {
      return [];
    }

    try {
      const response = await fetch(`${baseUrl}/rooms`);
      if (!response.ok) {
        return [];
      }

      return (await response.json()) as DiscoveryRoomSummary[];
    } catch {
      return [];
    }
  }

  async getRoom(roomId: string): Promise<Room | null> {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl || typeof fetch !== 'function') {
      return null;
    }

    try {
      const response = await fetch(`${baseUrl}/rooms/${encodeURIComponent(roomId)}`);
      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        return null;
      }

      const record = (await response.json()) as DiscoveryRoomRecord;
      return this.deserializeRoom(record.room);
    } catch {
      return null;
    }
  }

  async upsertRoom(room: Room): Promise<void> {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl || typeof fetch !== 'function') {
      return;
    }

    try {
      await fetch(`${baseUrl}/rooms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ room: this.serializeRoom(room), updatedAt: new Date().toISOString() }),
      });
    } catch {
      // Discovery sync is best-effort.
    }
  }

  async deleteRoom(roomId: string): Promise<void> {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl || typeof fetch !== 'function') {
      return;
    }

    try {
      await fetch(`${baseUrl}/rooms/${encodeURIComponent(roomId)}`, {
        method: 'DELETE',
      });
    } catch {
      // Discovery sync is best-effort.
    }
  }
}

let discoveryClient: RoomDiscoveryClient | null = null;

export function getRoomDiscoveryClient(): RoomDiscoveryClient {
  if (!discoveryClient) {
    discoveryClient = new RoomDiscoveryClient();
  }

  return discoveryClient;
}