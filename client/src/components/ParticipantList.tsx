import { ParticipantSummary } from "../types";

interface ParticipantListProps {
  participants: ParticipantSummary[];
  currentPeerId: string;
  compact?: boolean;
  showTitle?: boolean;
}

export function ParticipantList({ participants, currentPeerId, compact = false, showTitle = true }: ParticipantListProps): JSX.Element {
  const participantListClassName = compact ? "participant-list compact" : "card participant-list";

  return (
    <section className={participantListClassName}>
      {showTitle ? <h2>Participants</h2> : null}
      {participants.length === 0 ? <p className="empty">No participants</p> : null}
      <ul>
        {participants.map((participant) => (
          <li key={participant.peerId}>
            <span>{participant.displayName}</span>
            <span className="meta">
              {participant.role}
              {participant.peerId === currentPeerId ? " (you)" : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
