import { ParticipantSummary } from "../types";

interface ParticipantListProps {
  participants: ParticipantSummary[];
  currentPeerId: string;
}

export function ParticipantList({ participants, currentPeerId }: ParticipantListProps): JSX.Element {
  return (
    <section className="card participant-list">
      <h2>Participants</h2>
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
