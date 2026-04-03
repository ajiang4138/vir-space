interface DebugLogProps {
  events: string[];
}

export function DebugLog({ events }: DebugLogProps): JSX.Element {
  return (
    <section className="card debug-log">
      <h2>Debug Events</h2>
      <ul>
        {events.length === 0 ? <li>Waiting for events...</li> : null}
        {events.map((entry, index) => (
          <li key={`${entry}-${index}`}>{entry}</li>
        ))}
      </ul>
    </section>
  );
}
