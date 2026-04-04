import type { DiscoveredRoomSummary } from "../types";

interface DiscoverRoomsPanelProps {
  rooms: DiscoveredRoomSummary[];
  disabled?: boolean;
  onUseRoom: (room: DiscoveredRoomSummary) => void;
}

export function DiscoverRoomsPanel({ rooms, disabled = false, onUseRoom }: DiscoverRoomsPanelProps): JSX.Element {
  return (
    <section className="discover-panel">
      <header className="discover-panel-header">
        <h3>Discovered Rooms</h3>
        <span className="discover-count">{rooms.length}</span>
      </header>

      {rooms.length === 0 ? (
        <p className="empty">No rooms discovered yet. Keep this page open or join manually.</p>
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
