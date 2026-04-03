export type {
    ClientSignalMessage,
    HostServiceInfo,
    HostServiceStatus,
    LocalNetworkInfo,
    ParticipantRole,
    ParticipantSummary,
    RoomActionPayload,
    RoomStatePayload,
    ServerSignalMessage
} from "./shared/signaling";

export type ConnectionStatus =
  | "disconnected"
  | "host service starting"
  | "host service started"
  | "host service stopped"
  | "signaling disconnected"
  | "signaling connected"
  | "waiting for guest"
  | "guest joined"
  | "connecting to host"
  | "connecting to peer"
  | "peer connected"
  | "guest left"
  | "room closed"
  | "host disconnected"
  | "host disconnected, session ended";

export interface ChatMessage {
  id: string;
  author: string;
  text: string;
  sentAt: string;
  own: boolean;
}
