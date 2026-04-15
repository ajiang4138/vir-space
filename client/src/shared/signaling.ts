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

export type ClientSignalMessage =
  | ({ type: "create-room"; userHash: string; hostCandidateBootstrapUrl?: string } & RoomActionPayload)
  | ({ type: "join-room"; userHash: string; hostCandidateBootstrapUrl?: string } & RoomActionPayload)
  | { type: "leave-room"; roomId: string }
  | { type: "end-room"; roomId: string }
  | { type: "transfer-room-ownership"; roomId: string }
  | { type: "kick-user"; roomId: string; targetPeerId: string }
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
      type: "room-host-transferred";
      roomId: string;
      previousHostPeerId: string;
      previousHostDisplayName: string;
      newHostPeerId: string;
      newHostDisplayName: string;
      newHostBootstrapUrl: string | null;
      room: RoomStatePayload;
    }
  | {
      type: "user-kicked";
      roomId: string;
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

export type AppDataMessage =
  | {
      type: "chat-message";
      senderPeerId: string;
      senderDisplayName: string;
      text: string;
    }
  | {
      type: "whiteboard-update";
      senderPeerId: string;
      senderDisplayName: string;
      data: string;
    }
  | {
      type: "editor-update";
      senderPeerId: string;
      senderDisplayName: string;
      data: string;
    };
