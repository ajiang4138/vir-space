import { FormEvent, useState } from "react";

interface JoinFormProps {
  defaultSignalingUrl: string;
  roomActionDisabled: boolean;
  onCreateRoom: (payload: { signalingUrl: string; roomId: string; displayName: string }) => void;
  onJoinRoom: (payload: { signalingUrl: string; roomId: string; displayName: string }) => void;
}

export function JoinForm({
  defaultSignalingUrl,
  roomActionDisabled,
  onCreateRoom,
  onJoinRoom,
}: JoinFormProps): JSX.Element {
  const [signalingUrl, setSignalingUrl] = useState(defaultSignalingUrl);
  const [roomId, setRoomId] = useState("room-1");
  const [displayName, setDisplayName] = useState("");

  const buildPayload = () => ({
    signalingUrl: signalingUrl.trim(),
    roomId: roomId.trim(),
    displayName: displayName.trim(),
  });

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    onCreateRoom(buildPayload());
  };

  const clickJoin = () => {
    onJoinRoom(buildPayload());
  };

  return (
    <form className="card form" onSubmit={submitCreate}>
      <h2>Create or Join Room</h2>

      <label>
        Signaling Server URL
        <input
          value={signalingUrl}
          onChange={(e) => setSignalingUrl(e.target.value)}
          placeholder="ws://localhost:8787"
          required
          disabled={roomActionDisabled}
        />
      </label>

      <label>
        Room ID
        <input
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          placeholder="room-1"
          required
          disabled={roomActionDisabled}
        />
      </label>

      <label>
        Display Name
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Alice"
          required
          disabled={roomActionDisabled}
        />
      </label>

      <div className="form-actions">
        <button type="submit" disabled={roomActionDisabled}>
          Create Room
        </button>
        <button type="button" disabled={roomActionDisabled} onClick={clickJoin}>
          Join Room
        </button>
      </div>
    </form>
  );
}
