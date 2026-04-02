interface WebRtcHandlers {
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
  onDataChannelOpen: () => void;
  onDataChannelClose: () => void;
  onDataMessage: (text: string) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
}

export class WebRtcPeerManager {
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;

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
      this.handlers.onConnectionState(pc.connectionState);
    };

    pc.ondatachannel = (event) => {
      this.bindDataChannel(event.channel);
    };

    this.pc = pc;
    return pc;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const pc = this.ensurePeerConnection();

    if (!this.dataChannel) {
      const channel = pc.createDataChannel("chat", { ordered: true });
      this.bindDataChannel(channel);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return offer;
  }

  async handleRemoteOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    const pc = this.ensurePeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(offer));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return answer;
  }

  async handleRemoteAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.ensurePeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    const pc = this.ensurePeerConnection();
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
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }

  private bindDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;

    channel.onopen = () => this.handlers.onDataChannelOpen();
    channel.onclose = () => this.handlers.onDataChannelClose();
    channel.onmessage = (event) => this.handlers.onDataMessage(String(event.data));
  }
}
