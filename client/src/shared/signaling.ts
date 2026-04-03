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
  guestPeerId?: string;
  guestDisplayName?: string;
  status: "active" | "closed";
  participants: ParticipantSummary[];
}

export interface RoomActionPayload {
  roomId: string;
  displayName: string;
  roomPassword: string;
}

export type ClientSignalMessage =
  | ({ type: "create-room" } & RoomActionPayload)
  | ({ type: "join-room" } & RoomActionPayload)
  | { type: "leave-room"; roomId: string }
  | { type: "end-room"; roomId: string }
  | { type: "offer"; roomId: string; targetId: string; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; roomId: string; targetId: string; sdp: RTCSessionDescriptionInit }
  | { type: "ice-candidate"; roomId: string; targetId: string; candidate: RTCIceCandidateInit };

export type ServerSignalMessage =
  | {
      type: "room-created";
      roomId: string;
      peerId: string;
      role: ParticipantRole;
      room: RoomStatePayload;
    }
  | {
      type: "room-joined";
      roomId: string;
      peerId: string;
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
      type: "offer";
      roomId: string;
      senderId: string;
      sdp: RTCSessionDescriptionInit;
    }
  | {
      type: "answer";
      roomId: string;
      senderId: string;
      sdp: RTCSessionDescriptionInit;
    }
  | {
      type: "ice-candidate";
      roomId: string;
      senderId: string;
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