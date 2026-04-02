import { FormEvent, useState } from "react";

interface JoinFormProps {
  defaultSignalingUrl: string;
  joiningDisabled: boolean;
  onJoin: (payload: { signalingUrl: string; roomId: string; displayName: string }) => void;
}

export function JoinForm({ defaultSignalingUrl, joiningDisabled, onJoin }: JoinFormProps): JSX.Element {
  const [signalingUrl, setSignalingUrl] = useState(defaultSignalingUrl);
  const [roomId, setRoomId] = useState("room-1");
  const [displayName, setDisplayName] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onJoin({
      signalingUrl: signalingUrl.trim(),
      roomId: roomId.trim(),
      displayName: displayName.trim(),
    });
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h2>Join Room</h2>

      <label>
        Signaling Server URL
        <input
          value={signalingUrl}
          onChange={(e) => setSignalingUrl(e.target.value)}
          placeholder="ws://localhost:8787"
          required
          disabled={joiningDisabled}
        />
      </label>

      <label>
        Room ID
        <input
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          placeholder="room-1"
          required
          disabled={joiningDisabled}
        />
      </label>

      <label>
        Display Name
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Alice"
          required
          disabled={joiningDisabled}
        />
      </label>

      <button type="submit" disabled={joiningDisabled}>
        Join Room
      </button>
    </form>
  );
}
