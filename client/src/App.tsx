import { useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { DebugLog } from "./components/DebugLog";
import { JoinForm } from "./components/JoinForm";
import { ParticipantList } from "./components/ParticipantList";
import { RoomInfo } from "./components/RoomInfo";
import { SignalingClient } from "./lib/signalingClient";
import { WebRtcPeerManager } from "./lib/webrtc";
import type {
    ChatMessage,
    ConnectionStatus,
    HostServiceInfo,
    ParticipantRole,
    ParticipantSummary,
    RoomStatePayload,
} from "./types";

const defaultCreatePort = 8787;
const defaultJoinHostAddress = "127.0.0.1";
const minimumRoomPasswordLength = 4;

type RoomIntent = "create" | "join";
type SetupStep = "user-id" | "mode" | "create" | "join";

interface RoomEndpoint {
  address: string;
  port: number;
  shareUrls: string[];
}

interface ActiveRoom {
  roomId: string;
  myPeerId: string;
  myDisplayName: string;
  myRole: ParticipantRole;
  hostDisplayName: string;
  participants: ParticipantSummary[];
  endpoint: RoomEndpoint;
}

interface PendingAction {
  intent: RoomIntent;
  roomId: string;
  displayName: string;
  roomPassword: string;
}

function nowLabel(): string {
  return new Date().toLocaleTimeString();
}

function formatEndpoint(endpoint: RoomEndpoint | null): string {
  if (!endpoint) {
    return "-";
  }

  return `ws://${endpoint.address}:${endpoint.port}`;
}

function buildFallbackEndpoint(address: string, port: number): RoomEndpoint {
  return {
    address,
    port,
    shareUrls: [`ws://${address}:${port}`],
  };
}

function buildActiveRoom(
  roomState: RoomStatePayload,
  myPeerId: string,
  myRole: ParticipantRole,
  myDisplayName: string,
  endpoint: RoomEndpoint | null,
): ActiveRoom {
  return {
    roomId: roomState.roomId,
    myPeerId,
    myDisplayName,
    myRole,
    hostDisplayName: roomState.hostDisplayName,
    participants: roomState.participants,
    endpoint: endpoint ?? buildFallbackEndpoint(defaultJoinHostAddress, defaultCreatePort),
  };
}

export default function App(): JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [sessionBanner, setSessionBanner] = useState<string>("Disconnected");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [activeRoom, setActiveRoom] = useState<ActiveRoom | null>(null);
  const [setupStep, setSetupStep] = useState<SetupStep>("user-id");
  const [userIdDraft, setUserIdDraft] = useState("");
  const [currentUserId, setCurrentUserId] = useState("");

  const activeRoomRef = useRef<ActiveRoom | null>(null);
  const currentUserIdRef = useRef("");
  const connectionTargetRef = useRef<RoomEndpoint | null>(null);
  const negotiationStartedRef = useRef(false);
  const pendingActionRef = useRef<PendingAction | null>(null);
  const recentRoomClosureRef = useRef<"host-ended" | "host-disconnected" | null>(null);

  const signalingRef = useRef<SignalingClient | null>(null);
  const webrtcRef = useRef<WebRtcPeerManager | null>(null);

  const addEvent = (text: string): void => {
    setEvents((prev) => [`[${nowLabel()}] ${text}`, ...prev].slice(0, 150));
  };

  const updateActiveRoom = (nextRoom: ActiveRoom | null): void => {
    activeRoomRef.current = nextRoom;
    setActiveRoom(nextRoom);
  };

  const setSessionState = (nextStatus: ConnectionStatus, banner: string = nextStatus): void => {
    setStatus(nextStatus);
    setSessionBanner(banner);
  };

  const cleanupPeerConnection = (): void => {
    webrtcRef.current?.resetForNextPeer();
    negotiationStartedRef.current = false;
  };

  const clearRoomState = (nextStatus: ConnectionStatus, banner: string): void => {
    cleanupPeerConnection();
    updateActiveRoom(null);
    connectionTargetRef.current = null;
    pendingActionRef.current = null;
    setSessionState(nextStatus, banner);
    setSetupStep(currentUserIdRef.current ? "mode" : "user-id");
  };

  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  }, [currentUserId]);

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
    const nextRoom = buildActiveRoom(roomState, myPeerId, myRole, myDisplayName, connectionTargetRef.current);
    updateActiveRoom(nextRoom);

    if (roomState.status === "closed") {
      setSessionState("room closed");
      return;
    }

    const remote = nextRoom.participants.find((participant) => participant.peerId !== myPeerId);
    if (!remote) {
      setSessionState(myRole === "host" ? "waiting for guest" : "connecting to host");
      return;
    }

    setSessionState(myRole === "guest" ? "connecting to host" : "connecting to peer");
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
    setSessionState(room.myRole === "guest" ? "connecting to host" : "connecting to peer");

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
        addEvent("data channel open");
      },
      onDataChannelClose: () => {
        const room = activeRoomRef.current;
        if (!room) {
          setSessionState("signaling connected");
          return;
        }

        const remote = getRemoteParticipant();
        if (!remote && room.myRole === "host") {
          setSessionState("waiting for guest");
        } else {
          setSessionState(room.myRole === "guest" ? "connecting to host" : "connecting to peer");
        }

        addEvent("peer disconnected");
      },
      onDataMessage: (text) => {
        const remoteName = getRemoteParticipant()?.displayName ?? "Peer";
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            author: remoteName,
            text,
            sentAt: nowLabel(),
            own: false,
          },
        ]);
      },
      onConnectionState: (state) => {
        if (state === "failed" || state === "disconnected" || state === "closed") {
          const room = activeRoomRef.current;
          if (room) {
            setSessionState(room.myRole === "guest" ? "connecting to host" : "connecting to peer");
          } else {
            setSessionState("signaling connected");
          }

          addEvent("peer disconnected");
        }
      },
      onStatusChange: (nextStatus) => {
        if (nextStatus === "connected") {
          setSessionState("peer connected");
          return;
        }

        if (nextStatus === "connecting") {
          const room = activeRoomRef.current;
          setSessionState(room?.myRole === "guest" ? "connecting to host" : "connecting to peer");
          return;
        }

        if (nextStatus === "disconnected" || nextStatus === "failed" || nextStatus === "closed") {
          const room = activeRoomRef.current;
          if (room) {
            setSessionState(room.myRole === "guest" ? "connecting to host" : "connecting to peer");
          } else {
            setSessionState("signaling connected");
          }
        }
      },
    });

    signalingRef.current = new SignalingClient({
      onOpen: () => {
        setSessionState("signaling connected");
        addEvent("connected to host ws endpoint");

        const pending = pendingActionRef.current;
        if (pending) {
          if (pending.intent === "create") {
            signalingRef.current?.createRoom({
              roomId: pending.roomId,
              displayName: pending.displayName,
              roomPassword: pending.roomPassword,
            });
          } else {
            signalingRef.current?.joinRoom({
              roomId: pending.roomId,
              displayName: pending.displayName,
              roomPassword: pending.roomPassword,
            });
          }
        }
      },
      onClose: () => {
        const recentClosure = recentRoomClosureRef.current;
        recentRoomClosureRef.current = null;

        if (recentClosure) {
          addEvent("signaling disconnected");
          return;
        }

        addEvent("signaling disconnected");

        const room = activeRoomRef.current;
        const pending = pendingActionRef.current;

        if (room) {
          clearRoomState(
            room.myRole === "guest" ? "host disconnected, session ended" : "host service stopped",
            room.myRole === "guest" ? "host disconnected, session ended" : "host service stopped",
          );
          return;
        }

        if (pending?.intent === "create") {
          void window.electronApi.stopHostService();
          pendingActionRef.current = null;
          connectionTargetRef.current = null;
          setSessionState("host service stopped");
          return;
        }

        setSessionState("signaling disconnected");
      },
      onError: (message) => {
        addEvent(`error: ${message}`);
      },
      onRoomCreated: async (message) => {
        const pending = pendingActionRef.current;
        pendingActionRef.current = null;
        if (!pending) {
          return;
        }

        const hostInfo = await window.electronApi.getHostServiceStatus();
        const endpoint = hostInfo.localNetworkInfo
          ? {
              address: hostInfo.localNetworkInfo.preferredAddress,
              port: hostInfo.port ?? defaultCreatePort,
              shareUrls: hostInfo.wsUrls,
            }
          : buildFallbackEndpoint(defaultJoinHostAddress, hostInfo.port ?? defaultCreatePort);

        connectionTargetRef.current = endpoint;
        applyRoomState(message.room, message.peerId, message.role, pending.displayName);
        setSessionState("waiting for guest");
        addEvent(`room created: ${message.roomId} (host)`);
      },
      onRoomJoined: async (message) => {
        const pending = pendingActionRef.current;
        pendingActionRef.current = null;
        if (!pending) {
          return;
        }

        applyRoomState(message.room, message.peerId, message.role, pending.displayName);
        setSessionState("guest joined");
        addEvent(`room joined: ${message.roomId} (guest)`);
        await tryStartNegotiation();
      },
      onRoomState: async (message) => {
        const room = activeRoomRef.current;
        if (!room) {
          return;
        }

        applyRoomState(message.room, room.myPeerId, room.myRole, room.myDisplayName);
        if (message.room.status === "closed") {
          recentRoomClosureRef.current = recentRoomClosureRef.current ?? "host-ended";
          clearRoomState(
            recentRoomClosureRef.current === "host-disconnected" ? "host disconnected, session ended" : "room closed",
            recentRoomClosureRef.current === "host-disconnected" ? "host disconnected, session ended" : "room closed",
          );
        } else {
          await tryStartNegotiation();
        }
      },
      onParticipantJoined: async (message) => {
        const room = activeRoomRef.current;
        if (!room) {
          return;
        }

        applyRoomState(message.room, room.myPeerId, room.myRole, room.myDisplayName);
        setSessionState("guest joined");
        addEvent(`participant joined: ${message.participant.displayName} (${message.participant.role})`);
        await tryStartNegotiation();
      },
      onParticipantLeft: async (message) => {
        const room = activeRoomRef.current;
        if (!room) {
          return;
        }

        cleanupPeerConnection();
        applyRoomState(message.room, room.myPeerId, room.myRole, room.myDisplayName);
        if (room.myRole === "host") {
          setSessionState("guest left");
        } else {
          setSessionState("connecting to host");
        }

        addEvent(`participant left: ${message.peerId}`);
      },
      onOffer: async (message) => {
        addEvent("received offer");
        const room = activeRoomRef.current;
        if (!room) {
          return;
        }

        setSessionState(room.myRole === "guest" ? "connecting to host" : "connecting to peer");
        negotiationStartedRef.current = true;

        try {
          const answer = await webrtcRef.current?.handleRemoteOffer(message.sdp);
          if (answer) {
            signalingRef.current?.sendAnswer(message.roomId, message.senderId, answer);
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
        addEvent("received ICE candidate");
        try {
          await webrtcRef.current?.addIceCandidate(message.candidate);
        } catch {
          addEvent("error: failed to add ICE candidate");
        }
      },
      onPeerLeft: () => {
        addEvent("peer disconnected");
        cleanupPeerConnection();

        const room = activeRoomRef.current;
        if (!room) {
          return;
        }

        if (room.myRole === "host") {
          setSessionState("guest left");
        } else {
          setSessionState("connecting to host");
        }
      },
      onRoomClosed: (message) => {
        recentRoomClosureRef.current = message.reason;
        addEvent(`room closed: ${message.reason}`);
        if (message.reason === "host-disconnected") {
          clearRoomState("host disconnected, session ended", "host disconnected, session ended");
        } else {
          clearRoomState("room closed", "room closed");
        }
      },
      onServerError: async (message) => {
        const mapped = message.code === "ROOM_CLOSED" ? "room closed" : message.message;
        addEvent(`error: ${message.message}`);
        setSessionState(mapped === "room closed" ? "room closed" : "signaling disconnected", mapped);

        if (!activeRoomRef.current && pendingActionRef.current?.intent === "create") {
          pendingActionRef.current = null;
          connectionTargetRef.current = null;
          await window.electronApi.stopHostService();
          setSessionState("host service stopped");
          signalingRef.current?.disconnect();
        }
      },
    });

    return () => {
      pendingActionRef.current = null;
      recentRoomClosureRef.current = null;
      signalingRef.current?.disconnect();
      webrtcRef.current?.close();
      void window.electronApi.stopHostService();
    };
  }, []);

  const statusClass = useMemo(() => status.toLowerCase().replace(/[^a-z0-9]+/g, "-"), [status]);

  const startRoomFlow = async (
    intent: RoomIntent,
    payload:
      | { roomId: string; roomPassword: string; hostPort?: number }
      | { roomId: string; roomPassword: string; hostAddress: string; hostPort: number },
  ): Promise<void> => {
    const roomId = payload.roomId.trim();
    const roomPassword = payload.roomPassword.trim();
    const displayName = currentUserId.trim();

    if (!roomId || !roomPassword || !displayName) {
      addEvent("error: room ID, room password, and user ID are required");
      setSetupStep("user-id");
      return;
    }

    if (roomPassword.length < minimumRoomPasswordLength) {
      addEvent(`error: room password must be at least ${minimumRoomPasswordLength} characters`);
      setSessionState("disconnected", `password must be at least ${minimumRoomPasswordLength} characters`);
      return;
    }

    setMessages([]);
    updateActiveRoom(null);
    cleanupPeerConnection();
    recentRoomClosureRef.current = null;
    pendingActionRef.current = { intent, roomId, displayName, roomPassword };
    setSessionState(intent === "create" ? "host service starting" : "connecting to host");

    try {
      if (intent === "create") {
        const requestedPort = typeof payload.hostPort === "number" ? payload.hostPort : defaultCreatePort;
        const hostInfo: HostServiceInfo = await window.electronApi.startHostService(requestedPort);
        const port = hostInfo.port ?? requestedPort;
        const preferredAddress = hostInfo.localNetworkInfo?.preferredAddress ?? defaultJoinHostAddress;

        connectionTargetRef.current = {
          address: preferredAddress,
          port,
          shareUrls: hostInfo.wsUrls.length > 0 ? hostInfo.wsUrls : [`ws://${preferredAddress}:${port}`],
        };
        addEvent(`host service started on port ${port}`);
        setSessionState("host service started");

        signalingRef.current?.connect(`ws://127.0.0.1:${port}`);
        return;
      }

      const joinPayload = payload as { roomId: string; roomPassword: string; hostAddress: string; hostPort: number };
      const hostAddress = joinPayload.hostAddress.trim();
      connectionTargetRef.current = buildFallbackEndpoint(hostAddress, joinPayload.hostPort);
      addEvent(`joining ws://${hostAddress}:${joinPayload.hostPort}`);
      signalingRef.current?.connect(`ws://${hostAddress}:${joinPayload.hostPort}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start or connect to host service";
      addEvent(`error: ${message}`);
      pendingActionRef.current = null;
      connectionTargetRef.current = null;
      cleanupPeerConnection();
      setSessionState("disconnected", message);

      if (intent === "create") {
        void window.electronApi.stopHostService();
      }
    }
  };

  const createRoom = (payload: { roomId: string; roomPassword: string; hostPort?: number }): void => {
    void startRoomFlow("create", payload);
  };

  const joinRoom = (payload: { roomId: string; roomPassword: string; hostAddress: string; hostPort: number }): void => {
    void startRoomFlow("join", payload);
  };

  const submitUserId = (): void => {
    const normalized = userIdDraft.trim();
    if (!normalized) {
      addEvent("error: user ID is required");
      return;
    }

    setCurrentUserId(normalized);
    setUserIdDraft(normalized);
    setSetupStep("mode");
    addEvent(`ready as ${normalized}`);
  };

  const switchUser = (): void => {
    setSetupStep("user-id");
  };

  const leaveRoom = (): void => {
    const room = activeRoomRef.current;
    if (!room) {
      return;
    }

    if (room.myRole === "host") {
      signalingRef.current?.endRoom(room.roomId);
      addEvent("host requested room shutdown");
      return;
    }

    signalingRef.current?.leaveRoom(room.roomId);
    clearRoomState("signaling connected", "left room");
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
    const sent = webrtcRef.current?.sendChatMessage(text) ?? false;
    if (!sent) {
      addEvent("error: data channel is not open");
      return;
    }

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

  const roomEndpointLabel = formatEndpoint(activeRoom?.endpoint ?? null);
  const inRoom = Boolean(activeRoom);

  return (
    <main className="app-shell">
      {!inRoom ? (
        <section className="setup-page">
          <header className="app-header card">
            <h1>Vir Space - Join Setup</h1>
            <p>Sign in with a user ID, then choose whether to create or join a room.</p>
            <div className={`status ${statusClass}`}>Status: {status}</div>
          </header>

          <div className="setup-page-content">
            <div className="setup-primary">
              <JoinForm
                step={setupStep}
                userIdDraft={userIdDraft}
                currentUserId={currentUserId}
                roomActionDisabled={Boolean(activeRoom)}
                defaultCreateRoomId="room-1"
                defaultCreatePort={defaultCreatePort}
                defaultJoinHostAddress={defaultJoinHostAddress}
                defaultJoinHostPort={defaultCreatePort}
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
            <p>Connected room session for host and guest messaging over WebRTC.</p>
            <div className={`status ${statusClass}`}>Status: {status}</div>
          </header>

          <section className="chatroom-layout">
            <section className="top-panels">
              <RoomInfo
                roomId={activeRoom?.roomId ?? "-"}
                yourName={activeRoom?.myDisplayName ?? "-"}
                yourRole={activeRoom?.myRole ?? "guest"}
                hostDisplayName={activeRoom?.hostDisplayName ?? "-"}
                hostEndpointLabel={roomEndpointLabel}
                shareUrls={activeRoom?.myRole === "host" ? activeRoom.endpoint.shareUrls : []}
                inRoom={Boolean(activeRoom)}
                onLeaveRoom={leaveRoom}
                onEndRoom={endRoom}
              />
              <ParticipantList participants={activeRoom?.participants ?? []} currentPeerId={activeRoom?.myPeerId ?? ""} />
            </section>

            <ChatPanel
              messages={messages}
              canSend={status === "peer connected" && Boolean(webrtcRef.current?.isDataChannelOpen())}
              onSend={sendMessage}
            />
            <DebugLog events={events} />
          </section>
        </section>
      )}
    </main>
  );
}