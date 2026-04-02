import { ClientSignalMessage, JoinPayload, ServerSignalMessage } from "../types";

type JoinedMessage = Extract<ServerSignalMessage, { type: "joined" }>;
type PeerJoinedMessage = Extract<ServerSignalMessage, { type: "peer-joined" }>;
type OfferMessage = Extract<ServerSignalMessage, { type: "offer" }>;
type AnswerMessage = Extract<ServerSignalMessage, { type: "answer" }>;
type IceCandidateMessage = Extract<ServerSignalMessage, { type: "ice-candidate" }>;
type PeerLeftMessage = Extract<ServerSignalMessage, { type: "peer-left" }>;
type ErrorMessage = Extract<ServerSignalMessage, { type: "error" }>;

type MaybeAsyncHandler<T> = (message: T) => void | Promise<void>;

interface SignalingHandlers {
  onOpen: () => void;
  onClose: () => void;
  onError: (message: string) => void;
  onMessage?: MaybeAsyncHandler<ServerSignalMessage>;
  onJoined?: MaybeAsyncHandler<JoinedMessage>;
  onPeerJoined?: MaybeAsyncHandler<PeerJoinedMessage>;
  onOffer?: MaybeAsyncHandler<OfferMessage>;
  onAnswer?: MaybeAsyncHandler<AnswerMessage>;
  onIceCandidate?: MaybeAsyncHandler<IceCandidateMessage>;
  onPeerLeft?: MaybeAsyncHandler<PeerLeftMessage>;
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

  joinRoom(payload: JoinPayload): void {
    this.send({
      type: "join",
      roomId: payload.roomId,
      displayName: payload.displayName,
    });
  }

  sendOffer(roomId: string, targetId: string, sdp: RTCSessionDescriptionInit): void {
    this.send({ type: "offer", roomId, targetId, sdp });
  }

  sendAnswer(roomId: string, targetId: string, sdp: RTCSessionDescriptionInit): void {
    this.send({ type: "answer", roomId, targetId, sdp });
  }

  sendIceCandidate(roomId: string, targetId: string, candidate: RTCIceCandidateInit): void {
    this.send({ type: "ice-candidate", roomId, targetId, candidate });
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
      case "joined":
        if (this.handlers.onJoined) {
          void this.handlers.onJoined(message);
        }
        return;

      case "peer-joined":
        if (this.handlers.onPeerJoined) {
          void this.handlers.onPeerJoined(message);
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

      case "error":
        if (this.handlers.onServerError) {
          void this.handlers.onServerError(message);
        }
        return;
    }
  }
}
