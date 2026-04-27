import { FormEvent, useEffect, useState } from "react";
import type { DiscoveredRoomSummary } from "../types";
import { DiscoverRoomsPanel } from "./DiscoverRoomsPanel";

type SetupStep = "user-id" | "mode" | "create" | "join";
type RelayDiscoveryPhase = "idle" | "scanning" | "found" | "not-found" | "error";

interface JoinFormProps {
  step: SetupStep;
  userIdDraft: string;
  currentUserId: string;
  discoveredRooms: DiscoveredRoomSummary[];
  relayConnected: boolean;
  relayDiscoveryPhase: RelayDiscoveryPhase;
  relayDiscoveryHost: string | null;
  roomActionDisabled: boolean;
  defaultBootstrapUrl: string;
  onUserIdDraftChange: (next: string) => void;
  onSubmitUserId: () => void;
  onChooseCreate: () => void;
  onChooseJoin: () => void;
  onBackToMode: () => void;
  onSwitchUser: () => void;
  onCreateRoom: (payload: { roomId: string; bootstrapUrl: string; roomPassword: string }) => void;
  onJoinRoom: (payload: { roomId: string; bootstrapUrl: string; roomPassword: string }) => void;
}

function generateRoomId(): string {
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `room-${randomPart}`;
}

const minimumRoomPasswordLength = 4;

function extractHostIp(defaultBootstrapUrl: string): string {
  if (!defaultBootstrapUrl) {
    return "";
  }

  try {
    return new URL(defaultBootstrapUrl).hostname;
  } catch {
    return defaultBootstrapUrl.replace(/^ws:\/\//, "").replace(/:\d+$/, "").trim();
  }
}

function buildBootstrapUrl(hostIp: string): string {
  return `ws://${hostIp.trim()}:8787`;
}

export function JoinForm({
  step,
  userIdDraft,
  currentUserId,
  discoveredRooms,
  relayConnected,
  relayDiscoveryPhase,
  relayDiscoveryHost,
  roomActionDisabled,
  defaultBootstrapUrl,
  onUserIdDraftChange,
  onSubmitUserId,
  onChooseCreate,
  onChooseJoin,
  onBackToMode,
  onSwitchUser,
  onCreateRoom,
  onJoinRoom,
}: JoinFormProps): JSX.Element {
  const defaultHostIp = extractHostIp(defaultBootstrapUrl);
  const [createRoomId, setCreateRoomId] = useState(generateRoomId());
  const [createHostIp, setCreateHostIp] = useState(defaultHostIp);
  const [createRoomPassword, setCreateRoomPassword] = useState("");
  const [joinRoomId, setJoinRoomId] = useState("");
  const [joinBootstrapUrl, setJoinBootstrapUrl] = useState(defaultBootstrapUrl);
  const [joinRoomPassword, setJoinRoomPassword] = useState("");

  useEffect(() => {
    setCreateHostIp(defaultHostIp);
    setJoinBootstrapUrl(defaultBootstrapUrl);
  }, [defaultBootstrapUrl]);

  const submitUserId = (event: FormEvent): void => {
    event.preventDefault();
    onSubmitUserId();
  };

  const submitCreate = (event: FormEvent): void => {
    event.preventDefault();
    onCreateRoom({
      roomId: createRoomId.trim(),
      bootstrapUrl: buildBootstrapUrl(createHostIp),
      roomPassword: createRoomPassword.trim(),
    });
  };

  const submitJoin = (event: FormEvent): void => {
    event.preventDefault();
    let url = joinBootstrapUrl.trim();
    // If user entered just an IPv4, auto-construct ws://<ip>:8787
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url)) {
      url = `ws://${url}:8787`;
    }
    onJoinRoom({
      roomId: joinRoomId.trim(),
      bootstrapUrl: url,
      roomPassword: joinRoomPassword.trim(),
    });
  };

  const useDiscoveredRoom = (room: DiscoveredRoomSummary): void => {
    setJoinRoomId(room.roomId);
    // Keep the relay URL for signaling — do NOT overwrite it with the room
    // creator's hostIp. The relay already knows the room; the joiner only
    // needs to send the roomId to the relay, not connect to the creator directly.
    setJoinBootstrapUrl(defaultBootstrapUrl);
  };

  if (step === "user-id") {
    return (
      <section className="card form room-launcher setup-screen">
        <h2>Welcome to VIR!</h2>
        <p className="setup-copy">Please enter a User ID.</p>
        <form className="subform" onSubmit={submitUserId}>
          <label>
            User ID
            <input
              value={userIdDraft}
              onChange={(event) => onUserIdDraftChange(event.target.value)}
              placeholder="username"
              required
              disabled={roomActionDisabled}
            />
          </label>
          <button type="submit" disabled={roomActionDisabled}>
            Continue
          </button>
        </form>
      </section>
    );
  }

  if (step === "mode") {
    return (
      <section className="card form room-launcher setup-screen">
        <h2>Choose an action</h2>
        <p className="setup-copy">
          Signed in as <strong>{currentUserId}</strong>
        </p>
        <div className="setup-actions">
          <button type="button" disabled={roomActionDisabled} onClick={onChooseCreate}>
            Create Room
          </button>
          <button type="button" disabled={roomActionDisabled} onClick={onChooseJoin}>
            Join Room
          </button>
        </div>
        <button
          type="button"
          className="ghost"
          style={{ color: "var(--ui-text-primary)" }}
          disabled={roomActionDisabled}
          onClick={onSwitchUser}
        >
          Change User ID
        </button>
      </section>
    );
  }

  if (step === "create") {
    return (
      <section className="card form room-launcher setup-screen">
        <h2>Create Room</h2>
        <p className="setup-copy">
          Host user: <strong>{currentUserId}</strong>
        </p>
        <div className="setup-copy">
          <p>Before creating a room, provide:</p>
          <ul>
            <li>Host IPv4 Address: host device LAN IP only (for example, 192.168.1.42).</li>
            <li>Room ID: a unique room name to share with participants.</li>
            <li>Room Password: at least 4 characters.</li>
          </ul>
        </div>
        <form className="subform" onSubmit={submitCreate}>
          <label>
            Host IPv4 Address
            <input
              value={createHostIp}
              onChange={(event) => setCreateHostIp(event.target.value)}
              placeholder="192.168.1.42"
              required
              disabled={roomActionDisabled}
            />
          </label>

          <label>
            Room ID
            <div className="inline-row">
              <input
                value={createRoomId}
                onChange={(event) => setCreateRoomId(event.target.value)}
                placeholder="room-1"
                required
                disabled={roomActionDisabled}
              />
              <button
                type="button"
                className="ghost"
                disabled={roomActionDisabled}
                onClick={() => setCreateRoomId(generateRoomId())}
              >
                Randomize
              </button>
            </div>
          </label>

          <label>
            Room Password
            <input
              type="password"
              value={createRoomPassword}
              onChange={(event) => setCreateRoomPassword(event.target.value)}
              placeholder="Set a room password"
              minLength={minimumRoomPasswordLength}
              required
              disabled={roomActionDisabled}
            />
          </label>

          <div className="setup-actions">
            <button type="button" className="ghost" disabled={roomActionDisabled} onClick={onBackToMode}>
              Back
            </button>
            <button type="submit" disabled={roomActionDisabled}>
              Create Room
            </button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <section className="card form room-launcher setup-screen">
      <h2>Join Room</h2>
      <p className="setup-copy">
        Guest user: <strong>{currentUserId}</strong>
      </p>
      <div className="setup-copy">
        <p>Before joining a room, provide:</p>
        <ul>
          <li>Host IPv4 Address <b>or</b> Bootstrap URL: e.g., <code>192.168.1.42</code> or <code>ws://192.168.1.42:8787</code></li>
          <li>Room ID: the exact room ID shared by the host.</li>
          <li>Room Password: the same password set by the host.</li>
        </ul>
      </div>
      <section className="join-room-layout">
        <DiscoverRoomsPanel
          rooms={discoveredRooms}
          relayConnected={relayConnected}
          relayDiscoveryPhase={relayDiscoveryPhase}
          relayDiscoveryHost={relayDiscoveryHost}
          disabled={roomActionDisabled}
          onUseRoom={useDiscoveredRoom}
        />

        <form className="subform join-manual-form" onSubmit={submitJoin}>
          <h3>Manual Join</h3>

          <label>
            Relay Bootstrap URL
            <input
              value={joinBootstrapUrl}
              onChange={(event) => setJoinBootstrapUrl(event.target.value)}
              placeholder="ws://10.2.x.x:8787"
              required
              disabled={roomActionDisabled}
            />
          </label>

          <label>
            Room ID
            <input
              value={joinRoomId}
              onChange={(event) => setJoinRoomId(event.target.value)}
              placeholder="room-1"
              required
              disabled={roomActionDisabled}
            />
          </label>

          <label>
            Room Password
            <input
              type="password"
              value={joinRoomPassword}
              onChange={(event) => setJoinRoomPassword(event.target.value)}
              placeholder="Enter room password"
              minLength={minimumRoomPasswordLength}
              required
              disabled={roomActionDisabled}
            />
          </label>

          <div className="setup-actions">
            <button type="button" className="ghost" disabled={roomActionDisabled} onClick={onBackToMode}>
              Back
            </button>
            <button type="submit" disabled={roomActionDisabled}>
              Join Room
            </button>
          </div>
        </form>
      </section>
    </section>
  );
}