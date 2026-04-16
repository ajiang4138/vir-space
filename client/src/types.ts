export type {
    ClientSignalMessage,
    HostServiceInfo,
    HostServiceStatus,
    LocalNetworkInfo,
  RelayDiscoveryPhase,
  RelayDiscoveryStatus,
    ParticipantRole,
    ParticipantSummary,
    RelayRoomListing,
    RelayRoomListingInput,
    RelayRoomStatus,
    RoomActionPayload,
    RoomStatePayload,
    ServerSignalMessage
} from "./shared/signaling";

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

export interface DiscoveredRoomSummary {
  roomId: string;
  hostDisplayName: string;
  hostIp: string;
  hostPort: number;
  participantCount: number;
  maxParticipants: number;
  isJoinable: boolean;
  status: "open" | "closed";
  updatedAt: number;
}
