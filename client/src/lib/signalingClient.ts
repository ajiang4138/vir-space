import type { ClientSignalMessage, RoomActionPayload, ServerSignalMessage } from "../shared/signaling";

type RoomCreatedMessage = Extract<ServerSignalMessage, { type: "room-created" }>;
type RoomJoinedMessage = Extract<ServerSignalMessage, { type: "room-joined" }>;
type RoomStateMessage = Extract<ServerSignalMessage, { type: "room-state" }>;
type ParticipantJoinedMessage = Extract<ServerSignalMessage, { type: "participant-joined" }>;
type ParticipantLeftMessage = Extract<ServerSignalMessage, { type: "participant-left" }>;
type OfferMessage = Extract<ServerSignalMessage, { type: "offer" }>;
type AnswerMessage = Extract<ServerSignalMessage, { type: "answer" }>;
type IceCandidateMessage = Extract<ServerSignalMessage, { type: "ice-candidate" }>;
type PeerLeftMessage = Extract<ServerSignalMessage, { type: "peer-left" }>;
type RoomClosedMessage = Extract<ServerSignalMessage, { type: "room-closed" }>;
type ErrorMessage = Extract<ServerSignalMessage, { type: "error" }>;

type MaybeAsyncHandler<T> = (message: T) => void | Promise<void>;

interface SignalingHandlers {
  onOpen: () => void;
  onClose: () => void;
  onError: (message: string) => void;
  onMessage?: MaybeAsyncHandler<ServerSignalMessage>;
  onRoomCreated?: MaybeAsyncHandler<RoomCreatedMessage>;
  onRoomJoined?: MaybeAsyncHandler<RoomJoinedMessage>;
  onRoomState?: MaybeAsyncHandler<RoomStateMessage>;
  onParticipantJoined?: MaybeAsyncHandler<ParticipantJoinedMessage>;
  onParticipantLeft?: MaybeAsyncHandler<ParticipantLeftMessage>;
  onOffer?: MaybeAsyncHandler<OfferMessage>;
  onAnswer?: MaybeAsyncHandler<AnswerMessage>;
  onIceCandidate?: MaybeAsyncHandler<IceCandidateMessage>;
  onPeerLeft?: MaybeAsyncHandler<PeerLeftMessage>;
  onRoomClosed?: MaybeAsyncHandler<RoomClosedMessage>;
  onServerError?: MaybeAsyncHandler<ErrorMessage>;
}

export class SignalingClient {
  private socket: WebSocket | null = null;

  constructor(private readonly handlers: SignalingHandlers) {}

  connect(url: string): void {
    this.disconnect();

    this.socket = new WebSocket(url);
    this.socket.onopen = () => this.handlers.onOpen();
    this.socket.onclose = () => this.handlers.onClose();
    this.socket.onerror = () => this.handlers.onError("Signaling socket error");
    this.socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as ServerSignalMessage;
        this.dispatchMessage(message);
      } catch {
        this.handlers.onError("Failed to parse signaling message");
      }
    };
  }

  disconnect(): void {
    if (!this.socket) {
      return;
    }

    this.socket.onopen = null;
    this.socket.onclose = null;
    this.socket.onerror = null;
    this.socket.onmessage = null;
    this.socket.close();
    this.socket = null;
  }

  createRoom(payload: RoomActionPayload): void {
    this.send({
      type: "create-room",
      roomId: payload.roomId,
      displayName: payload.displayName,
      roomPassword: payload.roomPassword,
    });
  }

  joinRoom(payload: RoomActionPayload): void {
    this.send({
      type: "join-room",
      roomId: payload.roomId,
      displayName: payload.displayName,
      roomPassword: payload.roomPassword,
    });
  }

  leaveRoom(roomId: string): void {
    this.send({
      type: "leave-room",
      roomId,
    });
  }

  endRoom(roomId: string): void {
    this.send({
      type: "end-room",
      roomId,
    });
  }

  sendOffer(roomId: string, targetPeerId: string, sdp: RTCSessionDescriptionInit): void {
    this.send({ type: "offer", roomId, targetPeerId, sdp });
  }

  sendAnswer(roomId: string, targetPeerId: string, sdp: RTCSessionDescriptionInit): void {
    this.send({ type: "answer", roomId, targetPeerId, sdp });
  }

  sendIceCandidate(roomId: string, targetPeerId: string, candidate: RTCIceCandidateInit): void {
    this.send({ type: "ice-candidate", roomId, targetPeerId, candidate });
  }

  private send(message: ClientSignalMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.handlers.onError("Signaling socket is not connected");
      return;
    }

    this.socket.send(JSON.stringify(message));
  }

  private dispatchMessage(message: ServerSignalMessage): void {
    if (this.handlers.onMessage) {
      void this.handlers.onMessage(message);
    }

    switch (message.type) {
      case "room-created":
        if (this.handlers.onRoomCreated) {
          void this.handlers.onRoomCreated(message);
        }
        return;

      case "room-joined":
        if (this.handlers.onRoomJoined) {
          void this.handlers.onRoomJoined(message);
        }
        return;

      case "room-state":
        if (this.handlers.onRoomState) {
          void this.handlers.onRoomState(message);
        }
        return;

      case "participant-joined":
        if (this.handlers.onParticipantJoined) {
          void this.handlers.onParticipantJoined(message);
        }
        return;

      case "participant-left":
        if (this.handlers.onParticipantLeft) {
          void this.handlers.onParticipantLeft(message);
        }
        return;

      case "offer":
        if (this.handlers.onOffer) {
          void this.handlers.onOffer(message);
        }
        return;

      case "answer":
        if (this.handlers.onAnswer) {
          void this.handlers.onAnswer(message);
        }
        return;

      case "ice-candidate":
        if (this.handlers.onIceCandidate) {
          void this.handlers.onIceCandidate(message);
        }
        return;

      case "peer-left":
        if (this.handlers.onPeerLeft) {
          void this.handlers.onPeerLeft(message);
        }
        return;

      case "room-closed":
        if (this.handlers.onRoomClosed) {
          void this.handlers.onRoomClosed(message);
        }
        return;

      case "error":
        if (this.handlers.onServerError) {
          void this.handlers.onServerError(message);
        }
        return;
    }
  }
}