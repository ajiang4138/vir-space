import { ClientSignalMessage, JoinPayload, ServerSignalMessage } from "../types";

interface SignalingHandlers {
  onOpen: () => void;
  onClose: () => void;
  onError: (message: string) => void;
  onMessage: (message: ServerSignalMessage) => void;
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
        this.handlers.onMessage(message);
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
}
