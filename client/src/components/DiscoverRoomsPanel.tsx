import type { DiscoveredRoomSummary } from "../types";

type RelayDiscoveryPhase = "idle" | "scanning" | "found" | "not-found" | "error";

interface DiscoverRoomsPanelProps {
  rooms: DiscoveredRoomSummary[];
  relayConnected: boolean;
  relayDiscoveryPhase: RelayDiscoveryPhase;
  relayDiscoveryHost: string | null;
  disabled?: boolean;
  onUseRoom: (room: DiscoveredRoomSummary) => void;
}

export function DiscoverRoomsPanel({
  rooms,
  relayConnected,
  relayDiscoveryPhase,
  relayDiscoveryHost,
  disabled = false,
  onUseRoom,
}: DiscoverRoomsPanelProps): JSX.Element {
  let relayStatusLabel = "idle";
  let relayStatusClass = "idle";

  if (relayConnected) {
    relayStatusLabel = "connected";
    relayStatusClass = "connected";
  } else if (relayDiscoveryPhase === "scanning") {
    relayStatusLabel = "scanning";
    relayStatusClass = "scanning";
  } else if (relayDiscoveryPhase === "found" && relayDiscoveryHost) {
    relayStatusLabel = `found ${relayDiscoveryHost}`;
    relayStatusClass = "found";
  } else if (relayDiscoveryPhase === "not-found") {
    relayStatusLabel = "not found";
    relayStatusClass = "not-found";
  } else if (relayDiscoveryPhase === "error") {
    relayStatusLabel = "scan error";
    relayStatusClass = "error";
  }

  const emptyMessage = relayConnected
    ? "No rooms discovered yet. Keep this page open or join manually."
    : relayDiscoveryPhase === "scanning"
      ? "Scanning for relay and rooms in the background..."
      : relayDiscoveryPhase === "not-found"
        ? "No relay found yet. Keep this page open while scanning continues, or join manually."
        : "No rooms discovered yet. Keep this page open or join manually.";

  return (
    <section className="discover-panel">
      <header className="discover-panel-header">
        <h3>Discovered Rooms</h3>
        <div className="discover-panel-meta">
          <span className={`discover-status-badge ${relayStatusClass}`}>{relayStatusLabel}</span>
          <span className="discover-count">{rooms.length}</span>
        </div>
      </header>

      {rooms.length === 0 ? (
        <p className="empty">{emptyMessage}</p>
      ) : (
        <ul className="discover-room-list">
          {rooms.map((room) => {
            const full = !room.isJoinable || room.participantCount >= room.maxParticipants;
            return (
              <li key={`${room.hostIp}:${room.hostPort}:${room.roomId}`} className="discover-room-item">
                <div className="discover-room-main">
                  <p className="discover-room-title">{room.roomId}</p>
                  <p className="discover-room-meta">
                    Host: {room.hostDisplayName} at {room.hostIp}:{room.hostPort}
                  </p>
                  <p className="discover-room-meta">
                    Participants: {room.participantCount}/{room.maxParticipants}
                  </p>
                </div>

                <div className="discover-room-actions">
                  <span className={`status-badge ${full ? "declined" : "completed"}`}>
                    {full ? "full" : "open"}
                  </span>
                  <button
                    type="button"
                    className="ghost"
                    disabled={disabled || full}
                    onClick={() => onUseRoom(room)}
                  >
                    Use Room
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
