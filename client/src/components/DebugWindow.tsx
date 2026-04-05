import { useEffect, useRef } from "react";

interface DebugWindowProps {
  events: string[];
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
    <title>VIR Space Debug</title>
    <style>
      :root {
        color-scheme: light;
      }

      body {
        margin: 0;
        font-family: "Segoe UI Variable", "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        background: linear-gradient(180deg, #f5f8ff 0%, #eef3fb 100%);
        color: #16222d;
      }

      .debug-shell {
        display: grid;
        gap: 12px;
        min-height: 100vh;
        padding: 14px;
        box-sizing: border-box;
      }

      h1 {
        margin: 0;
        font-size: 1rem;
      }

      ul {
        margin: 0;
        padding-left: 18px;
        display: grid;
        gap: 6px;
        max-height: calc(100vh - 84px);
        overflow: auto;
      }

      li {
        color: #334d57;
        font-size: 0.9rem;
      }
    </style>
  </head>
  <body data-initialized="true">
    <section class="debug-shell">
      <h1>Debug Events</h1>
      <ul id="events-list"></ul>
    </section>
  </body>
</html>`);
    created.document.close();
  }

  return created;
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

export function DebugWindow({ events }: DebugWindowProps): null {
  const debugWindowRef = useRef<Window | null>(null);

  useEffect(() => {
    const debugWindow = ensureDebugWindow(debugWindowRef.current);
    if (!debugWindow) {
      return;
    }

    debugWindowRef.current = debugWindow;
    renderEvents(debugWindow, events);
  }, [events]);

  useEffect(() => {
    return () => {
      if (debugWindowRef.current && !debugWindowRef.current.closed) {
        debugWindowRef.current.close();
      }
    };
  }, []);

  return null;
}
