import {
    CHAT_CHANNEL_LABEL,
    FILE_CONTROL_CHANNEL_LABEL,
    FILE_DATA_CHANNEL_LABEL,
} from "./fileTransfer/protocol";

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
  onFileControlMessage: (text: string) => void;
  onFileDataMessage: (data: ArrayBuffer | Uint8Array) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onStatusChange?: (status: WebRtcStatus) => void;
  onNegotiationNeeded?: () => void;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function resolveIceServers(): RTCIceServer[] {
  const configuredStunUrls = parseCsv(import.meta.env.VITE_STUN_URLS);
  const stunUrls = configuredStunUrls.length > 0 ? configuredStunUrls : ["stun:stun.l.google.com:19302"];

  const iceServers: RTCIceServer[] = [{ urls: stunUrls }];

  const turnUrls = parseCsv(import.meta.env.VITE_TURN_URLS);
  if (turnUrls.length > 0) {
    const username = import.meta.env.VITE_TURN_USERNAME;
    const credential = import.meta.env.VITE_TURN_CREDENTIAL;

    const turnServer: RTCIceServer = {
      urls: turnUrls,
    };

    if (username && credential) {
      turnServer.username = username;
      turnServer.credential = credential;
    }

    iceServers.push(turnServer);
  }

  return iceServers;
}

export class WebRtcPeerManager {
  private pc: RTCPeerConnection | null = null;
  private chatChannel: RTCDataChannel | null = null;
  private fileControlChannel: RTCDataChannel | null = null;
  private fileDataChannel: RTCDataChannel | null = null;
  private openChannelLabels = new Set<string>();
  private pendingRemoteIceCandidates: RTCIceCandidateInit[] = [];

  constructor(private readonly handlers: WebRtcHandlers) {}

  ensurePeerConnection(): RTCPeerConnection {
    if (this.pc) {
      return this.pc;
    }

    const pc = new RTCPeerConnection({
      iceServers: resolveIceServers(),
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

    if (!this.chatChannel) {
      const channel = pc.createDataChannel(CHAT_CHANNEL_LABEL, {
        ordered: true,
      });
      this.bindDataChannel(channel);
    }

    if (!this.fileControlChannel) {
      const channel = pc.createDataChannel(FILE_CONTROL_CHANNEL_LABEL, {
        ordered: true,
      });
      this.bindDataChannel(channel);
    }

    if (!this.fileDataChannel) {
      const channel = pc.createDataChannel(FILE_DATA_CHANNEL_LABEL, {
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
    if (!this.chatChannel || this.chatChannel.readyState !== "open") {
      return false;
    }

    this.chatChannel.send(text);
    return true;
  }

  sendFileControlMessage(text: string): boolean {
    if (!this.fileControlChannel || this.fileControlChannel.readyState !== "open") {
      return false;
    }

    this.fileControlChannel.send(text);
    return true;
  }

  sendFileDataMessage(data: ArrayBuffer): boolean {
    if (!this.fileDataChannel || this.fileDataChannel.readyState !== "open") {
      return false;
    }

    if (this.fileDataChannel.bufferedAmount > 8 * 1024 * 1024) {
      return false;
    }

    this.fileDataChannel.send(data);
    return true;
  }

  isDataChannelOpen(): boolean {
    return this.openChannelLabels.size > 0;
  }

  isFileTransferReady(): boolean {
    return this.fileControlChannel?.readyState === "open" && this.fileDataChannel?.readyState === "open";
  }

  close(): void {
    for (const channel of [this.chatChannel, this.fileControlChannel, this.fileDataChannel]) {
      if (!channel) {
        continue;
      }

      channel.onopen = null;
      channel.onclose = null;
      channel.onmessage = null;
      channel.close();
    }

    this.chatChannel = null;
    this.fileControlChannel = null;
    this.fileDataChannel = null;
    this.openChannelLabels.clear();

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
    if (channel.label === CHAT_CHANNEL_LABEL) {
      this.chatChannel = channel;
    } else if (channel.label === FILE_CONTROL_CHANNEL_LABEL) {
      this.fileControlChannel = channel;
    } else if (channel.label === FILE_DATA_CHANNEL_LABEL) {
      this.fileDataChannel = channel;
      this.fileDataChannel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = 4 * 1024 * 1024;
    }

    channel.onopen = () => {
      const wasEmpty = this.openChannelLabels.size === 0;
      this.openChannelLabels.add(channel.label);
      if (wasEmpty) {
        this.handlers.onStatusChange?.("connected");
        this.handlers.onDataChannelOpen();
      }
    };

    channel.onclose = () => {
      this.openChannelLabels.delete(channel.label);
      if (this.openChannelLabels.size === 0) {
        this.handlers.onStatusChange?.("disconnected");
        this.handlers.onDataChannelClose();
      }
    };

    channel.onmessage = (event) => {
      if (channel.label === CHAT_CHANNEL_LABEL) {
        this.handlers.onDataMessage(String(event.data));
        return;
      }

      if (channel.label === FILE_CONTROL_CHANNEL_LABEL) {
        this.handlers.onFileControlMessage(String(event.data));
        return;
      }

      if (channel.label === FILE_DATA_CHANNEL_LABEL) {
        if (event.data instanceof ArrayBuffer) {
          this.handlers.onFileDataMessage(event.data);
        } else if (ArrayBuffer.isView(event.data)) {
          this.handlers.onFileDataMessage(
            new Uint8Array(event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength)),
          );
        }
      }
    };
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
