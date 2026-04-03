import { FormEvent, useState } from "react";

type SetupStep = "user-id" | "mode" | "create" | "join";

interface JoinFormProps {
  step: SetupStep;
  userIdDraft: string;
  currentUserId: string;
  roomActionDisabled: boolean;
  defaultCreateRoomId: string;
  defaultCreatePort: number;
  defaultJoinHostAddress: string;
  defaultJoinHostPort: number;
  onUserIdDraftChange: (next: string) => void;
  onSubmitUserId: () => void;
  onChooseCreate: () => void;
  onChooseJoin: () => void;
  onBackToMode: () => void;
  onSwitchUser: () => void;
  onCreateRoom: (payload: { roomId: string; roomPassword: string; hostPort?: number }) => void;
  onJoinRoom: (payload: { roomId: string; roomPassword: string; hostAddress: string; hostPort: number }) => void;
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
  roomActionDisabled,
  defaultCreateRoomId,
  defaultCreatePort,
  defaultJoinHostAddress,
  defaultJoinHostPort,
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
  const [createRoomPassword, setCreateRoomPassword] = useState("");
  const [createHostPort, setCreateHostPort] = useState(String(defaultCreatePort));
  const [joinRoomId, setJoinRoomId] = useState(defaultCreateRoomId);
  const [joinRoomPassword, setJoinRoomPassword] = useState("");
  const [joinHostAddress, setJoinHostAddress] = useState(defaultJoinHostAddress);
  const [joinHostPort, setJoinHostPort] = useState(String(defaultJoinHostPort));

  const submitUserId = (event: FormEvent): void => {
    event.preventDefault();
    onSubmitUserId();
  };

  const submitCreate = (event: FormEvent): void => {
    event.preventDefault();
    const parsedPort = Number.parseInt(createHostPort.trim(), 10);
    onCreateRoom({
      roomId: createRoomId.trim(),
      roomPassword: createRoomPassword.trim(),
      hostPort: Number.isFinite(parsedPort) ? parsedPort : undefined,
    });
  };

  const submitJoin = (event: FormEvent): void => {
    event.preventDefault();
    onJoinRoom({
      roomId: joinRoomId.trim(),
      roomPassword: joinRoomPassword.trim(),
      hostAddress: joinHostAddress.trim(),
      hostPort: Number.parseInt(joinHostPort.trim(), 10) || defaultJoinHostPort,
    });
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
              placeholder="alice-01"
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
              placeholder="Set a room password (min 4 chars)"
              minLength={minimumRoomPasswordLength}
              required
              disabled={roomActionDisabled}
            />
          </label>

          <label>
            Host Port
            <input
              type="number"
              min="1"
              max="65535"
              value={createHostPort}
              onChange={(event) => setCreateHostPort(event.target.value)}
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
      <form className="subform" onSubmit={submitJoin}>
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
            placeholder="Enter host room password (min 4 chars)"
            minLength={minimumRoomPasswordLength}
            required
            disabled={roomActionDisabled}
          />
        </label>

        <label>
          Host Address
          <input
            value={joinHostAddress}
            onChange={(event) => setJoinHostAddress(event.target.value)}
            placeholder="127.0.0.1"
            required
            disabled={roomActionDisabled}
          />
        </label>

        <label>
          Host Port
          <input
            type="number"
            min="1"
            max="65535"
            value={joinHostPort}
            onChange={(event) => setJoinHostPort(event.target.value)}
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
  );
}