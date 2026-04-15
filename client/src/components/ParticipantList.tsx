import { useState } from "react";
import { ParticipantSummary } from "../types";

interface ParticipantListProps {
  participants: ParticipantSummary[];
  currentPeerId: string;
  currentRole?: "host" | "guest";
  compact?: boolean;
  showTitle?: boolean;
  onKickUser?: (peerId: string) => void;
}

export function ParticipantList({
  participants,
  currentPeerId,
  currentRole,
  compact = false,
  showTitle = true,
  onKickUser,
}: ParticipantListProps): JSX.Element {
  const [hoveredPeerId, setHoveredPeerId] = useState<string | null>(null);
  const participantListClassName = compact ? "participant-list compact" : "card participant-list";
  const isHost = currentRole === "host";

  return (
    <section className={participantListClassName}>
      {showTitle ? <h2>Participants</h2> : null}
      {participants.length === 0 ? <p className="empty">No participants</p> : null}
      <ul>
        {participants.map((participant) => (
          <li
            key={participant.peerId}
            className="participant-item"
            onMouseEnter={() => setHoveredPeerId(participant.peerId)}
            onMouseLeave={() => setHoveredPeerId(null)}
          >
            <span>{participant.displayName}</span>
            <span className="meta">
              {participant.role}
              {participant.peerId === currentPeerId ? " (you)" : ""}
            </span>
            {isHost && participant.peerId !== currentPeerId && hoveredPeerId === participant.peerId && (
              <button
                type="button"
                className="kick-button"
                onClick={() => onKickUser?.(participant.peerId)}
                title="Kick user"
                aria-label={`Kick ${participant.displayName}`}
              >
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
