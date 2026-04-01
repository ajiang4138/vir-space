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

  private static readonly DEFAULT_LOCAL_DISCOVERY_URLS = [
    'http://127.0.0.1:47831',
    'http://localhost:47831',
  ] as const;

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

  private getCandidateBaseUrls(): string[] {
    const candidates = new Set<string>();

    const configured = this.baseUrl?.trim();
    if (configured) {
      candidates.add(configured);
    }

    if (typeof window !== 'undefined') {
      const discovery = window.virSpace?.discovery;
      const runtimeUrl = discovery?.discoveryUrl?.trim();
      if (runtimeUrl) {
        candidates.add(runtimeUrl);
      }

      if (discovery?.discoveryPort) {
        candidates.add(`http://127.0.0.1:${discovery.discoveryPort}`);
        candidates.add(`http://localhost:${discovery.discoveryPort}`);
      }

      for (const fallback of RoomDiscoveryClient.DEFAULT_LOCAL_DISCOVERY_URLS) {
        candidates.add(fallback);
      }
    }

    return Array.from(candidates);
  }

  getServiceInfo(): DiscoveryServiceInfo {
    const discoveryUrl = this.getBaseUrl();
    return {
      discoveryUrl,
      available: Boolean(discoveryUrl && typeof fetch === 'function'),
    };
  }

  async listRooms(): Promise<DiscoveryRoomSummary[]> {
    if (typeof fetch !== 'function') {
      return [];
    }

    for (const baseUrl of this.getCandidateBaseUrls()) {
      try {
        const response = await fetch(`${baseUrl}/rooms`);
        if (!response.ok) {
          continue;
        }

        const rooms = (await response.json()) as DiscoveryRoomSummary[];
        if (rooms.length > 0) {
          return rooms;
        }
      } catch {
        // Try next candidate discovery endpoint.
      }
    }

    return [];
  }

  async getRoom(roomId: string): Promise<Room | null> {
    if (typeof fetch !== 'function') {
      return null;
    }

    for (const baseUrl of this.getCandidateBaseUrls()) {
      try {
        const response = await fetch(`${baseUrl}/rooms/${encodeURIComponent(roomId)}`);
        if (response.status === 404) {
          continue;
        }

        if (!response.ok) {
          continue;
        }

        const record = (await response.json()) as DiscoveryRoomRecord;
        return this.deserializeRoom(record.room);
      } catch {
        // Try next candidate discovery endpoint.
      }
    }

    return null;
  }

  async upsertRoom(room: Room): Promise<void> {
    if (typeof fetch !== 'function') {
      return;
    }

    const payload = JSON.stringify({ room: this.serializeRoom(room), updatedAt: new Date().toISOString() });

    await Promise.allSettled(
      this.getCandidateBaseUrls().map((baseUrl) =>
        fetch(`${baseUrl}/rooms`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: payload,
        }),
      ),
    );
  }

  async deleteRoom(roomId: string): Promise<void> {
    if (typeof fetch !== 'function') {
      return;
    }

    await Promise.allSettled(
      this.getCandidateBaseUrls().map((baseUrl) =>
        fetch(`${baseUrl}/rooms/${encodeURIComponent(roomId)}`, {
          method: 'DELETE',
        }),
      ),
    );
  }
}

let discoveryClient: RoomDiscoveryClient | null = null;

export function getRoomDiscoveryClient(): RoomDiscoveryClient {
  if (!discoveryClient) {
    discoveryClient = new RoomDiscoveryClient();
  }

  return discoveryClient;
}