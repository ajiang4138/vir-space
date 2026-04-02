export type ConnectionStatus =
  | "disconnected"
  | "signaling connected"
  | "connecting to peer"
  | "peer connected";

export interface PeerSummary {
  senderId: string;
  displayName: string;
}

export interface JoinPayload {
  roomId: string;
  displayName: string;
}

export type ClientSignalMessage =
  | ({ type: "join" } & JoinPayload)
  | { type: "offer"; roomId: string; targetId: string; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; roomId: string; targetId: string; sdp: RTCSessionDescriptionInit }
  | { type: "ice-candidate"; roomId: string; targetId: string; candidate: RTCIceCandidateInit };

export type ServerSignalMessage =
  | {
      type: "joined";
      roomId: string;
      senderId: string;
      existingPeers: PeerSummary[];
    }
  | {
      type: "peer-joined";
      roomId: string;
      senderId: string;
      displayName: string;
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
      senderId: string;
    }
  | {
      type: "error";
      roomId?: string;
      message: string;
    };

export interface ChatMessage {
  id: string;
  author: string;
  text: string;
  sentAt: string;
  own: boolean;
}
