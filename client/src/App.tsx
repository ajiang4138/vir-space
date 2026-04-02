import { useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { DebugLog } from "./components/DebugLog";
import { JoinForm } from "./components/JoinForm";
import { ParticipantList } from "./components/ParticipantList";
import { RoomInfo } from "./components/RoomInfo";
import { SignalingClient } from "./lib/signaling";
import { WebRtcPeerManager } from "./lib/webrtc";
import {
    ChatMessage,
    ConnectionStatus,
    ParticipantRole,
    ParticipantSummary,
    RoomStatePayload,
} from "./types";

const defaultSignalingUrl = "ws://localhost:8787";

type RoomIntent = "create" | "join";

interface ActiveRoom {
  roomId: string;
  myPeerId: string;
  myDisplayName: string;
  myRole: ParticipantRole;
  hostDisplayName: string;
  participants: ParticipantSummary[];
}

function nowLabel(): string {
  return new Date().toLocaleTimeString();
}

export default function App(): JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [sessionBanner, setSessionBanner] = useState<string>("Disconnected");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [activeRoom, setActiveRoom] = useState<ActiveRoom | null>(null);

  const activeRoomRef = useRef<ActiveRoom | null>(null);
  const negotiationStartedRef = useRef(false);
  const pendingActionRef = useRef<{
    intent: RoomIntent;
    roomId: string;
    displayName: string;
  } | null>(null);

  const addEvent = (text: string): void => {
    setEvents((prev) => [`[${nowLabel()}] ${text}`, ...prev].slice(0, 150));
  };

  const signalingRef = useRef<SignalingClient | null>(null);
  const webrtcRef = useRef<WebRtcPeerManager | null>(null);

  const updateActiveRoom = (nextRoom: ActiveRoom | null): void => {
    activeRoomRef.current = nextRoom;
    setActiveRoom(nextRoom);
  };

  const getRemoteParticipant = (): ParticipantSummary | null => {
    const room = activeRoomRef.current;
    if (!room) {
      return null;
    }

    return room.participants.find((participant) => participant.peerId !== room.myPeerId) ?? null;
  };

  const setStatusBanner = (nextStatus: ConnectionStatus): void => {
    setStatus(nextStatus);
    setSessionBanner(nextStatus);
  };

  const applyRoomState = (
    roomState: RoomStatePayload,
    myPeerId: string,
    myRole: ParticipantRole,
    myDisplayName: string,
  ): void => {
    const nextRoom: ActiveRoom = {
      roomId: roomState.roomId,
      myPeerId,
      myDisplayName,
      myRole,
      hostDisplayName: roomState.hostDisplayName,
      participants: roomState.participants,
    };

    updateActiveRoom(nextRoom);

    if (roomState.status === "closed") {
      setStatusBanner("room closed by host");
      return;
    }

    const remote = nextRoom.participants.find((participant) => participant.peerId !== myPeerId);
    if (!remote) {
      if (myRole === "host") {
        setStatusBanner("waiting for guest");
      } else {
        setStatusBanner("connecting to host");
      }
      return;
    }

    if (webrtcRef.current?.isDataChannelOpen()) {
      setStatusBanner("peer connected");
      return;
    }

    setStatusBanner(myRole === "guest" ? "connecting to host" : "connecting to peer");
  };

  const cleanupPeerConnection = (): void => {
    // Ensure stale channels/listeners are removed before a new peer session begins.
    webrtcRef.current?.resetForNextPeer();
    negotiationStartedRef.current = false;
  };

  const resetRoomState = (nextStatus: ConnectionStatus, banner: string): void => {
    // Called for leave, host-ended room shutdown, and host/signaling disconnect paths.
    cleanupPeerConnection();
    updateActiveRoom(null);
    setStatus(nextStatus);
    setSessionBanner(banner);
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
    setStatusBanner(room.myRole === "guest" ? "connecting to host" : "connecting to peer");

    try {
      const offer = await webrtcRef.current?.createOffer();
      if (offer && signalingRef.current) {
        signalingRef.current.sendOffer(room.roomId, remote.peerId, offer);
      }
    } catch {
      addEvent("error: failed to create/send offer");
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
        setStatusBanner("peer connected");
        addEvent("data channel open");
      },
      onDataChannelClose: () => {
        const room = activeRoomRef.current;
        if (!room) {
          setStatusBanner("signaling connected");
          return;
        }

        const remote = getRemoteParticipant();
        if (!remote && room.myRole === "host") {
          setStatusBanner("waiting for guest");
        } else {
          setStatusBanner(room.myRole === "guest" ? "connecting to host" : "connecting to peer");
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
            setStatusBanner(room.myRole === "guest" ? "connecting to host" : "connecting to peer");
          } else {
            setStatusBanner("signaling connected");
          }
          addEvent("peer disconnected");
        }
      },
      onStatusChange: (nextStatus) => {
        if (nextStatus === "connected") {
          setStatusBanner("peer connected");
          return;
        }

        if (nextStatus === "connecting") {
          const room = activeRoomRef.current;
          setStatusBanner(room?.myRole === "guest" ? "connecting to host" : "connecting to peer");
          return;
        }

        if (nextStatus === "disconnected" || nextStatus === "failed" || nextStatus === "closed") {
          const room = activeRoomRef.current;
          if (room) {
            setStatusBanner(room.myRole === "guest" ? "connecting to host" : "connecting to peer");
          } else {
            setStatusBanner("signaling connected");
          }
        }
      },
    });

    signalingRef.current = new SignalingClient({
      onOpen: () => {
        setStatusBanner("signaling connected");
        addEvent("connected to signaling server");

        const pending = pendingActionRef.current;
        if (pending) {
          if (pending.intent === "create") {
            signalingRef.current?.createRoom({
              roomId: pending.roomId,
              displayName: pending.displayName,
            });
          } else {
            signalingRef.current?.joinRoom({
              roomId: pending.roomId,
              displayName: pending.displayName,
            });
          }
        }
      },
      onClose: () => {
        addEvent("signaling disconnected");
        if (activeRoomRef.current) {
          resetRoomState("signaling disconnected", "signaling disconnected");
          return;
        }

        setStatusBanner("signaling disconnected");
      },
      onError: (message) => {
        addEvent(`error: ${message}`);
      },
      onRoomCreated: async (message) => {
        const pending = pendingActionRef.current;
        pendingActionRef.current = null;
        const displayName = pending?.displayName ?? message.room.hostDisplayName;
        applyRoomState(message.room, message.peerId, message.role, displayName);
        addEvent(`room created: ${message.roomId} (host)`);
      },
      onRoomJoined: async (message) => {
        const pending = pendingActionRef.current;
        pendingActionRef.current = null;
        const displayName = pending?.displayName ?? "Guest";
        applyRoomState(message.room, message.peerId, message.role, displayName);
        addEvent(`room joined: ${message.roomId} (guest)`);
        await tryStartNegotiation();
      },
      onRoomState: async (message) => {
        const room = activeRoomRef.current;
        if (!room) {
          return;
        }

        applyRoomState(message.room, room.myPeerId, room.myRole, room.myDisplayName);
        await tryStartNegotiation();
      },
      onParticipantJoined: async (message) => {
        const room = activeRoomRef.current;
        if (!room) {
          return;
        }

        applyRoomState(message.room, room.myPeerId, room.myRole, room.myDisplayName);
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
          setStatusBanner("guest left");
        }
        addEvent(`participant left: ${message.peerId}`);
      },
      onOffer: async (message) => {
        addEvent("received offer");
        const room = activeRoomRef.current;
        if (!room) {
          return;
        }

        setStatusBanner(room.myRole === "guest" ? "connecting to host" : "connecting to peer");
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
          setStatusBanner("guest left");
        } else {
          setStatusBanner("connecting to host");
        }
      },
      onRoomClosed: (message) => {
        addEvent(`room closed: ${message.reason}`);
        if (message.reason === "host-disconnected") {
          resetRoomState("host disconnected, session ended", "host disconnected, session ended");
          return;
        }

        resetRoomState("room closed by host", "room closed by host");
      },
      onServerError: (message) => {
        const mapped = message.code === "ROOM_CLOSED" ? "room closed by host" : message.message;
        setSessionBanner(mapped);
        addEvent(`error: ${message.message}`);
      },
    });

    return () => {
      pendingActionRef.current = null;
      signalingRef.current?.disconnect();
      webrtcRef.current?.close();
    };
  }, []);

  const statusClass = useMemo(() => status.toLowerCase().replace(/[^a-z0-9]+/g, "-"), [status]);

  const startRoomFlow = (
    intent: RoomIntent,
    payload: { signalingUrl: string; roomId: string; displayName: string },
  ): void => {
    if (!payload.signalingUrl || !payload.roomId || !payload.displayName) {
      addEvent("error: signaling URL, room ID, and display name are required");
      return;
    }

    pendingActionRef.current = {
      intent,
      roomId: payload.roomId,
      displayName: payload.displayName,
    };

    setMessages([]);
    updateActiveRoom(null);
    cleanupPeerConnection();
    setStatusBanner("disconnected");
    setSessionBanner(intent === "create" ? "creating room" : "joining room");

    signalingRef.current?.connect(payload.signalingUrl);
  };

  const createRoom = (payload: { signalingUrl: string; roomId: string; displayName: string }): void => {
    startRoomFlow("create", payload);
  };

  const joinRoom = (payload: { signalingUrl: string; roomId: string; displayName: string }): void => {
    startRoomFlow("join", payload);
  };

  const leaveRoom = (): void => {
    const room = activeRoomRef.current;
    if (!room) {
      return;
    }

    if (room.myRole === "host") {
      // Host leaving must terminate the room for all guests.
      signalingRef.current?.endRoom(room.roomId);
      addEvent("host left room (requested room shutdown)");
      return;
    }

    signalingRef.current?.leaveRoom(room.roomId);
    resetRoomState("signaling connected", "left room");
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

  return (
    <main className="app-shell">
      <header className="app-header card">
        <h1>Vir Space - Milestone 2</h1>
        <p>Host/guest room lifecycle + presence + WebRTC chat</p>
        <div className={`status ${statusClass}`}>Status: {status}</div>
        <p className="session-banner">Session: {sessionBanner}</p>
      </header>

      <section className="layout">
        <JoinForm
          defaultSignalingUrl={defaultSignalingUrl}
          roomActionDisabled={Boolean(activeRoom)}
          onCreateRoom={createRoom}
          onJoinRoom={joinRoom}
        />

        <div className="right-col">
          <section className="top-panels">
            <RoomInfo
              roomId={activeRoom?.roomId ?? "-"}
              yourName={activeRoom?.myDisplayName ?? "-"}
              yourRole={activeRoom?.myRole ?? "guest"}
              hostDisplayName={activeRoom?.hostDisplayName ?? "-"}
              inRoom={Boolean(activeRoom)}
              onLeaveRoom={leaveRoom}
              onEndRoom={endRoom}
            />
            <ParticipantList
              participants={activeRoom?.participants ?? []}
              currentPeerId={activeRoom?.myPeerId ?? ""}
            />
          </section>

          <ChatPanel
            messages={messages}
            canSend={status === "peer connected" && Boolean(webrtcRef.current?.isDataChannelOpen())}
            onSend={sendMessage}
          />
          <DebugLog events={events} />
        </div>
      </section>
    </main>
  );
}
