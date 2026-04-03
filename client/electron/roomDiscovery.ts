import { randomUUID } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import type {
  RoomDiscoveryAnnouncement,
  RoomDiscoveryAnnouncementInput,
  RoomDiscoveryAnnouncementStatusInfo,
  RoomDiscoveryListenerStatusInfo,
} from "../src/shared/signaling.js";

const DISCOVERY_ANNOUNCEMENT_TYPE = "vir-space-room-announce";
const DISCOVERY_PROTOCOL_VERSION = 1;
const BROADCAST_ADDRESS = "255.255.255.255";
const MAX_DATAGRAM_BYTES = 4096;
const MAX_ROOM_ID_LENGTH = 80;
const MAX_HOST_DISPLAY_NAME_LENGTH = 64;
const MAX_HOST_IP_LENGTH = 128;
const MAX_NONCE_LENGTH = 128;
const MAX_PARTICIPANTS_LIMIT = 64;

export const DEFAULT_ROOM_DISCOVERY_PORT = 49231;
export const DEFAULT_ROOM_DISCOVERY_TTL_SECONDS = 8;
export const DEFAULT_ROOM_DISCOVERY_INTERVAL_MS = 2000;

export interface StartRoomAnnouncementOptions {
  discoveryPort?: number;
  intervalMs?: number;
  announcement: RoomDiscoveryAnnouncementInput;
}

interface RoomDiscoveryServiceHandlers {
  onAnnouncement: (announcement: RoomDiscoveryAnnouncement, sender: RemoteInfo) => void;
  onError: (message: string) => void;
}

function isPositivePort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function clampTtlSeconds(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_ROOM_DISCOVERY_TTL_SECONDS;
  }

  return Math.max(3, Math.min(30, Math.floor(value)));
}

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength;
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isRoomDiscoveryAnnouncement(value: unknown): value is RoomDiscoveryAnnouncement {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RoomDiscoveryAnnouncement>;
  if (
    !isNonEmptyBoundedString(candidate.roomId, MAX_ROOM_ID_LENGTH)
    || !isNonEmptyBoundedString(candidate.hostDisplayName, MAX_HOST_DISPLAY_NAME_LENGTH)
    || !isNonEmptyBoundedString(candidate.hostIp, MAX_HOST_IP_LENGTH)
    || !isNonEmptyBoundedString(candidate.nonce, MAX_NONCE_LENGTH)
    || !isFiniteInteger(candidate.hostPort)
    || !isFiniteInteger(candidate.participantCount)
    || !isFiniteInteger(candidate.maxParticipants)
    || !isFiniteInteger(candidate.timestamp)
    || !isFiniteInteger(candidate.ttlSeconds)
  ) {
    return false;
  }

  if (
    !isPositivePort(candidate.hostPort)
    || candidate.maxParticipants < 1
    || candidate.maxParticipants > MAX_PARTICIPANTS_LIMIT
    || candidate.participantCount < 0
    || candidate.participantCount > candidate.maxParticipants
    || candidate.ttlSeconds < 3
    || candidate.ttlSeconds > 30
    || candidate.timestamp < 1
  ) {
    return false;
  }

  const expectedJoinable = candidate.participantCount < candidate.maxParticipants;
  if (candidate.isJoinable !== expectedJoinable) {
    return false;
  }

  return (
    candidate.type === DISCOVERY_ANNOUNCEMENT_TYPE
    && candidate.version === DISCOVERY_PROTOCOL_VERSION
    && typeof candidate.isJoinable === "boolean"
    && candidate.status === "open"
  );
}

export class RoomDiscoveryService {
  private readonly handlers: RoomDiscoveryServiceHandlers;
  private listenerSocket: Socket | null = null;
  private listenerPort: number | null = null;
  private announceSocket: Socket | null = null;
  private announceInterval: ReturnType<typeof setInterval> | null = null;
  private announcePayload: RoomDiscoveryAnnouncementInput | null = null;
  private announcePort: number | null = null;
  private announceIntervalMs: number | null = null;

  constructor(handlers: RoomDiscoveryServiceHandlers) {
    this.handlers = handlers;
  }

  async startListener(port = DEFAULT_ROOM_DISCOVERY_PORT): Promise<RoomDiscoveryListenerStatusInfo> {
    if (!isPositivePort(port)) {
      throw new Error("room discovery listener port must be a valid port");
    }

    if (this.listenerSocket && this.listenerPort === port) {
      return this.getListenerStatus();
    }

    await this.stopListener();

    const socket = createSocket("udp4");
    socket.on("error", (error) => {
      this.handlers.onError(`room discovery listener error: ${error.message}`);
    });

    socket.on("message", (raw, sender) => {
      if (raw.byteLength > MAX_DATAGRAM_BYTES) {
        return;
      }

      try {
        const decoded = JSON.parse(raw.toString("utf8")) as unknown;
        if (!isRoomDiscoveryAnnouncement(decoded)) {
          return;
        }

        this.handlers.onAnnouncement(decoded, sender);
      } catch {
        // Ignore malformed discovery packets.
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        socket.off("listening", onListening);
        reject(error);
      };

      const onListening = (): void => {
        socket.off("error", onError);
        resolve();
      };

      socket.once("error", onError);
      socket.once("listening", onListening);
      socket.bind(port, "0.0.0.0");
    });

    this.listenerSocket = socket;
    this.listenerPort = port;

    return this.getListenerStatus();
  }

  async stopListener(): Promise<void> {
    if (!this.listenerSocket) {
      this.listenerPort = null;
      return;
    }

    const socket = this.listenerSocket;
    this.listenerSocket = null;
    this.listenerPort = null;

    await new Promise<void>((resolve) => {
      socket.close(() => resolve());
    });
  }

  getListenerStatus(): RoomDiscoveryListenerStatusInfo {
    return {
      status: this.listenerSocket ? "listening" : "stopped",
      port: this.listenerPort,
    };
  }

  async startAnnouncement(options: StartRoomAnnouncementOptions): Promise<RoomDiscoveryAnnouncementStatusInfo> {
    const discoveryPort = options.discoveryPort ?? this.listenerPort ?? DEFAULT_ROOM_DISCOVERY_PORT;
    if (!isPositivePort(discoveryPort)) {
      throw new Error("room discovery announce port must be a valid port");
    }

    const requestedIntervalMs = options.intervalMs ?? DEFAULT_ROOM_DISCOVERY_INTERVAL_MS;
    const intervalMs = Math.max(500, Math.floor(requestedIntervalMs));

    const payload: RoomDiscoveryAnnouncementInput = {
      ...options.announcement,
      ttlSeconds: clampTtlSeconds(options.announcement.ttlSeconds),
    };

    if (!payload.roomId.trim()) {
      throw new Error("room discovery announce requires roomId");
    }

    if (payload.roomId.trim().length > MAX_ROOM_ID_LENGTH) {
      throw new Error(`room discovery announce roomId exceeds ${MAX_ROOM_ID_LENGTH} chars`);
    }

    if (!payload.hostDisplayName.trim()) {
      throw new Error("room discovery announce requires hostDisplayName");
    }

    if (payload.hostDisplayName.trim().length > MAX_HOST_DISPLAY_NAME_LENGTH) {
      throw new Error(`room discovery announce hostDisplayName exceeds ${MAX_HOST_DISPLAY_NAME_LENGTH} chars`);
    }

    if (!payload.hostIp.trim()) {
      throw new Error("room discovery announce requires hostIp");
    }

    if (payload.hostIp.trim().length > MAX_HOST_IP_LENGTH) {
      throw new Error(`room discovery announce hostIp exceeds ${MAX_HOST_IP_LENGTH} chars`);
    }

    if (!isPositivePort(payload.hostPort)) {
      throw new Error("room discovery announce requires valid hostPort");
    }

    if (typeof payload.isJoinable !== "boolean") {
      throw new Error("room discovery announce requires isJoinable");
    }

    if (!isFiniteInteger(payload.maxParticipants) || payload.maxParticipants < 1 || payload.maxParticipants > MAX_PARTICIPANTS_LIMIT) {
      throw new Error(`room discovery announce maxParticipants must be between 1 and ${MAX_PARTICIPANTS_LIMIT}`);
    }

    if (!isFiniteInteger(payload.participantCount) || payload.participantCount < 0 || payload.participantCount > payload.maxParticipants) {
      throw new Error("room discovery announce participantCount is out of range");
    }

    const expectedJoinable = payload.participantCount < payload.maxParticipants;
    if (payload.isJoinable !== expectedJoinable) {
      throw new Error("room discovery announce isJoinable does not match participant capacity");
    }

    await this.stopAnnouncement();

    const socket = createSocket("udp4");
    socket.on("error", (error) => {
      this.handlers.onError(`room discovery announce error: ${error.message}`);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        socket.off("listening", onListening);
        reject(error);
      };

      const onListening = (): void => {
        socket.off("error", onError);
        resolve();
      };

      socket.once("error", onError);
      socket.once("listening", onListening);
      socket.bind(0, "0.0.0.0");
    });

    socket.setBroadcast(true);

    this.announceSocket = socket;
    this.announcePayload = payload;
    this.announcePort = discoveryPort;
    this.announceIntervalMs = intervalMs;

    this.sendAnnouncement();
    this.announceInterval = setInterval(() => {
      this.sendAnnouncement();
    }, intervalMs);

    return this.getAnnouncementStatus();
  }

  async stopAnnouncement(): Promise<void> {
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }

    if (!this.announceSocket) {
      this.announcePayload = null;
      this.announcePort = null;
      this.announceIntervalMs = null;
      return;
    }

    const socket = this.announceSocket;
    this.announceSocket = null;
    this.announcePayload = null;
    this.announcePort = null;
    this.announceIntervalMs = null;

    await new Promise<void>((resolve) => {
      socket.close(() => resolve());
    });
  }

  getAnnouncementStatus(): RoomDiscoveryAnnouncementStatusInfo {
    return {
      status: this.announceSocket ? "announcing" : "stopped",
      discoveryPort: this.announcePort,
      intervalMs: this.announceIntervalMs,
      roomId: this.announcePayload?.roomId ?? null,
    };
  }

  async stop(): Promise<void> {
    await this.stopAnnouncement();
    await this.stopListener();
  }

  private sendAnnouncement(): void {
    if (!this.announceSocket || !this.announcePayload || !this.announcePort) {
      return;
    }

    const announcement: RoomDiscoveryAnnouncement = {
      type: DISCOVERY_ANNOUNCEMENT_TYPE,
      version: DISCOVERY_PROTOCOL_VERSION,
      roomId: this.announcePayload.roomId,
      hostDisplayName: this.announcePayload.hostDisplayName,
      hostIp: this.announcePayload.hostIp,
      hostPort: this.announcePayload.hostPort,
      participantCount: this.announcePayload.participantCount,
      maxParticipants: this.announcePayload.maxParticipants,
      isJoinable: this.announcePayload.isJoinable,
      status: this.announcePayload.status,
      timestamp: Date.now(),
      ttlSeconds: clampTtlSeconds(this.announcePayload.ttlSeconds),
      nonce: randomUUID(),
    };

    const encoded = Buffer.from(JSON.stringify(announcement), "utf8");
    if (encoded.byteLength > MAX_DATAGRAM_BYTES) {
      this.handlers.onError("room discovery announcement exceeded max datagram size");
      return;
    }

    this.announceSocket.send(encoded, this.announcePort, BROADCAST_ADDRESS, (error) => {
      if (error) {
        this.handlers.onError(`room discovery send error: ${error.message}`);
      }
    });
  }
}
