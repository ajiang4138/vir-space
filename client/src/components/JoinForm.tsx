import { FormEvent, useEffect, useState } from "react";
import type { DiscoveredRoomSummary } from "../types";
import { DiscoverRoomsPanel } from "./DiscoverRoomsPanel";

type SetupStep = "user-id" | "mode" | "create" | "join";

interface JoinFormProps {
  step: SetupStep;
  userIdDraft: string;
  currentUserId: string;
  discoveredRooms: DiscoveredRoomSummary[];
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

export function JoinForm({
  step,
  userIdDraft,
  currentUserId,
  discoveredRooms,
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
  const [createRoomId, setCreateRoomId] = useState(generateRoomId());
  const [createBootstrapUrl, setCreateBootstrapUrl] = useState(defaultBootstrapUrl);
  const [createRoomPassword, setCreateRoomPassword] = useState("");
  const [joinRoomId, setJoinRoomId] = useState("");
  const [joinBootstrapUrl, setJoinBootstrapUrl] = useState(defaultBootstrapUrl);
  const [joinRoomPassword, setJoinRoomPassword] = useState("");

  useEffect(() => {
    if (defaultBootstrapUrl) {
      setCreateBootstrapUrl(defaultBootstrapUrl);
      setJoinBootstrapUrl(defaultBootstrapUrl);
    }
  }, [defaultBootstrapUrl]);

  const submitUserId = (event: FormEvent): void => {
    event.preventDefault();
    onSubmitUserId();
  };

  const submitCreate = (event: FormEvent): void => {
    event.preventDefault();
    onCreateRoom({
      roomId: createRoomId.trim(),
      bootstrapUrl: createBootstrapUrl.trim(),
      roomPassword: createRoomPassword.trim(),
    });
  };

  const submitJoin = (event: FormEvent): void => {
    event.preventDefault();
    onJoinRoom({
      roomId: joinRoomId.trim(),
      bootstrapUrl: joinBootstrapUrl.trim(),
      roomPassword: joinRoomPassword.trim(),
    });
  };

  const useDiscoveredRoom = (room: DiscoveredRoomSummary): void => {
    setJoinRoomId(room.roomId);
    setJoinBootstrapUrl(`ws://${room.hostIp}:${room.hostPort}`);
  };

  if (step === "user-id") {
    return (
      <section className="card form room-launcher setup-screen">
        <h2>Welcome to Vir Space</h2>
        <p className="setup-copy">Enter your user ID to continue.</p>
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
        <button type="button" className="ghost" disabled={roomActionDisabled} onClick={onSwitchUser}>
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
        <form className="subform" onSubmit={submitCreate}>
          <label>
            Bootstrap Signaling URL
            <input
              value={createBootstrapUrl}
              onChange={(event) => setCreateBootstrapUrl(event.target.value)}
              placeholder="ws://192.168.1.42:8787"
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

      <section className="join-room-layout">
        <DiscoverRoomsPanel
          rooms={discoveredRooms}
          disabled={roomActionDisabled}
          onUseRoom={useDiscoveredRoom}
        />

        <form className="subform join-manual-form" onSubmit={submitJoin}>
          <h3>Manual Join</h3>

          <label>
            Bootstrap Signaling URL
            <input
              value={joinBootstrapUrl}
              onChange={(event) => setJoinBootstrapUrl(event.target.value)}
              placeholder="ws://192.168.1.42:8787"
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