export type {
    ClientSignalMessage,
    HostServiceInfo,
    HostServiceStatus,
    LocalNetworkInfo,
    RoomDiscoveryAnnouncementInput,
    RoomDiscoveryAnnouncementStatusInfo,
    ParticipantRole,
    ParticipantSummary,
    RoomDiscoveryAnnouncement,
    RoomDiscoveryAnnouncementType,
    RoomDiscoveryListenerStatusInfo,
    RoomActionPayload,
    RoomStatePayload,
    ServerSignalMessage
} from "./shared/signaling";

export type DiscoveryListenerStatus = "stopped" | "listening" | "error";

export interface DiscoveredRoomSummary {
  roomId: string;
  hostDisplayName: string;
  hostIp: string;
  hostPort: number;
  participantCount: number;
  maxParticipants: number;
  isJoinable: boolean;
  status: "open";
  timestamp: number;
  ttlSeconds: number;
  nonce: string;
  lastSeenAt: number;
  expiresAt: number;
}

export type ConnectionStatus =
  | "idle"
  | "connecting to bootstrap server"
  | "connected to bootstrap server"
  | "room created"
  | "waiting for guest"
  | "joining room"
  | "room joined"
  | "peer connecting"
  | "peer connected"
  | "guest left"
  | "room closed by host"
  | "host disconnected"
  | "signaling disconnected"
  | "invalid room password"
  | "room full"
  | "room not found";

export interface ChatMessage {
  id: string;
  author: string;
  text: string;
  sentAt: string;
  own: boolean;
}
