export type ParticipantRole = "host" | "guest";

export interface ParticipantSummary {
  peerId: string;
  displayName: string;
  role: ParticipantRole;
}

export interface RoomStatePayload {
  roomId: string;
  hostPeerId: string;
  hostDisplayName: string;
  guestPeerId: string | null;
  guestDisplayName: string | null;
  status: "open" | "closed";
  participants: ParticipantSummary[];
}

export interface RoomActionPayload {
  roomId: string;
  displayName: string;
  roomPassword: string;
}

export type RoomDiscoveryAnnouncementType = "vir-space-room-announce";

export interface RoomDiscoveryAnnouncement {
  type: RoomDiscoveryAnnouncementType;
  version: 1;
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
}

export interface RoomDiscoveryAnnouncementInput {
  roomId: string;
  hostDisplayName: string;
  hostIp: string;
  hostPort: number;
  participantCount: number;
  maxParticipants: number;
  isJoinable: boolean;
  status: "open";
  ttlSeconds?: number;
}

export interface RoomDiscoveryListenerStatusInfo {
  status: "stopped" | "listening";
  port: number | null;
}

export interface RoomDiscoveryAnnouncementStatusInfo {
  status: "stopped" | "announcing";
  discoveryPort: number | null;
  intervalMs: number | null;
  roomId: string | null;
}

export type ClientSignalMessage =
  | ({ type: "create-room" } & RoomActionPayload)
  | ({ type: "join-room" } & RoomActionPayload)
  | { type: "leave-room"; roomId: string }
  | { type: "end-room"; roomId: string }
  | { type: "chat-message"; roomId: string; text: string; senderDisplayName?: string }
  | { type: "offer"; roomId: string; targetPeerId: string; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; roomId: string; targetPeerId: string; sdp: RTCSessionDescriptionInit }
  | { type: "ice-candidate"; roomId: string; targetPeerId: string; candidate: RTCIceCandidateInit };

export type ServerSignalMessage =
  | {
      type: "room-created";
      roomId: string;
      senderPeerId: string;
      role: ParticipantRole;
      room: RoomStatePayload;
    }
  | {
      type: "room-joined";
      roomId: string;
      senderPeerId: string;
      role: ParticipantRole;
      room: RoomStatePayload;
    }
  | {
      type: "room-state";
      room: RoomStatePayload;
    }
  | {
      type: "participant-joined";
      roomId: string;
      participant: ParticipantSummary;
      room: RoomStatePayload;
    }
  | {
      type: "participant-left";
      roomId: string;
      peerId: string;
      room: RoomStatePayload;
    }
  | {
      type: "chat-message";
      roomId: string;
      senderPeerId: string;
      senderDisplayName: string;
      text: string;
    }
  | {
      type: "offer";
      roomId: string;
      senderPeerId: string;
      sdp: RTCSessionDescriptionInit;
    }
  | {
      type: "answer";
      roomId: string;
      senderPeerId: string;
      sdp: RTCSessionDescriptionInit;
    }
  | {
      type: "ice-candidate";
      roomId: string;
      senderPeerId: string;
      candidate: RTCIceCandidateInit;
    }
  | {
      type: "peer-left";
      roomId: string;
      peerId: string;
    }
  | {
      type: "room-closed";
      roomId: string;
      reason: "host-ended" | "host-disconnected";
      message: string;
    }
  | {
      type: "error";
      roomId?: string;
      code?: string;
      message: string;
    };

export type HostServiceStatus = "stopped" | "starting" | "running";

export interface LocalNetworkInfo {
  hostname: string;
  preferredAddress: string;
  addresses: string[];
}

export interface HostServiceInfo {
  status: HostServiceStatus;
  port: number | null;
  roomId: string | null;
  localNetworkInfo: LocalNetworkInfo | null;
  wsUrls: string[];
}