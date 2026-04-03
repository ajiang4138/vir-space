import type { DiscoveredRoomSummary } from "../types";

interface DiscoverRoomsPanelProps {
  rooms: DiscoveredRoomSummary[];
  disabled?: boolean;
  onUseRoom: (room: DiscoveredRoomSummary) => void;
}

function secondsSince(epochMs: number): number {
  return Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
}

export function DiscoverRoomsPanel({ rooms, disabled, onUseRoom }: DiscoverRoomsPanelProps): JSX.Element {
  return (
    <section className="join-discovery-panel subform">
      <h3>Discovered Rooms</h3>
      <p className="setup-copy">Choose a room to prefill manual join fields, or enter values manually.</p>

      {rooms.length === 0 ? <p className="empty">No active rooms discovered yet.</p> : null}

      <div className="discovered-rooms-grid">
        {rooms.map((room) => {
          const endpoint = `ws://${room.hostIp}:${room.hostPort}`;
          return (
            <article key={`${room.hostIp}|${room.hostPort}|${room.roomId}`} className="discovered-room-card">
              <header>
                <strong>{room.roomId}</strong>
                <span className={room.isJoinable ? "status-badge" : "status-badge failed"}>
                  {room.isJoinable ? "open" : "full"}
                </span>
              </header>

              <p className="meta">Host: {room.hostDisplayName}</p>
              <p className="meta">Peers: {room.participantCount}/{room.maxParticipants}</p>
              <p className="meta">Endpoint: {endpoint}</p>
              <p className="meta">Seen {secondsSince(room.lastSeenAt)}s ago</p>
              {!room.isJoinable ? <p className="meta full-room-note">Room is full right now. It remains listed in case a slot opens.</p> : null}

              <div className="offer-actions">
                <button type="button" className="ghost" disabled={disabled} onClick={() => onUseRoom(room)}>
                  {room.isJoinable ? "Use Room" : "Use Room (Full)"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
