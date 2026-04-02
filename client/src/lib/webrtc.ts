export type WebRtcStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

interface WebRtcHandlers {
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
  onDataChannelOpen: () => void;
  onDataChannelClose: () => void;
  onDataMessage: (text: string) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onStatusChange?: (status: WebRtcStatus) => void;
  onNegotiationNeeded?: () => void;
}

export class WebRtcPeerManager {
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private pendingRemoteIceCandidates: RTCIceCandidateInit[] = [];

  constructor(private readonly handlers: WebRtcHandlers) {}

  ensurePeerConnection(): RTCPeerConnection {
    if (this.pc) {
      return this.pc;
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.handlers.onIceCandidate(event.candidate.toJSON());
      }
    };

    pc.onconnectionstatechange = () => {
      this.emitStatusFromConnectionState(pc.connectionState);
      this.handlers.onConnectionState(pc.connectionState);
    };

    pc.onnegotiationneeded = () => {
      if (this.handlers.onNegotiationNeeded) {
        this.handlers.onNegotiationNeeded();
      }
    };

    pc.ondatachannel = (event) => {
      this.bindDataChannel(event.channel);
    };

    this.pc = pc;
    return pc;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const pc = this.ensurePeerConnection();
    this.handlers.onStatusChange?.("connecting");

    if (!this.dataChannel) {
      const channel = pc.createDataChannel("chat", {
        ordered: true,
      });
      this.bindDataChannel(channel);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return offer;
  }

  async handleRemoteOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    const pc = this.ensurePeerConnection();
    this.handlers.onStatusChange?.("connecting");
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await this.flushPendingIceCandidates();

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return answer;
  }

  async handleRemoteAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.ensurePeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    await this.flushPendingIceCandidates();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    const pc = this.ensurePeerConnection();

    if (!pc.remoteDescription) {
      this.pendingRemoteIceCandidates.push(candidate);
      return;
    }

    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  sendChatMessage(text: string): boolean {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      return false;
    }

    this.dataChannel.send(text);
    return true;
  }

  isDataChannelOpen(): boolean {
    return this.dataChannel?.readyState === "open";
  }

  close(): void {
    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onclose = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.onnegotiationneeded = null;
      this.pc.ondatachannel = null;
      this.pc.close();
      this.pc = null;
    }

    this.pendingRemoteIceCandidates = [];
    this.handlers.onStatusChange?.("closed");
  }

  resetForNextPeer(): void {
    this.close();
    this.handlers.onStatusChange?.("idle");
  }

  private bindDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;

    channel.onopen = () => {
      this.handlers.onStatusChange?.("connected");
      this.handlers.onDataChannelOpen();
    };

    channel.onclose = () => {
      this.handlers.onStatusChange?.("disconnected");
      this.handlers.onDataChannelClose();
    };

    channel.onmessage = (event) => this.handlers.onDataMessage(String(event.data));
  }

  private async flushPendingIceCandidates(): Promise<void> {
    if (!this.pc || !this.pc.remoteDescription || this.pendingRemoteIceCandidates.length === 0) {
      return;
    }

    const pending = [...this.pendingRemoteIceCandidates];
    this.pendingRemoteIceCandidates = [];
    for (const candidate of pending) {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  private emitStatusFromConnectionState(state: RTCPeerConnectionState): void {
    if (state === "new") {
      this.handlers.onStatusChange?.("idle");
      return;
    }

    if (state === "connecting") {
      this.handlers.onStatusChange?.("connecting");
      return;
    }

    if (state === "connected") {
      this.handlers.onStatusChange?.("connected");
      return;
    }

    if (state === "disconnected") {
      this.handlers.onStatusChange?.("disconnected");
      return;
    }

    if (state === "failed") {
      this.handlers.onStatusChange?.("failed");
      return;
    }

    this.handlers.onStatusChange?.("closed");
  }
}
