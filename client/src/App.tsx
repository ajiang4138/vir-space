import { useEffect, useRef, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { DebugLog } from "./components/DebugLog";
import { FileSharePanel } from "./components/FileSharePanel";
import { JoinForm } from "./components/JoinForm";
import { ParticipantList } from "./components/ParticipantList";
import { RoomInfo } from "./components/RoomInfo";
import { TransferList } from "./components/TransferList";
import { WhiteboardPanel } from "./components/WhiteboardPanel";
import { TextEditorPanel } from "./components/TextEditorPanel";
import {
  FileTransferManager,
  type FileTransferTransport
} from "./lib/fileTransfer/transferManager";
import { SignalingClient } from "./lib/signalingClient";
import { WebRtcPeerManager, type WebRtcStatus } from "./lib/webrtc";
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
const hasConfiguredBootstrapUrl = Boolean(import.meta.env.VITE_BOOTSTRAP_SIGNALING_URL?.trim());
const defaultHostPort = 8787;
const minimumRoomPasswordLength = 4;
const maximumRoomParticipants = 6;
const relayDiscoveredRoomsMaxEntries = 200;
const relayDiscoveredRoomsStaleMs = 120_000;
const relayDiscoveredRoomsCleanupIntervalMs = 5_000;
const relayHostListingHeartbeatIntervalMs = 8_000;
const relayReconnectBaseDelayMs = 1_500;
const relayReconnectMaxDelayMs = 10_000;
const relayServerStatusPollIntervalMs = 2_000;
const relayBootstrapDiscoveryPollIntervalMs = 1_000;

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
  const [discoveredRooms, setDiscoveredRooms] = useState<DiscoveredRoomSummary[]>([]);
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
  const [connectedRelayUrl, setConnectedRelayUrl] = useState(defaultBootstrapUrl);
  const [relayConnectedAtMs, setRelayConnectedAtMs] = useState<number | null>(null);
  const [relayServerStartedAtMs, setRelayServerStartedAtMs] = useState<number | null>(null);
  const [relayServerLastSeenAtMs, setRelayServerLastSeenAtMs] = useState<number | null>(null);
  const [relayServerConnectedClients, setRelayServerConnectedClients] = useState<number | null>(null);
  const [relayServerListings, setRelayServerListings] = useState<number | null>(null);
  const [relayDiscoveryStatus, setRelayDiscoveryStatus] = useState<RelayDiscoveryStatus | null>(null);

  const activeRoomRef = useRef<ActiveRoom | null>(null);
  const setupStepRef = useRef<SetupStep>("user-id");
  const signalingStateRef = useRef<SignalingConnectionState>("disconnected");
  const currentUserIdRef = useRef("");
  const pendingActionRef = useRef<PendingAction | null>(null);
  const bootstrapUrlRef = useRef(defaultBootstrapUrl);
  const negotiatedPeersRef = useRef<Set<string>>(new Set());

  const signalingRef = useRef<SignalingClient | null>(null);
  const peerWebRtcManagersRef = useRef<Map<string, WebRtcPeerManager>>(new Map());
  const peerFileManagersRef = useRef<Map<string, FileTransferManager>>(new Map());
  const peerFileStatesRef = useRef<Map<string, FileTransferViewState>>(new Map());
  const relayListingSignatureRef = useRef<string | null>(null);
  const relayListedRoomIdRef = useRef<string | null>(null);
  const discoveredRoomsByKeyRef = useRef<Map<string, DiscoveredRoomSummary>>(new Map());
  const relayReconnectTimerRef = useRef<number | null>(null);
  const relayServerStatusPollTimerRef = useRef<number | null>(null);
  const relayReconnectAttemptsRef = useRef(0);
  const lastSelectedRelayLogRef = useRef<string | null>(null);
  const lastDiscoveredRelayHostRef = useRef<string | null>(null);

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
            addEvent(`received direct data-channel message from ${remotePeer.displayName}: ${text}`);
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
    setupStepRef.current = setupStep;
  }, [setupStep]);

  useEffect(() => {
    signalingStateRef.current = signalingState;
  }, [signalingState]);

  useEffect(() => {
    const cleanupTimer = window.setInterval(() => {
      pruneStaleRelayDiscoveredRooms();
    }, relayDiscoveredRoomsCleanupIntervalMs);

    return () => {
      window.clearInterval(cleanupTimer);
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
        const cachedRelayHost = await window.electronApi.getCachedRelayBootstrapHost();
        if (
          !cancelled
          && cachedRelayHost
          && !isLoopbackHost(cachedRelayHost)
          && !isLikelyVirtualAdapterHost(cachedRelayHost)
        ) {
          setBootstrapUrl(`ws://${cachedRelayHost}:${defaultHostPort}`);
          return;
        }
      } catch {
        // Continue with local network probe fallback.
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

        const pending = pendingActionRef.current;
        if (setupStep === "join" || pending?.intent === "join") {
          signalingRef.current?.subscribeRelayRooms();
        }

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
        if (relayServerStatusPollTimerRef.current !== null) {
          window.clearInterval(relayServerStatusPollTimerRef.current);
          relayServerStatusPollTimerRef.current = null;
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
      onWhiteboardUpdate: (message) => {
        // dispatch custom event for the whiteboard panel
        document.dispatchEvent(new CustomEvent("whiteboard-update", { detail: message }));
      },
      onEditorUpdate: (message) => {
        document.dispatchEvent(new CustomEvent("editor-update", { detail: message }));
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

      if (isLoopbackHost(parsed.hostname) && intent === "create") {
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
    setMessages([]);
    cleanupPeerConnection();
    updateActiveRoom(null);
    pendingActionRef.current = { intent, roomId, bootstrapUrl: resolvedBootstrapUrl, displayName, roomPassword };
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

      pendingActionRef.current = { intent, roomId, bootstrapUrl: resolvedBootstrapUrl, displayName, roomPassword };
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
    void window.electronApi.startRelayDiscoveryScan().catch(() => undefined);

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

  const endRoom = (): void => {
    const room = activeRoomRef.current;
    if (!room || room.myRole !== "host") {
      return;
    }

    signalingRef.current?.endRoom(room.roomId);
    addEvent("host ended room");
    void stopLocalHostService();
    clearRoomState("room closed by host");
  };

  const reconnectRelay = (): void => {
    addEvent("manual relay reconnect requested");
    relayReconnectAttemptsRef.current = 0;
    signalingRef.current?.disconnect();
    void window.electronApi.startRelayDiscoveryScan().catch(() => undefined);
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

  const cancelTransfer = (transferId: string): void => {
    findManagerByTransferId(transferId)?.cancelTransfer(transferId);
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
            <h1>Vir Space - Host-Owned Signaling</h1>
            <p>The room creator listens on a local signaling port; chat messages stay peer-to-peer over WebRTC.</p>
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
                relayConnection={{
                  url: connectedRelayUrl,
                  state: signalingState,
                  connectedAtMs: relayConnectedAtMs,
                  serverStartedAtMs: relayServerStartedAtMs,
                  serverLastSeenAtMs: relayServerLastSeenAtMs,
                  serverConnectedClients: relayServerConnectedClients,
                  serverRelayListings: relayServerListings,
                }}
                onReconnect={reconnectRelay}
              />
            </div>
          </div>
        </section>
      ) : (
        <section className="chatroom-page">
          <header className="app-header card">
            <h1>Vir Space - Chatroom</h1>
            <p>Signaling uses the host client listener. Chat stays on the existing path and file transfers run peer-to-peer over dedicated RTC channels.</p>
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

            {activeRoom && signalingRef.current && (
              <>
                <section className="whiteboard-row" style={{ height: "500px", width: "100%" }}>
                  <WhiteboardPanel
                    roomId={activeRoom.roomId}
                    displayName={activeRoom.myDisplayName}
                    signalingClient={signalingRef.current}
                  />
                </section>

                <section className="editor-row" style={{ height: "500px", width: "100%", marginTop: "16px" }}>
                  <TextEditorPanel
                    roomId={activeRoom.roomId}
                    displayName={activeRoom.myDisplayName}
                    signalingClient={signalingRef.current}
                  />
                </section>
              </>
            )}

            <section className="file-panels">
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
              <TransferList transfers={fileTransfers.activeTransfers} onCancelTransfer={cancelTransfer} />
            </section>

            <ChatPanel
              messages={messages}
              onSend={sendMessage}
            />
            <DebugLog
              events={events}
              relayConnection={{
                url: connectedRelayUrl,
                state: signalingState,
                connectedAtMs: relayConnectedAtMs,
                serverStartedAtMs: relayServerStartedAtMs,
                serverLastSeenAtMs: relayServerLastSeenAtMs,
                serverConnectedClients: relayServerConnectedClients,
                serverRelayListings: relayServerListings,
              }}
              onReconnect={reconnectRelay}
            />
          </section>
        </section>
      )}
    </main>
  );
}
