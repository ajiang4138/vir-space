import { useEffect, useRef, useState } from "react";
import type { WebRtcConnectionRoute } from "../lib/webrtc";
import { THEME_DEFAULTS } from "../theme/themeDefaults";

interface DebugRouteBadge {
  peerId: string;
  displayName: string;
  route: WebRtcConnectionRoute;
}

interface RelayConnectionProps {
  url: string;
  state: "connected" | "connecting" | "disconnected";
  connectedAtMs: number | null;
  serverStartedAtMs: number | null;
  serverLastSeenAtMs: number | null;
}

interface DebugWindowProps {
  events: string[];
  routeBadges: DebugRouteBadge[];
  relayConnection: RelayConnectionProps;
  onReconnect: () => void;
}

const debugWindowName = "vir-space-debug-window";

function ensureDebugWindow(target: Window | null): Window | null {
  if (target && !target.closed) {
    return target;
  }

  const created = window.open("", debugWindowName, "width=520,height=720,left=120,top=120,resizable=yes,scrollbars=yes");
  if (!created) {
    return null;
  }

  if (!created.document.body || created.document.body.dataset.initialized !== "true") {
    created.document.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>VIR Debug</title>
    <style>
      :root {
        color-scheme: light;
        --dbg-bg: ${THEME_DEFAULTS.debug.background};
        --dbg-text-primary: ${THEME_DEFAULTS.debug.textPrimary};
        --dbg-text-secondary: ${THEME_DEFAULTS.debug.textSecondary};
        --dbg-panel-bg: ${THEME_DEFAULTS.debug.panelBg};
        --dbg-panel-item-bg: ${THEME_DEFAULTS.debug.panelItemBg};
        --dbg-border-strong: ${THEME_DEFAULTS.debug.borderStrong};
        --dbg-border-soft: ${THEME_DEFAULTS.debug.borderSoft};
        --dbg-success-fg: ${THEME_DEFAULTS.debug.successFg};
        --dbg-success-bg: ${THEME_DEFAULTS.debug.successBg};
        --dbg-warning-fg: ${THEME_DEFAULTS.debug.warningFg};
        --dbg-warning-bg: ${THEME_DEFAULTS.debug.warningBg};
        --dbg-neutral-fg: ${THEME_DEFAULTS.debug.neutralFg};
        --dbg-neutral-bg: ${THEME_DEFAULTS.debug.neutralBg};
      }

      body {
        margin: 0;
        font-family: "Segoe UI Variable", "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        background: var(--dbg-bg);
        color: var(--dbg-text-primary);
      }

      .debug-shell {
        display: grid;
        gap: 14px;
        min-height: 100vh;
        padding: 14px;
        box-sizing: border-box;
      }

      h1 {
        margin: 0;
        font-size: 1rem;
      }

      .route-panel {
        background: var(--dbg-panel-bg);
        border: 1px solid var(--dbg-border-strong);
        border-radius: 10px;
        padding: 10px;
      }

      .route-list {
        margin: 8px 0 0;
        padding: 0;
        list-style: none;
        display: grid;
        gap: 8px;
      }

      .route-item {
        display: grid;
        gap: 4px;
        border: 1px solid var(--dbg-border-soft);
        border-radius: 8px;
        padding: 8px;
        background: var(--dbg-panel-item-bg);
      }

      .route-item-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .route-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        font-size: 0.75rem;
        font-weight: 700;
        padding: 3px 9px;
        letter-spacing: 0.02em;
      }

      .route-badge.direct {
        color: var(--dbg-success-fg);
        background: var(--dbg-success-bg);
      }

      .route-badge.relayed {
        color: var(--dbg-warning-fg);
        background: var(--dbg-warning-bg);
      }

      .route-badge.unknown {
        color: var(--dbg-neutral-fg);
        background: var(--dbg-neutral-bg);
      }

      .route-item small {
        color: var(--dbg-text-secondary);
        font-size: 0.78rem;
      }

      .events-list {
        margin: 0;
        padding-left: 18px;
        display: grid;
        gap: 6px;
        max-height: calc(100vh - 300px);
        overflow: auto;
      }

      .events-list li {
        color: var(--dbg-text-secondary);
        font-size: 0.9rem;
      }
    </style>
  </head>
  <body data-initialized="true">
    <section class="debug-shell">
      <section class="route-panel">
        <h1>Relay Connection</h1>
        <div id="relay-info" class="events-list" style="padding-top: 8px; padding-bottom: 8px; font-size: 0.9rem; color: var(--dbg-text-secondary);"></div>
      </section>

      <section class="route-panel">
        <h1>Connection Route</h1>
        <ul id="route-list" class="route-list"></ul>
      </section>

      <section class="route-panel">
        <h1>Debug Events</h1>
        <ul id="events-list" class="events-list"></ul>
      </section>
    </section>
  </body>
</html>`);
    created.document.close();
  }

  return created;
}

function renderRouteBadges(target: Window, routeBadges: DebugRouteBadge[]): void {
  const list = target.document.getElementById("route-list");
  if (!list) {
    return;
  }

  list.replaceChildren();

  if (routeBadges.length === 0) {
    const empty = target.document.createElement("li");
    empty.className = "route-item";
    empty.textContent = "No active peer connections.";
    list.appendChild(empty);
    return;
  }

  for (const badge of routeBadges) {
    const item = target.document.createElement("li");
    item.className = "route-item";

    const header = target.document.createElement("div");
    header.className = "route-item-header";

    const name = target.document.createElement("strong");
    name.textContent = badge.displayName;

    const routeBadge = target.document.createElement("span");
    routeBadge.className = `route-badge ${badge.route.kind}`;
    routeBadge.textContent = badge.route.kind === "direct"
      ? "Direct"
      : badge.route.kind === "relayed"
      ? "Relayed"
      : "Unknown";

    header.appendChild(name);
    header.appendChild(routeBadge);

    const details = target.document.createElement("small");
    const localType = badge.route.localCandidateType ?? "?";
    const remoteType = badge.route.remoteCandidateType ?? "?";
    const protocol = badge.route.protocol ?? "?";
    details.textContent = `local:${localType} remote:${remoteType} proto:${protocol}`;

    item.appendChild(header);
    item.appendChild(details);
    list.appendChild(item);
  }
}

function renderEvents(target: Window, events: string[]): void {
  const list = target.document.getElementById("events-list");
  if (!list) {
    return;
  }

  list.replaceChildren();

  if (events.length === 0) {
    const empty = target.document.createElement("li");
    empty.textContent = "Waiting for events...";
    list.appendChild(empty);
    return;
  }

  for (const event of events) {
    const item = target.document.createElement("li");
    item.textContent = event;
    list.appendChild(item);
  }

  list.scrollTop = list.scrollHeight;
}

function formatRelayAge(ageMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(ageMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function renderRelayConnection(
  target: Window,
  relay: RelayConnectionProps,
  onReconnect: () => void,
  nowMs: number
): void {
  const container = target.document.getElementById("relay-info");
  if (!container) return;

  const ageLabel = relay.connectedAtMs
    ? formatRelayAge(nowMs - relay.connectedAtMs)
    : "not connected";

  const uptimeLabel = relay.serverStartedAtMs
    ? formatRelayAge(nowMs - relay.serverStartedAtMs)
    : "unknown";

  const lastSeenLabel = relay.serverLastSeenAtMs
    ? new Date(relay.serverLastSeenAtMs).toLocaleTimeString()
    : "never";

  container.innerHTML = `
    <div style="margin-bottom: 4px;"><strong>Relay:</strong> ${relay.url || "-"} <button id="retry-relay-btn" style="margin-left: 8px; padding: 2px 6px; font-size: 0.85em; cursor: pointer; color: black;">Retry</button></div>
    <div style="margin-bottom: 4px;"><strong>State:</strong> ${relay.state === "connecting" ? "connecting…" : relay.state}</div>
    <div style="margin-bottom: 4px;"><strong>Age:</strong> ${relay.state === "connected" ? ageLabel : relay.state === "connecting" ? "connecting…" : "not connected"}</div>
    <div style="margin-bottom: 4px;"><strong>Server Uptime:</strong> ${uptimeLabel}</div>
    <div><strong>Server Last Seen:</strong> ${lastSeenLabel}</div>
  `;

  const btn = target.document.getElementById("retry-relay-btn");
  if (btn) {
    btn.onclick = onReconnect;
  }
}

export function DebugWindow({ events, routeBadges, relayConnection, onReconnect }: DebugWindowProps): null {
  const debugWindowRef = useRef<Window | null>(null);
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

  // Initialize debug window only once
  useEffect(() => {
    const debugWindow = ensureDebugWindow(debugWindowRef.current);
    if (!debugWindow) {
      return;
    }

    debugWindowRef.current = debugWindow;
  }, []);

  // Update window content whenever data changes
  useEffect(() => {
    const debugWindow = debugWindowRef.current;
    if (!debugWindow || debugWindow.closed) {
      return;
    }

    renderRouteBadges(debugWindow, routeBadges);
    renderEvents(debugWindow, events);
    renderRelayConnection(debugWindow, relayConnection, onReconnect, nowMs);
  }, [events, routeBadges, relayConnection, nowMs, onReconnect]);

  useEffect(() => {
    return () => {
      if (debugWindowRef.current && !debugWindowRef.current.closed) {
        debugWindowRef.current.close();
      }
    };
  }, []);

  return null;
}
