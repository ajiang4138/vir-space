import { useEffect, useRef, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { DebugLog } from "./components/DebugLog";
import { JoinForm } from "./components/JoinForm";
import { ParticipantList } from "./components/ParticipantList";
import { RoomInfo } from "./components/RoomInfo";
import { SignalingClient } from "./lib/signalingClient";
import { WebRtcPeerManager, type WebRtcStatus } from "./lib/webrtc";
import type {
    ChatMessage,
    ConnectionStatus,
    ParticipantRole,
    ParticipantSummary,
    RoomStatePayload,
} from "./types";

type RoomIntent = "create" | "join";
type SetupStep = "user-id" | "mode" | "create" | "join";
type SignalingConnectionState = "disconnected" | "connecting" | "connected";

interface ActiveRoom {
  roomId: string;
  myPeerId: string;
  myDisplayName: string;
  myRole: ParticipantRole;
  roomStatus: RoomStatePayload["status"];
  hostDisplayName: string;
  participants: ParticipantSummary[];
}

interface PendingAction {
  intent: RoomIntent;
  roomId: string;
  bootstrapUrl: string;
  displayName: string;
  roomPassword: string;
}

const defaultBootstrapUrl = import.meta.env.VITE_BOOTSTRAP_SIGNALING_URL ?? "ws://localhost:8787";
const defaultHostPort = 8787;
const minimumRoomPasswordLength = 4;

function nowLabel(): string {
  return new Date().toLocaleTimeString();
}

function parsePortFromWsUrl(url: string): number {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return defaultHostPort;
    }

    if (!parsed.port) {
      return defaultHostPort;
    }

    const port = Number.parseInt(parsed.port, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return defaultHostPort;
    }

    return port;
  } catch {
    return defaultHostPort;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isWsProtocol(protocol: string): boolean {
  return protocol === "ws:" || protocol === "wss:";
}

function buildActiveRoom(
  roomState: RoomStatePayload,
  myPeerId: string,
  myRole: ParticipantRole,
  myDisplayName: string,
): ActiveRoom {
  return {
    roomId: roomState.roomId,
    myPeerId,
    myDisplayName,
    myRole,
    roomStatus: roomState.status,
    hostDisplayName: roomState.hostDisplayName,
    participants: roomState.participants,
  };
}

export default function App(): JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [activeRoom, setActiveRoom] = useState<ActiveRoom | null>(null);
  const [setupStep, setSetupStep] = useState<SetupStep>("user-id");
  const [userIdDraft, setUserIdDraft] = useState("");
  const [currentUserId, setCurrentUserId] = useState("");
  const [bootstrapUrl, setBootstrapUrl] = useState(defaultBootstrapUrl);
  const [signalingState, setSignalingState] = useState<SignalingConnectionState>("disconnected");
  const [webRtcStatus, setWebRtcStatus] = useState<WebRtcStatus>("idle");

  const activeRoomRef = useRef<ActiveRoom | null>(null);
  const currentUserIdRef = useRef("");
  const pendingActionRef = useRef<PendingAction | null>(null);
  const bootstrapUrlRef = useRef(defaultBootstrapUrl);
  const negotiationStartedRef = useRef(false);

  const signalingRef = useRef<SignalingClient | null>(null);
  const webrtcRef = useRef<WebRtcPeerManager | null>(null);

  const addEvent = (text: string): void => {
    setEvents((prev) => [`[${nowLabel()}] ${text}`, ...prev].slice(0, 150));
  };

  const updateActiveRoom = (nextRoom: ActiveRoom | null): void => {
    activeRoomRef.current = nextRoom;
    setActiveRoom(nextRoom);
  };

  const setSessionState = (nextStatus: ConnectionStatus): void => {
    setStatus(nextStatus);
  };

  const cleanupPeerConnection = (): void => {
    webrtcRef.current?.resetForNextPeer();
    negotiationStartedRef.current = false;
  };

  const clearRoomState = (nextStatus: ConnectionStatus): void => {
    cleanupPeerConnection();
    updateActiveRoom(null);
    setMessages([]);
    setSessionState(nextStatus);
    setSetupStep(currentUserIdRef.current ? "mode" : "user-id");
  };

  const stopLocalHostService = async (): Promise<void> => {
    try {
      await window.electronApi.stopHostService();
    } catch {
      addEvent("error: failed to stop local host signaling service");
    }
  };

  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  }, [currentUserId]);

  useEffect(() => {
    let cancelled = false;

    const primeBootstrapUrl = async (): Promise<void> => {
      try {
        const networkInfo = await window.electronApi.getLocalNetworkInfo();
        if (cancelled) {
          return;
        }

        const preferredAddress = networkInfo.preferredAddress;
        if (preferredAddress && !isLoopbackHost(preferredAddress)) {
          setBootstrapUrl(`ws://${preferredAddress}:${defaultHostPort}`);
        }
      } catch {
        // Leave the current field value and rely on explicit prompt later.
      }
    };

    void primeBootstrapUrl();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    bootstrapUrlRef.current = bootstrapUrl;
  }, [bootstrapUrl]);

  const getRemoteParticipant = (): ParticipantSummary | null => {
    const room = activeRoomRef.current;
    if (!room) {
      return null;
    }

    return room.participants.find((participant) => participant.peerId !== room.myPeerId) ?? null;
  };

  const applyRoomState = (
    roomState: RoomStatePayload,
    myPeerId: string,
    myRole: ParticipantRole,
    myDisplayName: string,
  ): void => {
    const nextRoom = buildActiveRoom(roomState, myPeerId, myRole, myDisplayName);
    updateActiveRoom(nextRoom);

    if (roomState.status === "closed") {
      setSessionState(myRole === "guest" ? "host disconnected" : "room closed by host");
      return;
    }

    const remote = nextRoom.participants.find((participant) => participant.peerId !== myPeerId);
    if (!remote) {
      setSessionState(myRole === "host" ? "waiting for guest" : "peer connecting");
      return;
    }

    if (webrtcRef.current?.isDataChannelOpen()) {
      setSessionState("peer connected");
      return;
    }

    setSessionState("peer connecting");
  };

  const tryStartNegotiation = async (): Promise<void> => {
    const room = activeRoomRef.current;
    const remote = getRemoteParticipant();

    if (!room || !remote || negotiationStartedRef.current) {
      return;
    }

    const isInitiator = room.myPeerId.localeCompare(remote.peerId) < 0;
    if (!isInitiator) {
      return;
    }

    negotiationStartedRef.current = true;
    setSessionState("peer connecting");

    try {
      const offer = await webrtcRef.current?.createOffer();
      if (offer && signalingRef.current) {
        signalingRef.current.sendOffer(room.roomId, remote.peerId, offer);
      }
    } catch {
      addEvent("error: failed to create/send offer");
      negotiationStartedRef.current = false;
    }
  };

  useEffect(() => {
    webrtcRef.current = new WebRtcPeerManager({
      onIceCandidate: (candidate) => {
        const room = activeRoomRef.current;
        const remote = getRemoteParticipant();
        if (!room || !remote || !signalingRef.current) {
          return;
        }

        signalingRef.current.sendIceCandidate(room.roomId, remote.peerId, candidate);
      },
      onDataChannelOpen: () => {
        setSessionState("peer connected");
        addEvent("peer connected via WebRTC data channel");
      },
      onDataChannelClose: () => {
        const room = activeRoomRef.current;
        if (!room) {
          return;
        }

        const remote = getRemoteParticipant();
        if (!remote && room.myRole === "host") {
          setSessionState("waiting for guest");
        } else {
          setSessionState("peer connecting");
        }

        addEvent("peer data channel closed");
      },
      onDataMessage: (text) => {
        // Chat delivery is room-fanned via signaling to reach all participants.
        addEvent(`received direct data-channel message: ${text}`);
      },
      onConnectionState: (state) => {
        if (state === "failed") {
          addEvent("peer connection failed");
          setSessionState("peer connecting");
        }
      },
      onStatusChange: (nextStatus) => {
        setWebRtcStatus(nextStatus);
      },
    });

    signalingRef.current = new SignalingClient({
      onOpen: () => {
        setSignalingState("connected");
        setSessionState("connected to bootstrap server");
        addEvent("connected to bootstrap signaling server");

        const pending = pendingActionRef.current;
        if (!pending) {
          return;
        }

        if (pending.intent === "create") {
          signalingRef.current?.createRoom({
            roomId: pending.roomId,
            displayName: pending.displayName,
            roomPassword: pending.roomPassword,
          });
          return;
        }

        setSessionState("joining room");
        signalingRef.current?.joinRoom({
          roomId: pending.roomId,
          displayName: pending.displayName,
          roomPassword: pending.roomPassword,
        });
      },
      onClose: () => {
        setSignalingState("disconnected");
        addEvent("signaling disconnected");

        const room = activeRoomRef.current;
        pendingActionRef.current = null;

        if (room?.myRole === "guest") {
          clearRoomState("host disconnected");
          return;
        }

        if (room?.myRole === "host") {
          void stopLocalHostService();
          clearRoomState("signaling disconnected");
          return;
        }

        setSessionState("signaling disconnected");
      },
      onError: (message) => {
        addEvent(`error: ${message}`);
      },
      onRoomCreated: (message) => {
        const pending = pendingActionRef.current;
        pendingActionRef.current = null;
        if (!pending) {
          return;
        }

        applyRoomState(message.room, message.senderPeerId, message.role, pending.displayName);
        setSessionState("room created");
        addEvent(`room created: ${message.roomId}`);
        setTimeout(() => {
          if (activeRoomRef.current?.myRole === "host") {
            setSessionState("waiting for guest");
          }
        }, 0);
      },
      onRoomJoined: async (message) => {
        const pending = pendingActionRef.current;
        pendingActionRef.current = null;
        if (!pending) {
          return;
        }

        applyRoomState(message.room, message.senderPeerId, message.role, pending.displayName);
        setSessionState("room joined");
        addEvent(`room joined: ${message.roomId}`);
        await tryStartNegotiation();
      },
      onRoomState: async (message) => {
        const room = activeRoomRef.current;
        if (!room) {
          return;
        }

        applyRoomState(message.room, room.myPeerId, room.myRole, room.myDisplayName);

        if (message.room.status === "closed") {
          clearRoomState(room.myRole === "guest" ? "host disconnected" : "room closed by host");
          return;
        }

        await tryStartNegotiation();
      },
      onParticipantJoined: async (message) => {
        const room = activeRoomRef.current;
        if (!room) {
          return;
        }

        applyRoomState(message.room, room.myPeerId, room.myRole, room.myDisplayName);
        if (webrtcRef.current?.isDataChannelOpen()) {
          setSessionState("peer connected");
        } else {
          setSessionState("peer connecting");
        }
        addEvent(`participant joined: ${message.participant.displayName}`);
        await tryStartNegotiation();
      },
      onParticipantLeft: (message) => {
        const room = activeRoomRef.current;
        if (!room) {
          return;
        }

        cleanupPeerConnection();
        applyRoomState(message.room, room.myPeerId, room.myRole, room.myDisplayName);

        if (room.myRole === "host") {
          setSessionState("guest left");
          addEvent("guest left the room");
          return;
        }

        setSessionState("peer connecting");
      },
      onChatMessage: (message) => {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            author: message.senderDisplayName || "Peer",
            text: message.text,
            sentAt: nowLabel(),
            own: false,
          },
        ]);
      },
      onOffer: async (message) => {
        addEvent("received offer");
        negotiationStartedRef.current = true;

        try {
          const answer = await webrtcRef.current?.handleRemoteOffer(message.sdp);
          if (answer) {
            signalingRef.current?.sendAnswer(message.roomId, message.senderPeerId, answer);
          }
        } catch {
          addEvent("error: failed to handle offer");
        }
      },
      onAnswer: async (message) => {
        addEvent("received answer");
        try {
          await webrtcRef.current?.handleRemoteAnswer(message.sdp);
        } catch {
          addEvent("error: failed to handle answer");
        }
      },
      onIceCandidate: async (message) => {
        try {
          await webrtcRef.current?.addIceCandidate(message.candidate);
        } catch {
          addEvent("error: failed to add ICE candidate");
        }
      },
      onPeerLeft: () => {
        cleanupPeerConnection();
      },
      onRoomClosed: (message) => {
        addEvent(`room closed: ${message.reason}`);
        if (message.reason === "host-ended") {
          void stopLocalHostService();
        }
        clearRoomState(message.reason === "host-disconnected" ? "host disconnected" : "room closed by host");
      },
      onServerError: (message) => {
        addEvent(`error: ${message.message}`);

        if (message.code === "ROOM_FULL") {
          setSessionState("room full");
        } else if (message.code === "ROOM_NOT_FOUND") {
          setSessionState("room not found");
        } else if (message.code === "ROOM_CLOSED") {
          setSessionState("room closed by host");
        } else if (message.code === "ROOM_PASSWORD_INVALID" || message.code === "ROOM_PASSWORD_TOO_SHORT") {
          setSessionState("invalid room password");
        } else {
          setSessionState("signaling disconnected");
        }

        pendingActionRef.current = null;
      },
    });

    return () => {
      pendingActionRef.current = null;
      signalingRef.current?.disconnect();
      webrtcRef.current?.close();
      void stopLocalHostService();
    };
  }, []);

  const startRoomFlow = async (
    intent: RoomIntent,
    payload: { roomId: string; bootstrapUrl: string; roomPassword: string },
  ): Promise<void> => {
    const roomId = payload.roomId.trim();
    const requestedBootstrapUrl = payload.bootstrapUrl.trim();
    const roomPassword = payload.roomPassword.trim();
    const displayName = currentUserId.trim();

    if (!roomId || !displayName || !requestedBootstrapUrl || !roomPassword) {
      addEvent("error: bootstrap URL, room ID, display name, and room password are required");
      return;
    }

    if (roomPassword.length < minimumRoomPasswordLength) {
      addEvent(`error: room password must be at least ${minimumRoomPasswordLength} characters`);
      setSessionState("invalid room password");
      return;
    }

    let resolvedBootstrapUrl = requestedBootstrapUrl;
    try {
      const parsed = new URL(requestedBootstrapUrl);
      if (!isWsProtocol(parsed.protocol)) {
        addEvent("error: bootstrap URL must use ws:// or wss://");
        setSessionState("signaling disconnected");
        return;
      }

      if (isLoopbackHost(parsed.hostname) && intent === "create") {
        try {
          const networkInfo = await window.electronApi.getLocalNetworkInfo();
          const preferredAddress = networkInfo.preferredAddress;
          if (preferredAddress && !isLoopbackHost(preferredAddress)) {
            parsed.hostname = preferredAddress;
            resolvedBootstrapUrl = parsed.toString();
          }
        } catch {
          // Fallback to manual prompt below.
        }
      }
    } catch {
      addEvent("error: invalid bootstrap URL format");
      setSessionState("signaling disconnected");
      return;
    }

    try {
      const parsedResolved = new URL(resolvedBootstrapUrl);
      if (isLoopbackHost(parsedResolved.hostname)) {
        const enteredIp = window.prompt("Enter host LAN IP address (example: 192.168.1.42)", "");
        const cleanedIp = enteredIp?.trim() ?? "";
        if (!cleanedIp) {
          addEvent("error: host IP is required when localhost cannot be used");
          setSessionState("signaling disconnected");
          return;
        }

        parsedResolved.hostname = cleanedIp;
        resolvedBootstrapUrl = parsedResolved.toString();
      }
    } catch {
      addEvent("error: failed to resolve bootstrap URL");
      setSessionState("signaling disconnected");
      return;
    }

    setBootstrapUrl(resolvedBootstrapUrl);
    setMessages([]);
    cleanupPeerConnection();
    updateActiveRoom(null);
    pendingActionRef.current = { intent, roomId, bootstrapUrl: resolvedBootstrapUrl, displayName, roomPassword };
    setSignalingState("connecting");
    setSessionState("connecting to bootstrap server");

    if (intent === "create") {
      const requestedPort = parsePortFromWsUrl(resolvedBootstrapUrl);

      try {
        await window.electronApi.startHostService(requestedPort);
        addEvent(`local host signaling service listening on port ${requestedPort}`);
      } catch (error) {
        pendingActionRef.current = null;
        const message = error instanceof Error ? error.message : "failed to start local host signaling service";
        addEvent(`error: ${message}`);
        setSessionState("signaling disconnected");
        return;
      }
    }

    signalingRef.current?.connect(resolvedBootstrapUrl);
  };

  const createRoom = (payload: { roomId: string; bootstrapUrl: string; roomPassword: string }): void => {
    void startRoomFlow("create", payload);
  };

  const joinRoom = (payload: { roomId: string; bootstrapUrl: string; roomPassword: string }): void => {
    void startRoomFlow("join", payload);
  };

  const submitUserId = (): void => {
    const normalized = userIdDraft.trim();
    if (!normalized) {
      addEvent("error: display name is required");
      return;
    }

    setCurrentUserId(normalized);
    setUserIdDraft(normalized);
    setSetupStep("mode");
    setSessionState("idle");
    addEvent(`ready as ${normalized}`);
  };

  const switchUser = (): void => {
    setSetupStep("user-id");
  };

  const leaveRoom = (): void => {
    const room = activeRoomRef.current;
    if (!room || room.myRole !== "guest") {
      return;
    }

    signalingRef.current?.leaveRoom(room.roomId);
    clearRoomState("connected to bootstrap server");
    addEvent("left room");
  };

  const endRoom = (): void => {
    const room = activeRoomRef.current;
    if (!room || room.myRole !== "host") {
      return;
    }

    signalingRef.current?.endRoom(room.roomId);
    addEvent("host requested room shutdown");
  };

  const sendMessage = (text: string): void => {
    const room = activeRoomRef.current;
    if (!room) {
      addEvent("warning: not currently in a room");
      return;
    }

    signalingRef.current?.sendChatMessage(room.roomId, text, room.myDisplayName);

    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        author: activeRoomRef.current?.myDisplayName || "Me",
        text,
        sentAt: nowLabel(),
        own: true,
      },
    ]);
  };

  const inRoom = Boolean(activeRoom);

  return (
    <main className="app-shell">
      {!inRoom ? (
        <section className="setup-page">
          <header className="app-header card">
            <h1>Vir Space - Host-Owned Signaling</h1>
            <p>The room creator listens on a local signaling port; chat messages stay peer-to-peer over WebRTC.</p>
          </header>

          <div className="setup-page-content">
            <div className="setup-primary">
              <JoinForm
                step={setupStep}
                userIdDraft={userIdDraft}
                currentUserId={currentUserId}
                roomActionDisabled={Boolean(activeRoom)}
                defaultBootstrapUrl={bootstrapUrlRef.current}
                onUserIdDraftChange={setUserIdDraft}
                onSubmitUserId={submitUserId}
                onChooseCreate={() => setSetupStep("create")}
                onChooseJoin={() => setSetupStep("join")}
                onBackToMode={() => setSetupStep("mode")}
                onSwitchUser={switchUser}
                onCreateRoom={createRoom}
                onJoinRoom={joinRoom}
              />
            </div>
            <div className="setup-debug">
              <DebugLog events={events} />
            </div>
          </div>
        </section>
      ) : (
        <section className="chatroom-page">
          <header className="app-header card">
            <h1>Vir Space - Chatroom</h1>
            <p>Signaling uses the host client listener. Chat messages stay on RTCDataChannel.</p>
          </header>

          <section className="chatroom-layout">
            <section className="top-panels">
              <RoomInfo
                roomId={activeRoom?.roomId ?? "-"}
                yourName={activeRoom?.myDisplayName ?? "-"}
                yourRole={activeRoom?.myRole ?? "guest"}
                hostDisplayName={activeRoom?.hostDisplayName ?? "-"}
                bootstrapUrl={bootstrapUrl}
                signalingStatus={signalingState}
                webRtcStatus={webRtcStatus}
                roomStatus={activeRoom?.roomStatus ?? "closed"}
                inRoom={Boolean(activeRoom)}
                onLeaveRoom={leaveRoom}
                onEndRoom={endRoom}
              />
              <ParticipantList participants={activeRoom?.participants ?? []} currentPeerId={activeRoom?.myPeerId ?? ""} />
            </section>

            <ChatPanel
              messages={messages}
              onSend={sendMessage}
            />
            <DebugLog events={events} />
          </section>
        </section>
      )}
    </main>
  );
}
