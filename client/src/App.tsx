import { useEffect, useRef, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { DebugLog } from "./components/DebugLog";
import { DebugWindow } from "./components/DebugWindow";
import { FileSharePanel } from "./components/FileSharePanel";
import { JoinForm } from "./components/JoinForm";
import { ParticipantList } from "./components/ParticipantList";
import { RoomEndedModal } from "./components/RoomEndedModal";
import { RoomInfo } from "./components/RoomInfo";
import { TextEditorPanel } from "./components/TextEditorPanel";
import { TransferBeforeExitModal } from "./components/TransferBeforeExitModal";
import { UserKickedModal } from "./components/UserKickedModal";
import { WhiteboardPanel } from "./components/WhiteboardPanel";
import { EditorCrdtManager } from "./lib/editorCrdt";
import { SignalingClient } from "./lib/signalingClient";
import {
  FileTransferManager,
  type FileTransferTransport,
  type PreparedLocalShare
} from "./lib/swarm/swarmManager";
import { getUserHash } from "./lib/userHash";
import {
  WebRtcPeerManager,
  type WebRtcConnectionRoute,
  type WebRtcStatus,
} from "./lib/webrtc";
import type {
  ChatMessage,
  ConnectionStatus,
  DiscoveredRoomSummary,
  ParticipantRole,
  ParticipantSummary,
  RelayDiscoveryStatus,
  RelayRoomListing,
  RelayRoomListingInput,
  RoomStatePayload,
} from "./types";
import type { FileTransferViewState } from "./types/fileTransfer";

type RoomIntent = "create" | "join";
type SetupStep = "user-id" | "mode" | "create" | "join";
type SignalingConnectionState = "disconnected" | "connecting" | "connected";
type CenterWorkspace = "chatroom" | "whiteboard" | "editor" | "files";
type OwnershipTransferMode = "stay-in-room" | "leave-room";

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
  hostCandidateBootstrapUrl?: string;
}

interface RemoteEditorCursor {
  peerId: string;
  displayName: string;
  cursorOffset: number;
  updatedAt: number;
}

interface DebugRouteBadge {
  peerId: string;
  displayName: string;
  route: WebRtcConnectionRoute;
}

const defaultBootstrapUrl = import.meta.env.VITE_BOOTSTRAP_SIGNALING_URL ?? "ws://localhost:8787";
const hasConfiguredBootstrapUrl = Boolean(import.meta.env.VITE_BOOTSTRAP_SIGNALING_URL?.trim());
const defaultHostPort = 8787;
const minimumRoomPasswordLength = 4;
const maximumRoomParticipants = 6;
const relayDiscoveredRoomsMaxEntries = 200;
const relayDiscoveredRoomsStaleMs = 25_000;
const relayDiscoveredRoomsCleanupIntervalMs = 5_000;
const relayHostListingHeartbeatIntervalMs = 8_000;
const relayReconnectBaseDelayMs = 1_500;
const relayReconnectMaxDelayMs = 10_000;
const relayServerStatusPollIntervalMs = 2_000;
const relayBootstrapDiscoveryPollIntervalMs = 1_000;
const editorCursorStaleMs = 15000;
const maxChatHistoryEntries = 300;

interface SyncedChatMessage {
  id: string;
  author: string;
  text: string;
  sentAt: string;
}

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

function isLikelyVirtualAdapterHost(hostname: string): boolean {
  return hostname.startsWith("169.254.") || hostname.startsWith("192.168.56.");
}

function pickPreferredHostAddress(addresses: string[]): string | null {
  const nonLoopback = addresses.filter((address) => !isLoopbackHost(address));
  const preferred = nonLoopback.find((address) => !isLikelyVirtualAdapterHost(address));
  if (preferred) {
    return preferred;
  }

  return nonLoopback[0] ?? null;
}

function isWsProtocol(protocol: string): boolean {
  return protocol === "ws:" || protocol === "wss:";
}

function parseHostnameFromWsUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!isWsProtocol(parsed.protocol) || !parsed.hostname) {
      return null;
    }

    return parsed.hostname;
  } catch {
    return null;
  }
}

function isPortInUseError(message: string): boolean {
  return /EADDRINUSE|address already in use/i.test(message);
}

function canReachBootstrapServer(url: string, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: WebSocket | null = null;
    let timeoutHandle = 0;

    const finalize = (reachable: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeoutHandle);

      if (socket) {
        socket.onopen = null;
        socket.onerror = null;
        socket.onclose = null;
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      }

      resolve(reachable);
    };

    try {
      socket = new WebSocket(url);
    } catch {
      resolve(false);
      return;
    }

    timeoutHandle = window.setTimeout(() => {
      finalize(false);
    }, timeoutMs);

    socket.onopen = () => {
      finalize(true);
    };

    socket.onerror = () => {
      finalize(false);
    };

    socket.onclose = () => {
      finalize(false);
    };
  });
}

function htmlToPlainText(html: string): string {
  const parserNode = document.createElement("div");
  parserNode.innerHTML = html;
  return parserNode.innerText ?? "";
}

function buildActiveRoom(
  roomState: RoomStatePayload,
  myPeerId: string,
  fallbackRole: ParticipantRole,
  myDisplayName: string,
): ActiveRoom {
  const resolvedRole = roomState.participants.find((participant) => participant.peerId === myPeerId)?.role ?? fallbackRole;

  return {
    roomId: roomState.roomId,
    myPeerId,
    myDisplayName,
    myRole: resolvedRole,
    roomStatus: roomState.status,
    hostDisplayName: roomState.hostDisplayName,
    participants: roomState.participants,
  };
}

function RelayStatusBadge({
  signalingState,
  relayDiscoveryPhase,
}: {
  signalingState: SignalingConnectionState;
  relayDiscoveryPhase: string;
}): JSX.Element {
  const isConnected = signalingState === "connected";
  const isScanning = relayDiscoveryPhase === "scanning" && signalingState === "disconnected";
  const label = isConnected ? "Relay Connected" : isScanning ? "Scanning…" : "Connecting…";
  const badgeClass = `relay-status-badge relay-status-badge--${isConnected ? "connected" : "pending"}`;
  return (
    <span className="relay-status-badge-wrap">
      <span className={badgeClass} aria-live="polite" aria-label={label}>
        <span className="relay-status-badge__dot" aria-hidden="true" />
        {label}
      </span>
      {!isConnected && (
        <span className="relay-status-badge__hint">
          May take up to 1 minute
        </span>
      )}
    </span>
  );
}

export default function App(): JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [activeRoom, setActiveRoom] = useState<ActiveRoom | null>(null);
  const [discoveredRooms, setDiscoveredRooms] = useState<DiscoveredRoomSummary[]>([]);
  const [fileTransfers, setFileTransfers] = useState<FileTransferViewState>({
    incomingAnnouncements: [],
    rejectedAnnouncements: [],
    activeSwarms: [],
    acceptedSwarmsBySender: [],
  });
  const [whiteboardHistory, setWhiteboardHistory] = useState<Array<{ action: string; data: string; senderPeerId: string; senderDisplayName: string }>>([]);
  const [editorText, setEditorText] = useState("");
  const [setupStep, setSetupStep] = useState<SetupStep>("user-id");
  const [userIdDraft, setUserIdDraft] = useState("");
  const [currentUserId, setCurrentUserId] = useState("");
  const [bootstrapUrl, setBootstrapUrl] = useState(defaultBootstrapUrl);
  const [signalingState, setSignalingState] = useState<SignalingConnectionState>("disconnected");
  const [webRtcStatus, setWebRtcStatus] = useState<WebRtcStatus>("idle");
  const [connectedRelayUrl, setConnectedRelayUrl] = useState(defaultBootstrapUrl);
  const [relayConnectedAtMs, setRelayConnectedAtMs] = useState<number | null>(null);
  const [relayServerStartedAtMs, setRelayServerStartedAtMs] = useState<number | null>(null);
  const [relayServerLastSeenAtMs, setRelayServerLastSeenAtMs] = useState<number | null>(null);
  const [relayServerConnectedClients, setRelayServerConnectedClients] = useState<number | null>(null);
  const [relayServerListings, setRelayServerListings] = useState<number | null>(null);
  const [relayDiscoveryStatus, setRelayDiscoveryStatus] = useState<RelayDiscoveryStatus | null>(null);

  const [activeWorkspace, setActiveWorkspace] = useState<CenterWorkspace>("chatroom");
  const [isLeftLaneCollapsed, setIsLeftLaneCollapsed] = useState(false);
  const [isRightLaneCollapsed, setIsRightLaneCollapsed] = useState(false);
  const [remoteEditorCursors, setRemoteEditorCursors] = useState<RemoteEditorCursor[]>([]);
  const [debugRouteBadges, setDebugRouteBadges] = useState<DebugRouteBadge[]>([]);
  const [showDebugWindow, setShowDebugWindow] = useState(false);
  const [roomClosedReason, setRoomClosedReason] = useState<"host-ended" | "host-disconnected" | null>(null);
  const [wasUserKicked, setWasUserKicked] = useState(false);
  const [isTransferBeforeExitModalOpen, setIsTransferBeforeExitModalOpen] = useState(false);

  const setupStepRef = useRef<SetupStep>("user-id");
  const signalingStateRef = useRef<SignalingConnectionState>("disconnected");
  const activeRoomRef = useRef<ActiveRoom | null>(null);
  const handoverReconnectInProgressRef = useRef(false);
  const handoverReconnectAttemptsRef = useRef(0);
  const handoverConnectionWasOpenRef = useRef(false);
  const roomPasswordRef = useRef("");
  const leaveAfterOwnershipTransferRef = useRef(false);
  const currentUserIdRef = useRef("");
  const pendingActionRef = useRef<PendingAction | null>(null);
  const bootstrapUrlRef = useRef(defaultBootstrapUrl);
  const negotiatedPeersRef = useRef<Set<string>>(new Set());

  const signalingRef = useRef<SignalingClient | null>(null);
  const peerWebRtcManagersRef = useRef<Map<string, WebRtcPeerManager>>(new Map());
  const peerFileManagersRef = useRef<Map<string, FileTransferManager>>(new Map());
  const relayListingSignatureRef = useRef<string | null>(null);
  const relayListedRoomIdRef = useRef<string | null>(null);
  const discoveredRoomsByKeyRef = useRef<Map<string, DiscoveredRoomSummary>>(new Map());
  const relayReconnectTimerRef = useRef<number | null>(null);
  const relayServerStatusPollTimerRef = useRef<number | null>(null);
  const relayReconnectAttemptsRef = useRef(0);
  const lastSelectedRelayLogRef = useRef<string | null>(null);
  const lastDiscoveredRelayHostRef = useRef<string | null>(null);

  const localSeedSharesRef = useRef<Map<string, PreparedLocalShare>>(new Map());
  const chatHistoryRef = useRef<SyncedChatMessage[]>([]);
  const whiteboardHistoryRef = useRef<Array<{ action: string; data: string; senderPeerId: string; senderDisplayName: string }>>([]);
  const editorCrdtRef = useRef<EditorCrdtManager>(new EditorCrdtManager());
  const remoteEditorCursorsRef = useRef<Map<string, RemoteEditorCursor>>(new Map());

  const collapsedLaneWidth = "44px";

  const chatroomLaneStyle = {
    ["--left-lane-width" as string]: isLeftLaneCollapsed ? collapsedLaneWidth : "clamp(180px, 14vw, 220px)",
    ["--right-lane-width" as string]: isRightLaneCollapsed ? collapsedLaneWidth : "clamp(180px, 14vw, 220px)",
  } as React.CSSProperties;

  const addEvent = (text: string): void => {
    setEvents((prev) => [...prev, `[${nowLabel()}] ${text}`].slice(-150));
  };

  const appendChatHistory = (entry: SyncedChatMessage): void => {
    chatHistoryRef.current = [...chatHistoryRef.current, entry].slice(-maxChatHistoryEntries);
  };

  const mergeChatHistory = (incomingEntries: SyncedChatMessage[]): SyncedChatMessage[] => {
    if (incomingEntries.length === 0) {
      return chatHistoryRef.current;
    }

    const knownIds = new Set(chatHistoryRef.current.map((entry) => entry.id));
    const merged = [...chatHistoryRef.current];
    for (const entry of incomingEntries) {
      if (knownIds.has(entry.id)) {
        continue;
      }

      knownIds.add(entry.id);
      merged.push(entry);
    }

    chatHistoryRef.current = merged.slice(-maxChatHistoryEntries);
    return chatHistoryRef.current;
  };

  const updateActiveRoom = (nextRoom: ActiveRoom | null): void => {
    activeRoomRef.current = nextRoom;
    setActiveRoom(nextRoom);
  };

  const setSessionState = (nextStatus: ConnectionStatus): void => {
    setStatus(nextStatus);
  };

  const publishDiscoveredRooms = (): void => {
    const next = Array.from(discoveredRoomsByKeyRef.current.values()).sort((left, right) => {
      if (left.isJoinable !== right.isJoinable) {
        return left.isJoinable ? -1 : 1;
      }

      return right.updatedAt - left.updatedAt;
    });

    setDiscoveredRooms(next);
  };

  const toDiscoveredRoomKey = (listing: Pick<DiscoveredRoomSummary, "roomId" | "hostIp" | "hostPort">): string => {
    return `${listing.hostIp}|${listing.hostPort}|${listing.roomId}`;
  };

  const upsertRelayDiscoveredRoom = (listing: RelayRoomListing): void => {
    const safeUpdatedAt = Number.isFinite(listing.updatedAt) ? listing.updatedAt : Date.now();
    const key = toDiscoveredRoomKey(listing);
    discoveredRoomsByKeyRef.current.set(key, {
      roomId: listing.roomId,
      hostDisplayName: listing.hostDisplayName,
      hostIp: listing.hostIp,
      hostPort: listing.hostPort,
      participantCount: listing.participantCount,
      maxParticipants: listing.maxParticipants,
      isJoinable: listing.isJoinable,
      status: listing.status,
      updatedAt: safeUpdatedAt,
    });

    if (discoveredRoomsByKeyRef.current.size > relayDiscoveredRoomsMaxEntries) {
      const overflowCount = discoveredRoomsByKeyRef.current.size - relayDiscoveredRoomsMaxEntries;
      const oldest = Array.from(discoveredRoomsByKeyRef.current.entries())
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        .slice(0, overflowCount);

      for (const [oldestKey] of oldest) {
        discoveredRoomsByKeyRef.current.delete(oldestKey);
      }
    }

    publishDiscoveredRooms();
  };

  const removeRelayDiscoveredRoom = (target: Pick<DiscoveredRoomSummary, "roomId" | "hostIp" | "hostPort">): void => {
    const key = toDiscoveredRoomKey(target);
    if (!discoveredRoomsByKeyRef.current.delete(key)) {
      return;
    }

    publishDiscoveredRooms();
  };

  const applyRelaySnapshot = (listings: RelayRoomListing[]): void => {
    const next = new Map<string, DiscoveredRoomSummary>();
    for (const listing of listings) {
      const safeUpdatedAt = Number.isFinite(listing.updatedAt) ? listing.updatedAt : Date.now();
      const key = toDiscoveredRoomKey(listing);
      next.set(key, {
        roomId: listing.roomId,
        hostDisplayName: listing.hostDisplayName,
        hostIp: listing.hostIp,
        hostPort: listing.hostPort,
        participantCount: listing.participantCount,
        maxParticipants: listing.maxParticipants,
        isJoinable: listing.isJoinable,
        status: listing.status,
        updatedAt: safeUpdatedAt,
      });
    }

    if (next.size > relayDiscoveredRoomsMaxEntries) {
      const overflowCount = next.size - relayDiscoveredRoomsMaxEntries;
      const oldest = Array.from(next.entries())
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        .slice(0, overflowCount);

      for (const [oldestKey] of oldest) {
        next.delete(oldestKey);
      }
    }

    discoveredRoomsByKeyRef.current = next;
    publishDiscoveredRooms();
  };

  const pruneStaleRelayDiscoveredRooms = (): void => {
    const cutoff = Date.now() - relayDiscoveredRoomsStaleMs;
    let removed = false;

    for (const [key, room] of discoveredRoomsByKeyRef.current.entries()) {
      if (room.updatedAt >= cutoff) {
        continue;
      }

      discoveredRoomsByKeyRef.current.delete(key);
      removed = true;
    }

    if (removed) {
      publishDiscoveredRooms();
    }
  };

  const ensureEditorCrdtInitialized = (roomId: string): void => {
    editorCrdtRef.current.init(roomId);
  };

  const syncRemoteEditorCursorState = (): void => {
    const now = Date.now();
    const next = Array.from(remoteEditorCursorsRef.current.values())
      .filter((cursor) => now - cursor.updatedAt <= editorCursorStaleMs)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));

    setRemoteEditorCursors(next);
  };

  const updateRemoteEditorCursor = (
    peerId: string,
    displayName: string,
    cursorOffset: number | null,
  ): void => {
    if (cursorOffset === null) {
      remoteEditorCursorsRef.current.delete(peerId);
      syncRemoteEditorCursorState();
      return;
    }

    remoteEditorCursorsRef.current.set(peerId, {
      peerId,
      displayName,
      cursorOffset: Math.max(0, Math.floor(cursorOffset)),
      updatedAt: Date.now(),
    });

    syncRemoteEditorCursorState();
  };

  const sendEditorCursorUpdate = (cursorOffset: number | null): void => {
    const room = activeRoomRef.current;
    if (!room) {
      return;
    }

    const message = {
      type: "editor-crdt-cursor",
      roomId: room.roomId,
      senderPeerId: room.myPeerId,
      senderDisplayName: room.myDisplayName,
      cursorOffset,
    };

    for (const manager of peerWebRtcManagersRef.current.values()) {
      manager.sendAppDataMessage(JSON.stringify(message));
    }
  };

  const sendEditorSyncRequestToPeer = (peerId: string): void => {
    const room = activeRoomRef.current;
    const manager = peerWebRtcManagersRef.current.get(peerId);
    if (!room || !manager) {
      return;
    }

    manager.sendAppDataMessage(
      JSON.stringify({
        type: "editor-crdt-sync-request",
        roomId: room.roomId,
        senderPeerId: room.myPeerId,
        senderDisplayName: room.myDisplayName,
      }),
    );
  };

  const applyLegacyEditorSnapshot = (message: unknown): void => {
    const activeRoom = activeRoomRef.current;
    if (!activeRoom) {
      return;
    }

    ensureEditorCrdtInitialized(activeRoom.roomId);

    const incoming = message as { data?: string; text?: string; html?: string };
    const parsedData: { text?: string; html?: string } = {};

    if (typeof incoming.data === "string") {
      try {
        const decoded = JSON.parse(incoming.data) as { text?: string; html?: string };
        if (typeof decoded.text === "string") {
          parsedData.text = decoded.text;
        }
        if (typeof decoded.html === "string") {
          parsedData.html = decoded.html;
        }
      } catch {
        parsedData.text = incoming.data;
      }
    }

    if (!parsedData.text && typeof incoming.text === "string") {
      parsedData.text = incoming.text;
    }
    if (!parsedData.html && typeof incoming.html === "string") {
      parsedData.html = incoming.html;
    }

    const nextText = parsedData.text || (parsedData.html ? htmlToPlainText(parsedData.html) : "");
    editorCrdtRef.current.applyLocalText(nextText);
  };

  const aggregateFileTransferState = (): void => {
    return;
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

  const announceLocalSeedSharesToPeer = (peerId: string): void => {
    const targetManager = peerFileManagersRef.current.get(peerId);
    if (!targetManager) {
      return;
    }

    const excludedPeerIds = Array.from(peerFileManagersRef.current.keys()).filter((id) => id !== peerId);
    for (const preparedShare of localSeedSharesRef.current.values()) {
      targetManager.sharePreparedFile(preparedShare, { excludePeerIds: excludedPeerIds });
    }
  };

  const registerLocalSeedShare = (preparedShare: PreparedLocalShare, sourcePeerId?: string): void => {
    localSeedSharesRef.current.set(preparedShare.manifest.torrentId, preparedShare);
    const excluded = sourcePeerId ? [sourcePeerId] : [];
    for (const manager of peerFileManagersRef.current.values()) {
      manager.sharePreparedFile(preparedShare, { excludePeerIds: excluded });
    }
  };

  const removePeerControllers = (peerId: string): void => {
    peerWebRtcManagersRef.current.get(peerId)?.close();
    peerWebRtcManagersRef.current.delete(peerId);
    peerFileManagersRef.current.get(peerId)?.detachFromPeer(peerId);
    peerFileManagersRef.current.delete(peerId);
    remoteEditorCursorsRef.current.delete(peerId);
    syncRemoteEditorCursorState();
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
    remoteEditorCursorsRef.current.clear();
    syncRemoteEditorCursorState();
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

            // Send current whiteboard history to the newly connected peer
            const activeRoom = activeRoomRef.current;
            if (whiteboardHistoryRef.current.length > 0 && activeRoom) {
              const historyMessage = {
                type: "whiteboard-history",
                roomId: activeRoom.roomId,
                senderPeerId: activeRoom.myPeerId,
                senderDisplayName: activeRoom.myDisplayName,
                updates: whiteboardHistoryRef.current,
              };
              const manager = peerWebRtcManagersRef.current.get(remotePeer.peerId);
              if (manager) {
                manager.sendAppDataMessage(JSON.stringify(historyMessage));
              }
            }

            // Host synchronizes prior chatroom history for late joiners.
            if (activeRoom?.myRole === "host" && chatHistoryRef.current.length > 0) {
              const manager = peerWebRtcManagersRef.current.get(remotePeer.peerId);
              if (manager) {
                manager.sendAppDataMessage(
                  JSON.stringify({
                    type: "chat-history",
                    roomId: activeRoom.roomId,
                    senderPeerId: activeRoom.myPeerId,
                    senderDisplayName: activeRoom.myDisplayName,
                    messages: chatHistoryRef.current,
                  }),
                );
              }
            }

            const activeRoomForEditor = activeRoomRef.current;
            if (activeRoomForEditor) {
              ensureEditorCrdtInitialized(activeRoomForEditor.roomId);
              sendEditorSyncRequestToPeer(remotePeer.peerId);
            }

            announceLocalSeedSharesToPeer(remotePeer.peerId);
          },
          onDataChannelClose: () => {
            addEvent(`peer data channel closed: ${remotePeer.displayName}`);
            updateOverallWebRtcStatus();
          },
          onDataMessage: (text) => {
            try {
              const message = JSON.parse(text);
              if (message.type === "chat-message") {
                const chatEntry: SyncedChatMessage = {
                  id: typeof message.messageId === "string" && message.messageId.trim().length > 0
                    ? message.messageId
                    : crypto.randomUUID(),
                  author: typeof message.senderDisplayName === "string" && message.senderDisplayName.trim().length > 0
                    ? message.senderDisplayName
                    : "Peer",
                  text: typeof message.text === "string" ? message.text : "",
                  sentAt: typeof message.sentAt === "string" && message.sentAt.trim().length > 0
                    ? message.sentAt
                    : nowLabel(),
                };

                appendChatHistory(chatEntry);
                setMessages((prev) => [
                  ...prev,
                  {
                    id: chatEntry.id,
                    author: chatEntry.author,
                    text: chatEntry.text,
                    sentAt: chatEntry.sentAt,
                    own: false,
                  },
                ]);
              } else if (message.type === "chat-history") {
                if (!Array.isArray(message.messages)) {
                  return;
                }

                const historyPayload = message.messages as unknown[];
                const normalizedIncoming = historyPayload
                  .map((entry: unknown) => {
                    if (!entry || typeof entry !== "object") {
                      return null;
                    }

                    const candidate = entry as Partial<SyncedChatMessage>;
                    if (
                      typeof candidate.id !== "string" ||
                      typeof candidate.author !== "string" ||
                      typeof candidate.text !== "string" ||
                      typeof candidate.sentAt !== "string"
                    ) {
                      return null;
                    }

                    return {
                      id: candidate.id,
                      author: candidate.author,
                      text: candidate.text,
                      sentAt: candidate.sentAt,
                    } satisfies SyncedChatMessage;
                  })
                  .filter((entry: SyncedChatMessage | null): entry is SyncedChatMessage => entry !== null);

                const merged = mergeChatHistory(normalizedIncoming);
                const localDisplayName = activeRoomRef.current?.myDisplayName ?? "";
                setMessages(
                  merged.map((entry) => ({
                    id: entry.id,
                    author: entry.author,
                    text: entry.text,
                    sentAt: entry.sentAt,
                    own: entry.author === localDisplayName,
                  })),
                );
              } else if (message.type === "whiteboard-update") {
                // Save the update to history
                try {
                  const data = JSON.parse(message.data);
                  if (data.action === "clear") {
                    whiteboardHistoryRef.current = [];
                  } else if (data.action === "stroke" || data.action === "paths") {
                    whiteboardHistoryRef.current.push({
                      action: data.action,
                      data: message.data,
                      senderPeerId: message.senderPeerId,
                      senderDisplayName: message.senderDisplayName,
                    });
                  }
                  setWhiteboardHistory([...whiteboardHistoryRef.current]);
                } catch {
                  // If parsing fails, just keep the raw data
                  whiteboardHistoryRef.current.push({
                    action: "unknown",
                    data: message.data,
                    senderPeerId: message.senderPeerId,
                    senderDisplayName: message.senderDisplayName,
                  });
                }
                document.dispatchEvent(new CustomEvent("whiteboard-update", { detail: message }));
              } else if (message.type === "whiteboard-history") {
                // Receive the whiteboard history from a peer
                whiteboardHistoryRef.current = message.updates;
                setWhiteboardHistory([...message.updates]);
                // Replay the history on the canvas
                for (const update of message.updates) {
                  const historyMessage = {
                    type: "whiteboard-update",
                    data: update.data,
                    senderPeerId: update.senderPeerId,
                    senderDisplayName: update.senderDisplayName,
                  };
                  document.dispatchEvent(new CustomEvent("whiteboard-update", { detail: historyMessage }));
                }
              } else if (message.type === "editor-crdt-sync-request") {
                const activeRoomForEditor = activeRoomRef.current;
                const manager = peerWebRtcManagersRef.current.get(remotePeer.peerId);
                if (!activeRoomForEditor || !manager) {
                  return;
                }

                ensureEditorCrdtInitialized(activeRoomForEditor.roomId);
                manager.sendAppDataMessage(
                  JSON.stringify({
                    type: "editor-crdt-sync-state",
                    roomId: activeRoomForEditor.roomId,
                    senderPeerId: activeRoomForEditor.myPeerId,
                    senderDisplayName: activeRoomForEditor.myDisplayName,
                    updateBase64: editorCrdtRef.current.encodeStateAsUpdateBase64(),
                  }),
                );
              } else if (message.type === "editor-crdt-sync-state") {
                if (typeof message.updateBase64 === "string" && message.updateBase64.length > 0) {
                  editorCrdtRef.current.applyRemoteUpdate(message.updateBase64);
                }
              } else if (message.type === "editor-crdt-update") {
                if (typeof message.updateBase64 === "string" && message.updateBase64.length > 0) {
                  editorCrdtRef.current.applyRemoteUpdate(message.updateBase64);
                }
              } else if (message.type === "editor-crdt-cursor") {
                const senderPeerId = typeof message.senderPeerId === "string" ? message.senderPeerId : remotePeer.peerId;
                if (senderPeerId === activeRoomRef.current?.myPeerId) {
                  return;
                }

                const senderDisplayName = typeof message.senderDisplayName === "string"
                  ? message.senderDisplayName
                  : remotePeer.displayName;

                const cursorOffset = typeof message.cursorOffset === "number" && Number.isFinite(message.cursorOffset)
                  ? message.cursorOffset
                  : null;

                updateRemoteEditorCursor(senderPeerId, senderDisplayName, cursorOffset);
              } else if (message.type === "editor-update") {
                applyLegacyEditorSnapshot(message);
              } else if (message.type === "editor-state") {
                applyLegacyEditorSnapshot(message);
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
            setFileTransfers(state);
          },
          onEvent: addEvent,
          onSeedableDownloadReady: (preparedShare) => {
            registerLocalSeedShare(preparedShare, remotePeer.peerId);
            addEvent(`seeding ready: ${preparedShare.manifest.fileName}`);
          },
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
    // Eagerly remove the relay listing BEFORE any state is cleared,
    // while the signaling connection is still active.
    const listedRoomId = relayListedRoomIdRef.current;
    if (listedRoomId) {
      signalingRef.current?.removeRelayRoom(listedRoomId);
      relayListedRoomIdRef.current = null;
      relayListingSignatureRef.current = null;
    }

    handoverReconnectInProgressRef.current = false;
    handoverReconnectAttemptsRef.current = 0;
    leaveAfterOwnershipTransferRef.current = false;
    roomPasswordRef.current = "";
    chatHistoryRef.current = [];
    cleanupPeerConnection();
    localSeedSharesRef.current.clear();
    setDebugRouteBadges([]);
    updateActiveRoom(null);
    setMessages([]);
    whiteboardHistoryRef.current = [];
    setWhiteboardHistory([]);
    editorCrdtRef.current.dispose();
    setEditorText("");
    setSessionState(nextStatus);
    setSetupStep(currentUserIdRef.current ? "mode" : "user-id");
    void refreshLocalBootstrapUrl(parsePortFromWsUrl(bootstrapUrlRef.current));
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
    setupStepRef.current = setupStep;
  }, [setupStep]);

  useEffect(() => {
    signalingStateRef.current = signalingState;
  }, [signalingState]);

  useEffect(() => {
    const cleanupTimer = window.setInterval(() => {
      pruneStaleRelayDiscoveredRooms();
    }, relayDiscoveredRoomsCleanupIntervalMs);

    const intervalHandle = window.setInterval(() => {
      syncRemoteEditorCursorState();
    }, 4000);

    return () => {
      window.clearInterval(cleanupTimer);
      window.clearInterval(intervalHandle);
    };
  }, []);

  useEffect(() => {
    const selected = bootstrapUrl.trim();
    if (!selected || selected === lastSelectedRelayLogRef.current) {
      return;
    }

    lastSelectedRelayLogRef.current = selected;

    // Don't log bootstrap URL changes while already connected — the change
    // is recorded for future reconnects but the current connection is fine.
    if (signalingStateRef.current !== "connected") {
      addEvent(`relay bootstrap selected: ${selected}`);
    }
  }, [bootstrapUrl]);

  useEffect(() => {
    let cancelled = false;

    const collectRoutes = async (): Promise<void> => {
      const room = activeRoomRef.current;
      if (!room) {
        if (!cancelled) {
          setDebugRouteBadges([]);
        }
        return;
      }

      const remotePeers = room.participants.filter((participant) => participant.peerId !== room.myPeerId);
      const nextBadges = await Promise.all(
        remotePeers.map(async (peer) => {
          const manager = peerWebRtcManagersRef.current.get(peer.peerId);
          const route = manager
            ? await manager.getConnectionRoute()
            : {
                kind: "unknown" as const,
                localCandidateType: null,
                remoteCandidateType: null,
                protocol: null,
              };

          return {
            peerId: peer.peerId,
            displayName: peer.displayName,
            route,
          };
        }),
      );

      if (!cancelled) {
        setDebugRouteBadges(nextBadges);
      }
    };

    void collectRoutes();
    const intervalHandle = window.setInterval(() => {
      void collectRoutes();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalHandle);
    };
  }, [activeRoom]);

  useEffect(() => {
    if (!activeRoom) {
      return;
    }

    ensureEditorCrdtInitialized(activeRoom.roomId);
    setEditorText(editorCrdtRef.current.getText());

    const unsubscribeText = editorCrdtRef.current.onTextChanged((nextText) => {
      setEditorText(nextText);
    });
    const unsubscribeLocal = editorCrdtRef.current.onLocalUpdate((updateBase64) => {
      const room = activeRoomRef.current;
      if (!room) {
        return;
      }

      const message = {
        type: "editor-crdt-update",
        roomId: room.roomId,
        senderPeerId: room.myPeerId,
        senderDisplayName: room.myDisplayName,
        updateBase64,
      };

      for (const manager of peerWebRtcManagersRef.current.values()) {
        manager.sendAppDataMessage(JSON.stringify(message));
      }
    });

    return () => {
      unsubscribeText();
      unsubscribeLocal();
    };
  }, [activeRoom?.roomId]);

  useEffect(() => {
    if (hasConfiguredBootstrapUrl) {
      return;
    }

    let cancelled = false;

    const primeBootstrapUrl = async (): Promise<void> => {
      const currentHost = parseHostnameFromWsUrl(bootstrapUrlRef.current);
      if (currentHost && !isLoopbackHost(currentHost)) {
        return;
      }

      try {
        const networkInfo = await window.electronApi.getLocalNetworkInfo();
        if (cancelled) {
          return;
        }

        const preferredAddress = pickPreferredHostAddress([networkInfo.preferredAddress, ...networkInfo.addresses]);
        if (preferredAddress) {
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
    let cancelled = false;

    const refreshRelayDiscovery = async (): Promise<void> => {
      try {
        const statusSnapshot = await window.electronApi.getRelayDiscoveryStatus();
        if (cancelled) {
          return;
        }

        setRelayDiscoveryStatus(statusSnapshot);

        if (statusSnapshot.phase !== "found" || !statusSnapshot.host || isLoopbackHost(statusSnapshot.host)) {
          return;
        }

        if (statusSnapshot.host === lastDiscoveredRelayHostRef.current) {
          return;
        }

        lastDiscoveredRelayHostRef.current = statusSnapshot.host;
        const discoveredUrl = `ws://${statusSnapshot.host}:${defaultHostPort}`;

        // Always update bootstrap URL so future reconnects use the right host,
        // but only log and attempt connection when not already connected.
        setBootstrapUrl(discoveredUrl);

        if (signalingStateRef.current === "connected") {
          return;
        }

        addEvent(`relay discovery found bootstrap server: ${discoveredUrl}`);

        if (setupStepRef.current !== "join") {
          return;
        }

        if (activeRoomRef.current || pendingActionRef.current || signalingStateRef.current !== "disconnected") {
          return;
        }

        relayReconnectAttemptsRef.current = 0;
        setSignalingState("connecting");
        setSessionState("connecting to bootstrap server");
        setConnectedRelayUrl(discoveredUrl);
        signalingRef.current?.connect(discoveredUrl);
      } catch {
        if (cancelled) {
          return;
        }

        setRelayDiscoveryStatus((previous) => previous ?? {
          phase: "error",
          host: null,
          startedAt: null,
          updatedAt: Date.now(),
          lastError: "Unable to read relay discovery state",
        });
      }
    };

    void window.electronApi.startRelayDiscoveryScan().catch(() => undefined);
    void refreshRelayDiscovery();

    const timer = window.setInterval(() => {
      void refreshRelayDiscovery();
    }, relayBootstrapDiscoveryPollIntervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const syncRelayHostListing = async (): Promise<void> => {
      const signaling = signalingRef.current;
      if (!signaling || signalingState !== "connected") {
        return;
      }

      const room = activeRoom;
      if (!room || room.myRole !== "host" || room.roomStatus !== "open") {
        const listedRoomId = relayListedRoomIdRef.current;
        if (listedRoomId) {
          signaling.removeRelayRoom(listedRoomId);
          relayListedRoomIdRef.current = null;
          relayListingSignatureRef.current = null;
          addEvent(`relay discovery listing removed: ${listedRoomId}`);
        }

        return;
      }

      let hostIp = parseHostnameFromWsUrl(bootstrapUrlRef.current) ?? "";
      if (!hostIp || isLoopbackHost(hostIp)) {
        try {
          const networkInfo = await window.electronApi.getLocalNetworkInfo();
          if (cancelled) {
            return;
          }

          hostIp = pickPreferredHostAddress([networkInfo.preferredAddress, ...networkInfo.addresses]) ?? "";
        } catch {
          addEvent("error: failed to resolve host IP for relay discovery listing");
          return;
        }
      }

      if (!hostIp || isLoopbackHost(hostIp)) {
        addEvent("warning: relay discovery listing skipped because no non-loopback host IP was resolved");
        return;
      }

      const listing: RelayRoomListingInput = {
        roomId: room.roomId,
        hostDisplayName: room.myDisplayName,
        hostIp,
        hostPort: parsePortFromWsUrl(bootstrapUrlRef.current),
        participantCount: room.participants.length,
        maxParticipants: maximumRoomParticipants,
        isJoinable: room.participants.length < maximumRoomParticipants,
        status: room.roomStatus,
      };

      const nextSignature = [
        listing.roomId,
        listing.hostDisplayName,
        listing.hostIp,
        String(listing.hostPort),
        String(listing.participantCount),
        String(listing.maxParticipants),
        String(listing.isJoinable),
        listing.status,
      ].join("|");

      if (nextSignature === relayListingSignatureRef.current) {
        return;
      }

      const previouslyListedRoomId = relayListedRoomIdRef.current;
      if (previouslyListedRoomId && previouslyListedRoomId !== room.roomId) {
        signaling.removeRelayRoom(previouslyListedRoomId);
      }

      const shouldUpdateExisting = previouslyListedRoomId === room.roomId;
      if (shouldUpdateExisting) {
        signaling.updateRelayRoom(listing);
      } else {
        signaling.registerRelayRoom(listing);
        addEvent(`relay discovery listing active for ${room.roomId} on ${listing.hostIp}:${listing.hostPort}`);
      }

      relayListedRoomIdRef.current = room.roomId;
      relayListingSignatureRef.current = nextSignature;
    };

    void syncRelayHostListing();

    return () => {
      cancelled = true;
    };
  }, [activeRoom, signalingState]);

  useEffect(() => {
    const room = activeRoom;
    if (!room || room.myRole !== "host" || room.roomStatus !== "open" || signalingState !== "connected") {
      return;
    }

    const timer = window.setInterval(async () => {
      const signaling = signalingRef.current;
      const active = activeRoomRef.current;
      if (!signaling || !active || active.myRole !== "host" || active.roomStatus !== "open") {
        return;
      }

      let hostIp = parseHostnameFromWsUrl(bootstrapUrlRef.current) ?? "";
      if (!hostIp || isLoopbackHost(hostIp)) {
        try {
          const networkInfo = await window.electronApi.getLocalNetworkInfo();
          hostIp = pickPreferredHostAddress([networkInfo.preferredAddress, ...networkInfo.addresses]) ?? "";
        } catch {
          return;
        }
      }

      if (!hostIp || isLoopbackHost(hostIp)) {
        return;
      }

      const listing: RelayRoomListingInput = {
        roomId: active.roomId,
        hostDisplayName: active.myDisplayName,
        hostIp,
        hostPort: parsePortFromWsUrl(bootstrapUrlRef.current),
        participantCount: active.participants.length,
        maxParticipants: maximumRoomParticipants,
        isJoinable: active.participants.length < maximumRoomParticipants,
        status: active.roomStatus,
      };

      signaling.updateRelayRoom(listing);
    }, relayHostListingHeartbeatIntervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [activeRoom, signalingState]);

  useEffect(() => {
    bootstrapUrlRef.current = bootstrapUrl;
  }, [bootstrapUrl]);

  const refreshLocalBootstrapUrl = async (port = defaultHostPort): Promise<void> => {
    try {
      const networkInfo = await window.electronApi.getLocalNetworkInfo();
      const preferredAddress = networkInfo.preferredAddress;
      if (preferredAddress && !isLoopbackHost(preferredAddress)) {
        setBootstrapUrl(`ws://${preferredAddress}:${port}`);
      }
    } catch {
      // Keep current bootstrap URL when local discovery is unavailable.
    }
  };

  const resolveHostCandidateBootstrapUrl = async (port: number): Promise<string | undefined> => {
    try {
      const networkInfo = await window.electronApi.getLocalNetworkInfo();
      const preferredAddress = networkInfo.preferredAddress;
      if (!preferredAddress || isLoopbackHost(preferredAddress)) {
        return undefined;
      }

      return `ws://${preferredAddress}:${port}`;
    } catch {
      return undefined;
    }
  };

  const reconnectToTransferredHost = (nextBootstrapUrl: string, intent: RoomIntent = "join"): void => {
    const room = activeRoomRef.current;
    if (!room || !nextBootstrapUrl) {
      return;
    }

    const roomPassword = roomPasswordRef.current;
    if (!roomPassword) {
      addEvent("error: missing room password for seamless transfer reconnect");
      return;
    }

    handoverReconnectInProgressRef.current = true;
    handoverReconnectAttemptsRef.current = 0;
    handoverConnectionWasOpenRef.current = false;
    setBootstrapUrl(nextBootstrapUrl);
    pendingActionRef.current = {
      intent,
      roomId: room.roomId,
      bootstrapUrl: nextBootstrapUrl,
      displayName: room.myDisplayName,
      roomPassword,
      hostCandidateBootstrapUrl: intent === "create" ? nextBootstrapUrl : undefined,
    };
    setSignalingState("connecting");
    setSessionState("connecting to bootstrap server");
    addEvent(`switching signaling endpoint to ${nextBootstrapUrl}`);
    signalingRef.current?.connect(nextBootstrapUrl);
  };

  const becomeTransferredHostAndReconnect = async (nextBootstrapUrl: string): Promise<void> => {
    const requestedPort = parsePortFromWsUrl(nextBootstrapUrl);

    try {
      await window.electronApi.startHostService(requestedPort);
      addEvent(`local host signaling service moved to ${nextBootstrapUrl}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to start new host signaling service";
      addEvent(`error: ${message}`);
      handoverReconnectInProgressRef.current = false;
      return;
    }

    reconnectToTransferredHost(nextBootstrapUrl, "create");
  };

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
        handoverConnectionWasOpenRef.current = true;
        setSignalingState("connected");
        setSessionState("connected to bootstrap server");
        addEvent(`connected to bootstrap signaling server: ${bootstrapUrlRef.current}`);
        setConnectedRelayUrl(bootstrapUrlRef.current);
        setRelayConnectedAtMs(Date.now());
        signalingRef.current?.requestRelayServerStatus();
        if (relayServerStatusPollTimerRef.current !== null) {
          window.clearInterval(relayServerStatusPollTimerRef.current);
          relayServerStatusPollTimerRef.current = null;
        }
        relayServerStatusPollTimerRef.current = window.setInterval(() => {
          signalingRef.current?.requestRelayServerStatus();
        }, relayServerStatusPollIntervalMs);
        relayReconnectAttemptsRef.current = 0;
        if (relayReconnectTimerRef.current !== null) {
          window.clearTimeout(relayReconnectTimerRef.current);
          relayReconnectTimerRef.current = null;
        }

        // Always subscribe so every connected client sees rooms created by any peer,
        // regardless of whether they are in "join" or "create" mode.
        signalingRef.current?.subscribeRelayRooms();

        const pending = pendingActionRef.current;
        if (!pending) {
          return;
        }

        const userHash = getUserHash();

        if (pending.intent === "create") {
          signalingRef.current?.createRoom({
            roomId: pending.roomId,
            displayName: pending.displayName,
            roomPassword: pending.roomPassword,
          }, userHash, pending.hostCandidateBootstrapUrl);
          return;
        }

        setSessionState("joining room");
        signalingRef.current?.joinRoom({
          roomId: pending.roomId,
          displayName: pending.displayName,
          roomPassword: pending.roomPassword,
        }, userHash, pending.hostCandidateBootstrapUrl);
      },
      onClose: () => {
        if (relayServerStatusPollTimerRef.current !== null) {
          window.clearInterval(relayServerStatusPollTimerRef.current);
          relayServerStatusPollTimerRef.current = null;
        }
        if (handoverReconnectInProgressRef.current) {
          if (!handoverConnectionWasOpenRef.current && handoverReconnectAttemptsRef.current < 8) {
            handoverReconnectAttemptsRef.current += 1;
            const attempt = handoverReconnectAttemptsRef.current;
            const retryDelayMs = Math.min(1500, 200 * attempt);
            const bootstrapUrl = pendingActionRef.current?.bootstrapUrl;
            addEvent(`handover connection retry ${attempt}/8 in ${retryDelayMs}ms`);
            if (bootstrapUrl) {
              window.setTimeout(() => {
                if (!handoverReconnectInProgressRef.current) {
                  return;
                }
                handoverConnectionWasOpenRef.current = false;
                signalingRef.current?.connect(bootstrapUrl);
              }, retryDelayMs);
            }
          } else if (handoverReconnectAttemptsRef.current >= 8) {
            handoverReconnectInProgressRef.current = false;
            handoverReconnectAttemptsRef.current = 0;
            setSignalingState("disconnected");
            addEvent("handover failed: max retries exceeded");
          } else {
            addEvent("signaling reconnecting for host handover");
          }
          return;
        }
        setSignalingState("disconnected");
        addEvent(`signaling disconnected: ${bootstrapUrlRef.current}`);
        setRelayConnectedAtMs(null);
        relayListedRoomIdRef.current = null;
        relayListingSignatureRef.current = null;

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

        roomPasswordRef.current = pending.roomPassword;
        if (handoverReconnectInProgressRef.current) {
          handoverReconnectInProgressRef.current = false;
          handoverReconnectAttemptsRef.current = 0;
          addEvent("room migrated to new host signaling endpoint");
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

        roomPasswordRef.current = pending.roomPassword;

        applyRoomState(message.room, message.senderPeerId, message.role, pending.displayName);
        if (handoverReconnectInProgressRef.current) {
          handoverReconnectInProgressRef.current = false;
          handoverReconnectAttemptsRef.current = 0;
          addEvent("reconnected to new host signaling endpoint");
        }
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

        // Only show modal to guests, not the host
        const room = activeRoomRef.current;
        if (room?.myRole === "guest") {
          setRoomClosedReason(message.reason);
        } else {
          // Host just closes cleanly
          clearRoomState(message.reason === "host-disconnected" ? "host disconnected" : "room closed by host");
        }
      },
      onRoomHostTransferred: (message) => {
        const room = activeRoomRef.current;
        if (!room || room.roomId !== message.roomId) {
          return;
        }

        applyRoomState(message.room, room.myPeerId, room.myRole, room.myDisplayName);
        if (message.newHostBootstrapUrl) {
          setBootstrapUrl(message.newHostBootstrapUrl);
        }

        if (message.previousHostPeerId === room.myPeerId) {
          if (leaveAfterOwnershipTransferRef.current) {
            leaveAfterOwnershipTransferRef.current = false;
            signalingRef.current?.leaveRoom(message.roomId);
            clearRoomState("connected to bootstrap server");
            addEvent(`ownership transferred to ${message.newHostDisplayName}; you left the room`);
            return;
          }

          addEvent(`ownership transferred to ${message.newHostDisplayName}; you are now a guest`);
          if (message.newHostBootstrapUrl && message.newHostBootstrapUrl !== bootstrapUrlRef.current) {
            const nextBootstrapUrl = message.newHostBootstrapUrl;
            window.setTimeout(() => {
              reconnectToTransferredHost(nextBootstrapUrl);
            }, 600);
          }
          return;
        }

        if (message.newHostPeerId === room.myPeerId) {
          addEvent("you are now the host");
          if (message.newHostBootstrapUrl && message.newHostBootstrapUrl !== bootstrapUrlRef.current) {
            void becomeTransferredHostAndReconnect(message.newHostBootstrapUrl);
          }
        } else {
          addEvent(`host transferred to ${message.newHostDisplayName}`);
          if (message.newHostBootstrapUrl && message.newHostBootstrapUrl !== bootstrapUrlRef.current) {
            window.setTimeout(() => {
              reconnectToTransferredHost(message.newHostBootstrapUrl ?? "");
            }, 700);
          }
        }
      },
      onUserKicked: (message) => {
        addEvent(`you have been kicked from the room: ${message.message}`);
        clearRoomState("kicked from room");
        setWasUserKicked(true);
      },
      onServerError: (message) => {
        const pending = pendingActionRef.current;
        if (
          handoverReconnectInProgressRef.current &&
          message.code === "ROOM_NOT_FOUND" &&
          pending?.intent === "join" &&
          handoverReconnectAttemptsRef.current < 8
        ) {
          handoverReconnectAttemptsRef.current += 1;
          const attempt = handoverReconnectAttemptsRef.current;
          const retryDelayMs = Math.min(1500, 200 * attempt);
          addEvent(`handover join retry ${attempt}/8 in ${retryDelayMs}ms`);
          setSessionState("connecting to bootstrap server");
          window.setTimeout(() => {
            if (!handoverReconnectInProgressRef.current) {
              return;
            }

            signalingRef.current?.connect(pending.bootstrapUrl);
          }, retryDelayMs);
          return;
        }

        handoverReconnectInProgressRef.current = false;
        handoverReconnectAttemptsRef.current = 0;
        leaveAfterOwnershipTransferRef.current = false;
        addEvent(`error: ${message.message}`);

        const normalizedMessage = message.message.trim().toLowerCase();
        if (!message.code && normalizedMessage === "unsupported message type") {
          return;
        }

        if (message.code?.startsWith("RELAY_")) {
          return;
        }

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
      onRelayRoomUpserted: (message) => {
        upsertRelayDiscoveredRoom(message.listing);
      },
      onRelayRoomRemoved: (message) => {
        removeRelayDiscoveredRoom({
          roomId: message.roomId,
          hostIp: message.hostIp,
          hostPort: message.hostPort,
        });
      },
      onRelayRoomSnapshot: (message) => {
        applyRelaySnapshot(message.listings);
      },
      onRelayServerStatus: (message) => {
        setRelayServerStartedAtMs(message.serverStartedAt);
        setRelayServerLastSeenAtMs(Date.now());
        setRelayServerConnectedClients(message.connectedClients);
        setRelayServerListings(message.relayListings);
      },
    });

    return () => {
      if (relayServerStatusPollTimerRef.current !== null) {
        window.clearInterval(relayServerStatusPollTimerRef.current);
        relayServerStatusPollTimerRef.current = null;
      }
      if (relayReconnectTimerRef.current !== null) {
        window.clearTimeout(relayReconnectTimerRef.current);
        relayReconnectTimerRef.current = null;
      }
      pendingActionRef.current = null;
      cleanupPeerConnection("application shutdown");
      editorCrdtRef.current.dispose();
      signalingRef.current?.disconnect();
      void stopLocalHostService();
    };
  }, []);

  useEffect(() => {
    if (activeRoom || signalingState !== "disconnected") {
      if (relayReconnectTimerRef.current !== null) {
        window.clearTimeout(relayReconnectTimerRef.current);
        relayReconnectTimerRef.current = null;
      }
      return;
    }

    if (pendingActionRef.current) {
      return;
    }

    const url = bootstrapUrlRef.current.trim();
    if (!url) {
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }

    if (!isWsProtocol(parsed.protocol)) {
      return;
    }

    const isFirstAttempt = relayReconnectAttemptsRef.current === 0;
    const delayMs = isFirstAttempt
      ? 0
      : Math.min(
          relayReconnectMaxDelayMs,
          relayReconnectBaseDelayMs * relayReconnectAttemptsRef.current,
        );

    relayReconnectTimerRef.current = window.setTimeout(() => {
      relayReconnectTimerRef.current = null;

      if (activeRoomRef.current || pendingActionRef.current || (signalingStateRef.current !== "connecting" && signalingStateRef.current !== "disconnected")) {
        return;
      }

      relayReconnectAttemptsRef.current += 1;
      if (relayReconnectAttemptsRef.current > 0 && relayReconnectAttemptsRef.current % 5 === 0) {
        void window.electronApi.startRelayDiscoveryScan().catch(() => undefined);
      }
      setSignalingState("connecting");
      setSessionState("connecting to bootstrap server");
      addEvent(isFirstAttempt ? `connecting to bootstrap signaling server: ${url}` : `reconnecting to bootstrap signaling server: ${url}`);
      setConnectedRelayUrl(url);
      signalingRef.current?.connect(url);
    }, delayMs);

    return () => {
      if (relayReconnectTimerRef.current !== null) {
        window.clearTimeout(relayReconnectTimerRef.current);
        relayReconnectTimerRef.current = null;
      }
    };
  }, [setupStep, activeRoom, signalingState]);

  const shouldStartLocalHostServiceForCreate = async (resolvedUrl: string): Promise<boolean> => {
    try {
      const parsed = new URL(resolvedUrl);
      if (!isWsProtocol(parsed.protocol)) {
        return false;
      }

      const targetHost = parsed.hostname.trim().toLowerCase();
      if (!targetHost) {
        return false;
      }

      if (isLoopbackHost(targetHost)) {
        return true;
      }

      const networkInfo = await window.electronApi.getLocalNetworkInfo();
      if (networkInfo.hostname.trim().toLowerCase() === targetHost) {
        return true;
      }

      return networkInfo.addresses.some((address) => address.trim().toLowerCase() === targetHost);
    } catch {
      return false;
    }
  };

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

      if (intent === "create" && isLoopbackHost(parsed.hostname)) {
        try {
          const networkInfo = await window.electronApi.getLocalNetworkInfo();
          const preferredAddress = pickPreferredHostAddress([networkInfo.preferredAddress, ...networkInfo.addresses]);
          if (preferredAddress) {
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
    roomPasswordRef.current = roomPassword;
    chatHistoryRef.current = [];
    setMessages([]);
    cleanupPeerConnection();
    updateActiveRoom(null);

    const requestedPort = parsePortFromWsUrl(resolvedBootstrapUrl);
    const hostCandidateBootstrapUrl = await resolveHostCandidateBootstrapUrl(requestedPort);

    pendingActionRef.current = {
      intent,
      roomId,
      bootstrapUrl: resolvedBootstrapUrl,
      displayName,
      roomPassword,
      hostCandidateBootstrapUrl,
    };
    setSignalingState("connecting");
    setSessionState("connecting to bootstrap server");
    addEvent(`connecting to bootstrap signaling server: ${resolvedBootstrapUrl}`);
    setConnectedRelayUrl(resolvedBootstrapUrl);

    if (intent === "create") {
      const requestedPort = parsePortFromWsUrl(resolvedBootstrapUrl);
      const bootstrapServerReachable = await canReachBootstrapServer(resolvedBootstrapUrl);
      const shouldStartLocalHostService = await shouldStartLocalHostServiceForCreate(resolvedBootstrapUrl);

      if (bootstrapServerReachable) {
        addEvent("bootstrap signaling server already reachable; skipping local host service startup");
      } else if (!shouldStartLocalHostService) {
        addEvent("using external bootstrap signaling server (skipping local host service startup)");
      } else {
        try {
          const hostStatus = await window.electronApi.startHostService(requestedPort);
          const actualPort = hostStatus.port ?? requestedPort;
          if (actualPort !== requestedPort) {
            const parsed = new URL(resolvedBootstrapUrl);
            parsed.port = String(actualPort);
            resolvedBootstrapUrl = parsed.toString();
            addEvent(`requested port ${requestedPort} was busy; using ${actualPort} automatically`);
          } else {
            addEvent(`local host signaling service listening on port ${requestedPort}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "failed to start local host signaling service";
          if (isPortInUseError(message)) {
            addEvent(`port ${requestedPort} already in use; reusing existing signaling server`);
          } else {
            pendingActionRef.current = null;
            addEvent(`error: ${message}`);
            setSessionState("signaling disconnected");
            return;
          }
        }
      }

      pendingActionRef.current = { intent, roomId, bootstrapUrl: resolvedBootstrapUrl, displayName, roomPassword, hostCandidateBootstrapUrl };
      setBootstrapUrl(resolvedBootstrapUrl);
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

  const chooseJoinMode = (): void => {
    setSetupStep("join");
    relayReconnectAttemptsRef.current = 0;

    if (activeRoomRef.current) {
      return;
    }

    if (signalingState === "connected") {
      signalingRef.current?.subscribeRelayRooms();
      signalingRef.current?.requestRelayRoomList();
      return;
    }

    if (signalingState !== "disconnected") {
      return;
    }

    const url = bootstrapUrlRef.current.trim();
    if (!url) {
      return;
    }

    try {
      const parsed = new URL(url);
      if (!isWsProtocol(parsed.protocol)) {
        return;
      }

      setSignalingState("connecting");
      setSessionState("connecting to bootstrap server");
      addEvent(`connecting to bootstrap signaling server: ${url}`);
      setConnectedRelayUrl(url);
      signalingRef.current?.connect(url);
    } catch {
      addEvent("error: invalid bootstrap URL format for room discovery");
    }
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

  const performEndRoom = (): void => {
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

  const endRoom = (): void => {
    const room = activeRoomRef.current;
    if (!room || room.myRole !== "host") {
      return;
    }

    setIsTransferBeforeExitModalOpen(true);
  };

  const reconnectRelay = (): void => {
    addEvent("manual relay reconnect requested");
    relayReconnectAttemptsRef.current = 0;
    const url = bootstrapUrlRef.current.trim();
    if (url) {
      setSignalingState("connecting");
      setSessionState("connecting to bootstrap server");
      setConnectedRelayUrl(url);
      signalingRef.current?.connect(url);
    }
  };

  const transferRoomOwnership = (mode: OwnershipTransferMode = "stay-in-room"): void => {
    const room = activeRoomRef.current;
    if (!room || room.myRole !== "host") {
      leaveAfterOwnershipTransferRef.current = false;
      return;
    }

    const hasEligibleSuccessor = room.participants.some((participant) => participant.peerId !== room.myPeerId);
    if (!hasEligibleSuccessor) {
      leaveAfterOwnershipTransferRef.current = false;
      addEvent("error: no eligible participant available for ownership transfer");
      return;
    }

    const leaveAfterTransfer = mode === "leave-room";
    leaveAfterOwnershipTransferRef.current = leaveAfterTransfer;
    signalingRef.current?.transferRoomOwnership(room.roomId);
    addEvent(leaveAfterTransfer ? "host requested ownership transfer and exit" : "host requested ownership transfer by seniority");
  };

  const transferOwnershipBeforeExit = (): void => {
    transferRoomOwnership("leave-room");
    setIsTransferBeforeExitModalOpen(false);
  };

  const endRoomFromTransferModal = (): void => {
    setIsTransferBeforeExitModalOpen(false);
    performEndRoom();
  };

  const closeTransferBeforeExitModal = (): void => {
    setIsTransferBeforeExitModalOpen(false);
  };

  const handleRoomEndedModalClose = (): void => {
    const reason = roomClosedReason;
    setRoomClosedReason(null);
    clearRoomState(reason === "host-disconnected" ? "host disconnected" : "room closed by host");
  };

  const handleUserKickedModalClose = (): void => {
    setWasUserKicked(false);
  };

  const kickUser = (peerId: string): void => {
    const room = activeRoomRef.current;
    if (!room || room.myRole !== "host") {
      addEvent("error: only host can kick users");
      return;
    }

    signalingRef.current?.kickUser(room.roomId, peerId);
    addEvent(`kicked user from room: ${peerId}`);
  };

  const sendMessage = (text: string): void => {
    const room = activeRoomRef.current;
    if (!room) {
      addEvent("warning: not currently in a room");
      return;
    }

    const messageId = crypto.randomUUID();
    const sentAt = nowLabel();
    const chatEntry: SyncedChatMessage = {
      id: messageId,
      author: room.myDisplayName,
      text,
      sentAt,
    };

    appendChatHistory(chatEntry);

    const msg = {
      type: "chat-message",
      roomId: room.roomId,
      senderPeerId: room.myPeerId,
      senderDisplayName: room.myDisplayName,
      messageId,
      sentAt,
      text,
    };
    for (const manager of peerWebRtcManagersRef.current.values()) {
      manager.sendAppDataMessage(JSON.stringify(msg));
    }

    setMessages((prev) => [
      ...prev,
      {
        id: chatEntry.id,
        author: chatEntry.author,
        text: chatEntry.text,
        sentAt: chatEntry.sentAt,
        own: true,
      },
    ]);
  };

  const getFileManagers = (): FileTransferManager[] => Array.from(peerFileManagersRef.current.values());

  const shareFile = (): void => {
    const managers = getFileManagers();
    const primaryManager = managers[0];
    if (!primaryManager) {
      addEvent("warning: no peer file channels available yet");
      return;
    }

    void (async () => {
      const preparedShare = await primaryManager.prepareShareFile();
      if (!preparedShare) {
        return;
      }

      registerLocalSeedShare(preparedShare);
    })();
  };

  const requestDownload = (torrentId: string, senderPeerId: string): void => {
    const room = activeRoomRef.current;
    if (!room) {
      return;
    }

    const managers = getFileManagers();
    if (managers.length === 0) {
      addEvent("warning: no peer file channels available yet");
      return;
    }

    for (const manager of managers) {
      manager.requestDownload(torrentId, senderPeerId, { swarmTransferId: torrentId });
    }

    addEvent(`swarm download requested for ${torrentId.slice(0, 12)}...`);
  };

  const rejectAnnouncement = (torrentId: string, senderPeerId: string): void => {
    const managers = getFileManagers();
    for (const manager of managers) {
      manager.rejectAnnouncement(torrentId, senderPeerId, "Declined by receiver");
    }

    addEvent(`rejected incoming announcement for ${torrentId.slice(0, 12)}...`);
  };

  const inRoom = Boolean(activeRoom);

  return (
    <main className="app-shell">
      {!inRoom ? (
        <section className="setup-page">
          <header className="app-header card">
            <h1>VIR</h1>
            <RelayStatusBadge signalingState={signalingState} relayDiscoveryPhase={relayDiscoveryStatus?.phase ?? "idle"} />
          </header>

          <div className="setup-page-content">
            <div className="setup-primary">
              <JoinForm
                step={setupStep}
                userIdDraft={userIdDraft}
                currentUserId={currentUserId}
                discoveredRooms={discoveredRooms}
                relayConnected={signalingState === "connected"}
                relayDiscoveryPhase={relayDiscoveryStatus?.phase ?? "idle"}
                relayDiscoveryHost={relayDiscoveryStatus?.host ?? null}
                roomActionDisabled={Boolean(activeRoom)}
                defaultBootstrapUrl={bootstrapUrlRef.current}
                onUserIdDraftChange={setUserIdDraft}
                onSubmitUserId={submitUserId}
                onChooseCreate={() => setSetupStep("create")}
                onChooseJoin={chooseJoinMode}
                onBackToMode={() => setSetupStep("mode")}
                onSwitchUser={switchUser}
                onCreateRoom={createRoom}
                onJoinRoom={joinRoom}
              />
            </div>
            <div className="setup-debug">
              <DebugLog 
                events={events} 
                isWindowOpen={showDebugWindow} 
                onToggleWindow={() => setShowDebugWindow(v => !v)} 
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
                <>
                  <RelayStatusBadge signalingState={signalingState} relayDiscoveryPhase={relayDiscoveryStatus?.phase ?? "idle"} />
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
                </>
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
                      whiteboardHistory={whiteboardHistory}
                      onSendUpdate={(data, displayName) => {
                        const msg = { type: "whiteboard-update", roomId: activeRoom.roomId, senderPeerId: activeRoom.myPeerId, senderDisplayName: displayName, data };
                        
                        // Save the local update to history
                        try {
                          const parsedData = JSON.parse(data);
                          if (parsedData.action === "clear") {
                            whiteboardHistoryRef.current = [];
                          } else if (parsedData.action === "stroke" || parsedData.action === "paths") {
                            whiteboardHistoryRef.current.push({
                              action: parsedData.action,
                              data: data,
                              senderPeerId: activeRoom.myPeerId,
                              senderDisplayName: displayName,
                            });
                          }
                          setWhiteboardHistory([...whiteboardHistoryRef.current]);
                        } catch {
                          // If parsing fails, ignore
                        }
                        
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
                      editorText={editorText}
                      onEditorTextChange={(nextText) => {
                        editorCrdtRef.current.applyLocalText(nextText);
                      }}
                      onCursorChange={sendEditorCursorUpdate}
                      remoteCursors={remoteEditorCursors}
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
                    onRequestDownload={requestDownload}
                    onRejectAnnouncement={rejectAnnouncement}
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
                    currentRole={activeRoom?.myRole}
                    compact
                    showTitle={false}
                    onKickUser={kickUser}
                  />
                </details>

                <section className="menu-section room-control-section">
                  <h3 className="menu-section-title">Room Controls</h3>
                  {activeRoom?.myRole === "host" ? (
                    <>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => transferRoomOwnership()}
                        disabled={!activeRoom.participants.some((participant) => participant.peerId !== activeRoom.myPeerId)}
                      >
                        Transfer Ownership
                      </button>
                      <button type="button" className="danger" onClick={endRoom}>
                        End Room
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={leaveRoom}>
                      Leave Room
                    </button>
                  )}
                </section>
                <div className="setup-debug">
                  <DebugLog 
                    events={events} 
                    isWindowOpen={showDebugWindow} 
                    onToggleWindow={() => setShowDebugWindow(v => !v)} 
                  />
                </div>
              </div>
            ) : null}
          </aside>
        </section>
      )}
      {showDebugWindow && (
        <DebugWindow
          events={events}
          routeBadges={debugRouteBadges}
          relayConnection={{
            url: connectedRelayUrl,
            state: signalingState,
            connectedAtMs: relayConnectedAtMs,
            serverStartedAtMs: relayServerStartedAtMs,
            serverLastSeenAtMs: relayServerLastSeenAtMs,
          }}
          onReconnect={reconnectRelay}
          onClose={() => setShowDebugWindow(false)}
        />
      )}
      {isTransferBeforeExitModalOpen && (
        <TransferBeforeExitModal
          canTransfer={Boolean(activeRoom?.participants.some((participant) => participant.peerId !== activeRoom.myPeerId))}
          onTransfer={transferOwnershipBeforeExit}
          onEndRoom={endRoomFromTransferModal}
          onCancel={closeTransferBeforeExitModal}
        />
      )}
      {roomClosedReason && <RoomEndedModal reason={roomClosedReason} onClose={handleRoomEndedModalClose} />}
      {wasUserKicked && <UserKickedModal onClose={handleUserKickedModalClose} />}
    </main>
  );
}
