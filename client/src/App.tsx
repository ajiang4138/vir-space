import { useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { DebugLog } from "./components/DebugLog";
import { JoinForm } from "./components/JoinForm";
import { SignalingClient } from "./lib/signaling";
import { WebRtcPeerManager } from "./lib/webrtc";
import { ChatMessage, ConnectionStatus, PeerSummary, ServerSignalMessage } from "./types";

const defaultSignalingUrl = "ws://localhost:8787";

function nowLabel(): string {
  return new Date().toLocaleTimeString();
}

export default function App(): JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [joined, setJoined] = useState(false);

  const roomIdRef = useRef<string>("");
  const localIdRef = useRef<string>("");
  const localNameRef = useRef<string>("");
  const remotePeerRef = useRef<PeerSummary | null>(null);
  const negotiationStartedRef = useRef(false);
  const pendingJoinRef = useRef<{ roomId: string; displayName: string } | null>(null);

  const addEvent = (text: string): void => {
    setEvents((prev) => [`[${nowLabel()}] ${text}`, ...prev].slice(0, 150));
  };

  const signalingRef = useRef<SignalingClient | null>(null);
  const webrtcRef = useRef<WebRtcPeerManager | null>(null);

  const tryStartNegotiation = async (): Promise<void> => {
    const localId = localIdRef.current;
    const roomId = roomIdRef.current;
    const remote = remotePeerRef.current;

    if (!localId || !roomId || !remote || negotiationStartedRef.current) {
      return;
    }

    const isInitiator = localId.localeCompare(remote.senderId) < 0;
    if (!isInitiator) {
      return;
    }

    negotiationStartedRef.current = true;
    setStatus("connecting to peer");

    try {
      const offer = await webrtcRef.current?.createOffer();
      if (offer && signalingRef.current) {
        signalingRef.current.sendOffer(roomId, remote.senderId, offer);
      }
    } catch {
      addEvent("error: failed to create/send offer");
    }
  };

  useEffect(() => {
    webrtcRef.current = new WebRtcPeerManager({
      onIceCandidate: (candidate) => {
        const roomId = roomIdRef.current;
        const remote = remotePeerRef.current;
        if (!roomId || !remote || !signalingRef.current) {
          return;
        }

        signalingRef.current.sendIceCandidate(roomId, remote.senderId, candidate);
      },
      onDataChannelOpen: () => {
        setStatus("peer connected");
        addEvent("data channel open");
      },
      onDataChannelClose: () => {
        setStatus("signaling connected");
        addEvent("peer disconnected");
      },
      onDataMessage: (text) => {
        const remoteName = remotePeerRef.current?.displayName ?? "Peer";
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
          setStatus("signaling connected");
          addEvent("peer disconnected");
        }
      },
    });

    signalingRef.current = new SignalingClient({
      onOpen: () => {
        setStatus("signaling connected");
        addEvent("connected to signaling server");

        const pending = pendingJoinRef.current;
        if (pending) {
          signalingRef.current?.joinRoom(pending);
        }
      },
      onClose: () => {
        setStatus("disconnected");
        setJoined(false);
        addEvent("signaling disconnected");
      },
      onError: (message) => {
        addEvent(`error: ${message}`);
      },
      onMessage: async (message: ServerSignalMessage) => {
        if (message.type === "joined") {
          roomIdRef.current = message.roomId;
          localIdRef.current = message.senderId;
          setJoined(true);
          setStatus("signaling connected");
          addEvent("joined room");

          if (message.existingPeers.length > 0) {
            remotePeerRef.current = message.existingPeers[0];
            setStatus("connecting to peer");
            await tryStartNegotiation();
          }
          return;
        }

        if (message.type === "peer-joined") {
          remotePeerRef.current = {
            senderId: message.senderId,
            displayName: message.displayName,
          };
          setStatus("connecting to peer");
          addEvent(`peer joined: ${message.displayName}`);
          await tryStartNegotiation();
          return;
        }

        if (message.type === "offer") {
          addEvent("received offer");
          remotePeerRef.current = {
            senderId: message.senderId,
            displayName: remotePeerRef.current?.displayName ?? "Peer",
          };
          setStatus("connecting to peer");
          negotiationStartedRef.current = true;
          try {
            const answer = await webrtcRef.current?.handleRemoteOffer(message.sdp);
            if (answer) {
              signalingRef.current?.sendAnswer(message.roomId, message.senderId, answer);
            }
          } catch {
            addEvent("error: failed to handle offer");
          }
          return;
        }

        if (message.type === "answer") {
          addEvent("received answer");
          try {
            await webrtcRef.current?.handleRemoteAnswer(message.sdp);
          } catch {
            addEvent("error: failed to handle answer");
          }
          return;
        }

        if (message.type === "ice-candidate") {
          addEvent("received ICE candidate");
          try {
            await webrtcRef.current?.addIceCandidate(message.candidate);
          } catch {
            addEvent("error: failed to add ICE candidate");
          }
          return;
        }

        if (message.type === "peer-left") {
          addEvent("peer disconnected");
          setStatus("signaling connected");
          remotePeerRef.current = null;
          negotiationStartedRef.current = false;
          webrtcRef.current?.close();
          return;
        }

        if (message.type === "error") {
          addEvent(`error: ${message.message}`);
        }
      },
    });

    return () => {
      signalingRef.current?.disconnect();
      webrtcRef.current?.close();
    };
  }, []);

  const statusClass = useMemo(() => status.replace(/\s+/g, "-"), [status]);

  const joinRoom = (payload: { signalingUrl: string; roomId: string; displayName: string }): void => {
    if (!payload.signalingUrl || !payload.roomId || !payload.displayName) {
      addEvent("error: signaling URL, room ID, and display name are required");
      return;
    }

    localNameRef.current = payload.displayName;
    roomIdRef.current = payload.roomId;
    remotePeerRef.current = null;
    negotiationStartedRef.current = false;
    setMessages([]);
    setJoined(false);
    setStatus("disconnected");

    pendingJoinRef.current = { roomId: payload.roomId, displayName: payload.displayName };
    signalingRef.current?.connect(payload.signalingUrl);
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
        author: localNameRef.current || "Me",
        text,
        sentAt: nowLabel(),
        own: true,
      },
    ]);
  };

  return (
    <main className="app-shell">
      <header className="app-header card">
        <h1>Vir Space - Milestone 1</h1>
        <p>Electron + React + TypeScript WebRTC room chat</p>
        <div className={`status ${statusClass}`}>Status: {status}</div>
      </header>

      <section className="layout">
        <JoinForm
          defaultSignalingUrl={defaultSignalingUrl}
          joiningDisabled={joined}
          onJoin={joinRoom}
        />

        <div className="right-col">
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
