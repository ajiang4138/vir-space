import { useEffect, useRef, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { DebugWindow } from "./components/DebugWindow";
import { FileSharePanel } from "./components/FileSharePanel";
import { JoinForm } from "./components/JoinForm";
import { ParticipantList } from "./components/ParticipantList";
import { RoomInfo } from "./components/RoomInfo";
import { TextEditorPanel } from "./components/TextEditorPanel";
import { WhiteboardPanel } from "./components/WhiteboardPanel";
import {
  FileTransferManager,
  type FileTransferTransport
} from "./lib/fileTransfer/transferManager";
import { SignalingClient } from "./lib/signalingClient";
import { WebRtcPeerManager, type WebRtcStatus } from "./lib/webrtc";
import type {
  ChatMessage,
  ConnectionStatus,
  ParticipantRole,
  ParticipantSummary,
  RoomStatePayload,
} from "./types";
import type { FileTransferViewState } from "./types/fileTransfer";

type RoomIntent = "create" | "join";
type SetupStep = "user-id" | "mode" | "create" | "join";
type SignalingConnectionState = "disconnected" | "connecting" | "connected";
type CenterWorkspace = "chatroom" | "whiteboard" | "editor" | "files";

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
  const [fileTransfers, setFileTransfers] = useState<FileTransferViewState>({
    incomingOffers: [],
    activeTransfers: [],
    sharedFilesBySender: [],
  });
  const [setupStep, setSetupStep] = useState<SetupStep>("user-id");
  const [userIdDraft, setUserIdDraft] = useState("");
  const [currentUserId, setCurrentUserId] = useState("");
  const [bootstrapUrl, setBootstrapUrl] = useState(defaultBootstrapUrl);
  const [signalingState, setSignalingState] = useState<SignalingConnectionState>("disconnected");
  const [webRtcStatus, setWebRtcStatus] = useState<WebRtcStatus>("idle");
  const [activeWorkspace, setActiveWorkspace] = useState<CenterWorkspace>("chatroom");
  const [isLeftLaneCollapsed, setIsLeftLaneCollapsed] = useState(false);
  const [isRightLaneCollapsed, setIsRightLaneCollapsed] = useState(false);

  const activeRoomRef = useRef<ActiveRoom | null>(null);
  const currentUserIdRef = useRef("");
  const pendingActionRef = useRef<PendingAction | null>(null);
  const bootstrapUrlRef = useRef(defaultBootstrapUrl);
  const negotiatedPeersRef = useRef<Set<string>>(new Set());

  const signalingRef = useRef<SignalingClient | null>(null);
  const peerWebRtcManagersRef = useRef<Map<string, WebRtcPeerManager>>(new Map());
  const peerFileManagersRef = useRef<Map<string, FileTransferManager>>(new Map());
  const peerFileStatesRef = useRef<Map<string, FileTransferViewState>>(new Map());

  const collapsedLaneWidth = "44px";

  const chatroomLaneStyle = {
    ["--left-lane-width" as string]: isLeftLaneCollapsed ? collapsedLaneWidth : "clamp(180px, 14vw, 220px)",
    ["--right-lane-width" as string]: isRightLaneCollapsed ? collapsedLaneWidth : "clamp(180px, 14vw, 220px)",
  } as React.CSSProperties;

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

  const aggregateFileTransferState = (): void => {
    const aggregate: FileTransferViewState = {
      incomingOffers: [],
      activeTransfers: [],
      sharedFilesBySender: [],
    };

    const sharedByKey = new Map<string, FileTransferViewState["sharedFilesBySender"][number]>();

    for (const state of peerFileStatesRef.current.values()) {
      aggregate.incomingOffers.push(...state.incomingOffers);
      aggregate.activeTransfers.push(...state.activeTransfers);

      for (const senderGroup of state.sharedFilesBySender) {
        const existingGroup = sharedByKey.get(senderGroup.senderPeerId);
        if (!existingGroup) {
          sharedByKey.set(senderGroup.senderPeerId, {
            senderPeerId: senderGroup.senderPeerId,
            senderDisplayName: senderGroup.senderDisplayName,
            files: [...senderGroup.files],
          });
          continue;
        }

        const byFileId = new Map(existingGroup.files.map((file) => [file.fileId, file]));
        for (const file of senderGroup.files) {
          byFileId.set(file.fileId, file);
        }

        existingGroup.files = Array.from(byFileId.values());
      }
    }

    aggregate.sharedFilesBySender = Array.from(sharedByKey.values()).map((group) => ({
      ...group,
      files: group.files.sort((left, right) => right.createdAt - left.createdAt),
    }));
    aggregate.sharedFilesBySender.sort((left, right) => left.senderDisplayName.localeCompare(right.senderDisplayName));
    aggregate.incomingOffers.sort((left, right) => right.createdAt - left.createdAt);
    aggregate.activeTransfers.sort((left, right) => right.updatedAt - left.updatedAt);

    setFileTransfers(aggregate);
  };

  const updateOverallWebRtcStatus = (): void => {
    const managers = Array.from(peerWebRtcManagersRef.current.values());
    if (managers.length === 0) {
      setWebRtcStatus("idle");
      return;
    }

    if (managers.some((manager) => manager.isDataChannelOpen())) {
      setWebRtcStatus("connected");
      return;
    }

    setWebRtcStatus("connecting");
  };

  const removePeerControllers = (peerId: string): void => {
    peerWebRtcManagersRef.current.get(peerId)?.close();
    peerWebRtcManagersRef.current.delete(peerId);
    peerFileManagersRef.current.get(peerId)?.resetRoom("peer left");
    peerFileManagersRef.current.delete(peerId);
    peerFileStatesRef.current.delete(peerId);
    negotiatedPeersRef.current.delete(peerId);
    aggregateFileTransferState();
    updateOverallWebRtcStatus();
  };

  const cleanupPeerConnection = (reason = "peer disconnected"): void => {
    for (const manager of peerFileManagersRef.current.values()) {
      manager.resetRoom(reason);
    }
    for (const manager of peerWebRtcManagersRef.current.values()) {
      manager.close();
    }

    peerFileManagersRef.current.clear();
    peerWebRtcManagersRef.current.clear();
    peerFileStatesRef.current.clear();
    negotiatedPeersRef.current.clear();
    aggregateFileTransferState();
    updateOverallWebRtcStatus();
  };

  const syncTransferContext = (): void => {
    const room = activeRoomRef.current;
    if (!room) {
      for (const manager of peerFileManagersRef.current.values()) {
        manager.setContext(null);
      }
      return;
    }

    const remotePeers = room.participants.filter((participant) => participant.peerId !== room.myPeerId);
    const remotePeerIds = new Set(remotePeers.map((peer) => peer.peerId));

    for (const remotePeer of remotePeers) {
      if (!peerWebRtcManagersRef.current.has(remotePeer.peerId)) {
        const webRtcManager = new WebRtcPeerManager({
          onIceCandidate: (candidate) => {
            const active = activeRoomRef.current;
            if (!active || !signalingRef.current) {
              return;
            }

            signalingRef.current.sendIceCandidate(active.roomId, remotePeer.peerId, candidate);
          },
          onDataChannelOpen: () => {
            setSessionState("peer connected");
            addEvent(`peer connected via WebRTC data channel: ${remotePeer.displayName}`);
            updateOverallWebRtcStatus();
          },
          onDataChannelClose: () => {
            addEvent(`peer data channel closed: ${remotePeer.displayName}`);
            updateOverallWebRtcStatus();
          },
          onDataMessage: (text) => {
            try {
              const message = JSON.parse(text);
              if (message.type === "chat-message") {
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
              } else if (message.type === "whiteboard-update") {
                document.dispatchEvent(new CustomEvent("whiteboard-update", { detail: message }));
              } else if (message.type === "editor-update") {
                document.dispatchEvent(new CustomEvent("editor-update", { detail: message }));
              }
            } catch {
              addEvent(`received direct data-channel message from ${remotePeer.displayName}: ${text.length > 100 ? text.substring(0, 100) + "..." : text}`);
            }
          },
          onFileControlMessage: (text) => {
            void peerFileManagersRef.current.get(remotePeer.peerId)?.handleControlMessage(text);
          },
          onFileDataMessage: (data) => {
            void peerFileManagersRef.current.get(remotePeer.peerId)?.handleBinaryMessage(data);
          },
          onConnectionState: (state) => {
            if (state === "failed") {
              addEvent(`peer connection failed: ${remotePeer.displayName}`);
            }
          },
          onStatusChange: () => {
            updateOverallWebRtcStatus();
          },
        });

        peerWebRtcManagersRef.current.set(remotePeer.peerId, webRtcManager);

        const fileManager = new FileTransferManager(window.electronApi, {
          onUpdate: (state) => {
            peerFileStatesRef.current.set(remotePeer.peerId, state);
            aggregateFileTransferState();
          },
          onEvent: addEvent,
        });

        fileManager.setTransport(webRtcManager as FileTransferTransport);
        peerFileManagersRef.current.set(remotePeer.peerId, fileManager);
      }

      peerFileManagersRef.current.get(remotePeer.peerId)?.setContext({
        roomId: room.roomId,
        myPeerId: room.myPeerId,
        myDisplayName: room.myDisplayName,
        remotePeerId: remotePeer.peerId,
      });
    }

    for (const existingPeerId of Array.from(peerWebRtcManagersRef.current.keys())) {
      if (!remotePeerIds.has(existingPeerId)) {
        removePeerControllers(existingPeerId);
      }
    }

    updateOverallWebRtcStatus();
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

  useEffect(() => {
    if (!activeRoom) {
      setActiveWorkspace("chatroom");
    }
  }, [activeRoom]);

  const applyRoomState = (
    roomState: RoomStatePayload,
    myPeerId: string,
    myRole: ParticipantRole,
    myDisplayName: string,
  ): void => {
    const nextRoom = buildActiveRoom(roomState, myPeerId, myRole, myDisplayName);
    updateActiveRoom(nextRoom);
    syncTransferContext();

    if (roomState.status === "closed") {
      setSessionState(myRole === "guest" ? "host disconnected" : "room closed by host");
      return;
    }

    const remotePeers = nextRoom.participants.filter((participant) => participant.peerId !== myPeerId);
    if (remotePeers.length === 0) {
      setSessionState(myRole === "host" ? "waiting for guest" : "peer connecting");
      return;
    }

    if (Array.from(peerWebRtcManagersRef.current.values()).some((manager) => manager.isDataChannelOpen())) {
      setSessionState("peer connected");
      return;
    }

    setSessionState("peer connecting");
  };

  const tryStartNegotiation = async (): Promise<void> => {
    const room = activeRoomRef.current;
    if (!room) {
      return;
    }

    const remotePeers = room.participants.filter((participant) => participant.peerId !== room.myPeerId);
    for (const remotePeer of remotePeers) {
      const isInitiator = room.myPeerId.localeCompare(remotePeer.peerId) < 0;
      if (!isInitiator || negotiatedPeersRef.current.has(remotePeer.peerId)) {
        continue;
      }

      const manager = peerWebRtcManagersRef.current.get(remotePeer.peerId);
      if (!manager) {
        continue;
      }

      negotiatedPeersRef.current.add(remotePeer.peerId);
      setSessionState("peer connecting");

      try {
        const offer = await manager.createOffer();
        if (offer && signalingRef.current) {
          signalingRef.current.sendOffer(room.roomId, remotePeer.peerId, offer);
        }
      } catch {
        addEvent(`error: failed to create/send offer for ${remotePeer.displayName}`);
        negotiatedPeersRef.current.delete(remotePeer.peerId);
      }
    }
  };

  useEffect(() => {
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
        if (Array.from(peerWebRtcManagersRef.current.values()).some((manager) => manager.isDataChannelOpen())) {
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

        removePeerControllers(message.peerId);
        applyRoomState(message.room, room.myPeerId, room.myRole, room.myDisplayName);

        if (room.myRole === "host") {
          setSessionState("guest left");
          addEvent("guest left the room");
          return;
        }

        setSessionState("peer connecting");
      },

      onOffer: async (message) => {
        addEvent(`received offer from ${message.senderPeerId}`);

        if (!peerWebRtcManagersRef.current.has(message.senderPeerId)) {
          syncTransferContext();
        }

        const manager = peerWebRtcManagersRef.current.get(message.senderPeerId);
        if (!manager) {
          addEvent(`error: missing peer manager for ${message.senderPeerId}`);
          return;
        }

        negotiatedPeersRef.current.add(message.senderPeerId);

        try {
          const answer = await manager.handleRemoteOffer(message.sdp);
          if (answer) {
            signalingRef.current?.sendAnswer(message.roomId, message.senderPeerId, answer);
          }
        } catch {
          addEvent("error: failed to handle offer");
        }
      },
      onAnswer: async (message) => {
        addEvent(`received answer from ${message.senderPeerId}`);
        try {
          await peerWebRtcManagersRef.current.get(message.senderPeerId)?.handleRemoteAnswer(message.sdp);
        } catch {
          addEvent("error: failed to handle answer");
        }
      },
      onIceCandidate: async (message) => {
        try {
          await peerWebRtcManagersRef.current.get(message.senderPeerId)?.addIceCandidate(message.candidate);
        } catch {
          addEvent("error: failed to add ICE candidate");
        }
      },
      onPeerLeft: (message) => {
        removePeerControllers(message.peerId);
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
      cleanupPeerConnection("application shutdown");
      signalingRef.current?.disconnect();
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

    const hostIsAlone = room.participants.length <= 1;
    signalingRef.current?.endRoom(room.roomId);

    if (hostIsAlone) {
      signalingRef.current?.disconnect();
      void stopLocalHostService();
      clearRoomState("room closed by host");
      addEvent("host ended room (solo host)");
      return;
    }

    addEvent("host requested room shutdown");
  };

  const sendMessage = (text: string): void => {
    const room = activeRoomRef.current;
    if (!room) {
      addEvent("warning: not currently in a room");
      return;
    }

    const msg = { type: "chat-message", roomId: room.roomId, senderPeerId: room.myPeerId, senderDisplayName: room.myDisplayName, text };
    for (const manager of peerWebRtcManagersRef.current.values()) {
      manager.sendAppDataMessage(JSON.stringify(msg));
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

  const findManagerByTransferId = (transferId: string): FileTransferManager | null => {
    for (const [peerId, state] of peerFileStatesRef.current.entries()) {
      if (state.incomingOffers.some((offer) => offer.transferId === transferId)) {
        return peerFileManagersRef.current.get(peerId) ?? null;
      }

      if (state.activeTransfers.some((transfer) => transfer.transferId === transferId)) {
        return peerFileManagersRef.current.get(peerId) ?? null;
      }
    }

    return null;
  };

  const shareFile = (): void => {
    void (async () => {
      const managers = Array.from(peerFileManagersRef.current.values());
      if (managers.length === 0) {
        addEvent("warning: no peer file channels available yet");
        return;
      }

      const preparedShare = await managers[0].prepareShareFile();
      if (!preparedShare) {
        return;
      }

      for (const manager of managers) {
        manager.sharePreparedFile(preparedShare);
      }
    })();
  };

  const acceptOffer = (transferId: string): void => {
    findManagerByTransferId(transferId)?.acceptIncomingOffer(transferId);
  };

  const declineOffer = (transferId: string): void => {
    findManagerByTransferId(transferId)?.declineIncomingOffer(transferId);
  };

  const requestDownload = (fileId: string, senderPeerId: string): void => {
    peerFileManagersRef.current.get(senderPeerId)?.requestDownload(fileId, senderPeerId);
  };

  const downloadAcceptedOffer = (transferId: string): void => {
    findManagerByTransferId(transferId)?.downloadAcceptedOffer(transferId);
  };

  const inRoom = Boolean(activeRoom);

  return (
    <main className="app-shell">
      {!inRoom ? (
        <section className="setup-page">
          <header className="app-header card">
            <h1>VIR Space</h1>
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
          </div>
        </section>
      ) : (
        <section className="chatroom-page" style={chatroomLaneStyle}>
          <aside className="left-lane" aria-label="Workspace navigation">
            <div className={`left-lane-card${isLeftLaneCollapsed ? " collapsed" : ""}`}>
              <div className="lane-header">
                <h2 className="lane-title">Menu</h2>
                <button
                  type="button"
                  className="lane-collapse-button"
                  onClick={() => setIsLeftLaneCollapsed((value) => !value)}
                  aria-label={isLeftLaneCollapsed ? "Expand Menu lane" : "Collapse Menu lane"}
                  title={isLeftLaneCollapsed ? "Expand" : "Collapse"}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                    <rect x="4" y="6" width="16" height="2.2" rx="1.1" fill="currentColor" />
                    <rect x="4" y="11" width="16" height="2.2" rx="1.1" fill="currentColor" />
                    <rect x="4" y="16" width="16" height="2.2" rx="1.1" fill="currentColor" />
                  </svg>
                </button>
              </div>
              {!isLeftLaneCollapsed ? (
                <nav className="left-lane-tabs" aria-label="Workspace tabs">
                  <button
                    type="button"
                    className={`lane-tab${activeWorkspace === "chatroom" ? " active" : ""}`}
                    onClick={() => setActiveWorkspace("chatroom")}
                  >
                    Chatroom
                  </button>
                  <button
                    type="button"
                    className={`lane-tab${activeWorkspace === "whiteboard" ? " active" : ""}`}
                    onClick={() => setActiveWorkspace("whiteboard")}
                  >
                    Whiteboard
                  </button>
                  <button
                    type="button"
                    className={`lane-tab${activeWorkspace === "editor" ? " active" : ""}`}
                    onClick={() => setActiveWorkspace("editor")}
                  >
                    Shared Editor
                  </button>
                  <button
                    type="button"
                    className={`lane-tab${activeWorkspace === "files" ? " active" : ""}`}
                    onClick={() => setActiveWorkspace("files")}
                  >
                    File Sharing
                  </button>
                </nav>
              ) : null}
            </div>
          </aside>

          <div className="chatroom-main">
            <section className="chatroom-layout">
              {activeWorkspace === "chatroom" ? (
                <ChatPanel
                  messages={messages}
                  onSend={sendMessage}
                />
              ) : null}

              {activeWorkspace === "whiteboard" ? (
                activeRoom && signalingRef.current ? (
                  <section className="workspace-panel whiteboard-row">
                    <WhiteboardPanel
                      roomId={activeRoom.roomId}
                      displayName={activeRoom.myDisplayName}
                      onSendUpdate={(data, displayName) => {
                        const msg = { type: "whiteboard-update", roomId: activeRoom.roomId, senderPeerId: activeRoom.myPeerId, senderDisplayName: displayName, data };
                        for (const manager of peerWebRtcManagersRef.current.values()) {
                          manager.sendAppDataMessage(JSON.stringify(msg));
                        }
                      }}
                    />
                  </section>
                ) : (
                  <section className="card"><p className="empty">Whiteboard is unavailable until the room connection is ready.</p></section>
                )
              ) : null}

              {activeWorkspace === "editor" ? (
                activeRoom && signalingRef.current ? (
                  <section className="workspace-panel editor-row">
                    <TextEditorPanel
                      roomId={activeRoom.roomId}
                      displayName={activeRoom.myDisplayName}
                      onSendUpdate={(data, displayName) => {
                        const msg = { type: "editor-update", roomId: activeRoom.roomId, senderPeerId: activeRoom.myPeerId, senderDisplayName: displayName, data };
                        for (const manager of peerWebRtcManagersRef.current.values()) {
                          manager.sendAppDataMessage(JSON.stringify(msg));
                        }
                      }}
                    />
                  </section>
                ) : (
                  <section className="card"><p className="empty">Shared editor is unavailable until the room connection is ready.</p></section>
                )
              ) : null}

              {activeWorkspace === "files" ? (
                <section className="workspace-panel">
                  <FileSharePanel
                    viewState={fileTransfers}
                    onShareFile={shareFile}
                    onAcceptOffer={acceptOffer}
                    onDeclineOffer={declineOffer}
                    onRequestDownload={requestDownload}
                    onDownloadAcceptedOffer={downloadAcceptedOffer}
                    shareDisabled={webRtcStatus !== "connected"}
                    currentPeerId={activeRoom?.myPeerId}
                  />
                </section>
              ) : null}
            </section>
          </div>

          <aside className={`right-lane${isRightLaneCollapsed ? " collapsed" : ""}`} aria-label="Room menu">
            <div className="lane-header">
              <button
                type="button"
                className="lane-collapse-button"
                onClick={() => setIsRightLaneCollapsed((value) => !value)}
                aria-label={isRightLaneCollapsed ? "Expand Info lane" : "Collapse Info lane"}
                title={isRightLaneCollapsed ? "Expand" : "Collapse"}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                  <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
                  <rect x="11" y="10" width="2" height="8" rx="1" fill="currentColor" />
                  <rect x="11" y="6" width="2" height="2" rx="1" fill="currentColor" />
                </svg>
              </button>
              <h2 className="lane-title">Info</h2>
            </div>
            {!isRightLaneCollapsed ? (
              <div className="right-lane-content">
                <details className="menu-section menu-section-collapsible" open>
                  <summary className="menu-section-title">Room Info</summary>
                  <RoomInfo
                    roomId={activeRoom?.roomId ?? "-"}
                    yourRole={activeRoom?.myRole ?? "guest"}
                    hostDisplayName={activeRoom?.hostDisplayName ?? "-"}
                    bootstrapUrl={bootstrapUrl}
                    inRoom={Boolean(activeRoom)}
                    compact
                    showTitle={false}
                    showActions={false}
                    onLeaveRoom={leaveRoom}
                    onEndRoom={endRoom}
                  />
                </details>

                <details className="menu-section menu-section-collapsible" open>
                  <summary className="menu-section-title">Members</summary>
                  <ParticipantList
                    participants={activeRoom?.participants ?? []}
                    currentPeerId={activeRoom?.myPeerId ?? ""}
                    compact
                    showTitle={false}
                  />
                </details>

                <section className="menu-section room-control-section">
                  <h3 className="menu-section-title">Room Controls</h3>
                  {activeRoom?.myRole === "host" ? (
                    <button type="button" className="danger" onClick={endRoom}>
                      End Room
                    </button>
                  ) : (
                    <button type="button" onClick={leaveRoom}>
                      Leave Room
                    </button>
                  )}
                </section>
              </div>
            ) : null}
          </aside>
        </section>
      )}

      <DebugWindow events={events} />
    </main>
  );
}
