import { useEffect, useState } from "react";

interface DebugLogProps {
  events: string[];
  relayConnection: {
    url: string;
    state: "connected" | "connecting" | "disconnected";
    connectedAtMs: number | null;
    serverStartedAtMs: number | null;
    serverLastSeenAtMs: number | null;
    serverConnectedClients: number | null;
    serverRelayListings: number | null;
  };
  onReconnect: () => void;
}

function formatRelayAge(ageMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(ageMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

export function DebugLog({ events, relayConnection, onReconnect }: DebugLogProps): JSX.Element {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (
      (!relayConnection.connectedAtMs || relayConnection.state !== "connected")
      && !relayConnection.serverStartedAtMs
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [relayConnection.connectedAtMs, relayConnection.state]);

  const ageLabel = relayConnection.connectedAtMs
    ? formatRelayAge(nowMs - relayConnection.connectedAtMs)
    : "not connected";

  const relayServerUptimeLabel = relayConnection.serverStartedAtMs
    ? formatRelayAge(nowMs - relayConnection.serverStartedAtMs)
    : "unknown";

  const relayServerLastSeenLabel = relayConnection.serverLastSeenAtMs
    ? new Date(relayConnection.serverLastSeenAtMs).toLocaleTimeString()
    : "never";

  return (
    <section className="card debug-log">
      <h2>Debug Events</h2>
      <div className="relay-debug">
        <p>
          <strong>Relay:</strong> {relayConnection.url || "-"}
          <button
            type="button"
            className="text-button"
            style={{ marginLeft: "1rem", padding: "0.2rem 0.5rem", fontSize: "0.85em" }}
            onClick={onReconnect}
          >
            Retry Relay
          </button>
        </p>
        <p><strong>State:</strong> {relayConnection.state === "connecting" ? "connecting…" : relayConnection.state}</p>
        <p><strong>Age:</strong> {relayConnection.state === "connected" ? ageLabel : relayConnection.state === "connecting" ? "connecting…" : "not connected"}</p>
        <p><strong>Server Uptime:</strong> {relayServerUptimeLabel}</p>
        <p><strong>Server Last Seen:</strong> {relayServerLastSeenLabel}</p>
        <p><strong>Connected Clients:</strong> {relayConnection.serverConnectedClients ?? "unknown"}</p>
        <p><strong>Relay Listings:</strong> {relayConnection.serverRelayListings ?? "unknown"}</p>
      </div>
      <ul>
        {events.length === 0 ? <li>Waiting for events...</li> : null}
        {events.map((entry, index) => (
          <li key={`${entry}-${index}`}>{entry}</li>
        ))}
      </ul>
    </section>
  );
}
