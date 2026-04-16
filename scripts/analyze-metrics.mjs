#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

function usage() {
  console.log("Usage: node scripts/analyze-metrics.mjs <run-id-or-run-dir>");
  console.log("Examples:");
  console.log("  node scripts/analyze-metrics.mjs room-cs6675-demo");
  console.log("  node scripts/analyze-metrics.mjs .metrics/room-cs6675-demo");
}

function toTimestamp(record) {
  if (typeof record.timestampMs === "number") {
    return record.timestampMs;
  }
  if (typeof record.loggedAtMs === "number") {
    return record.loggedAtMs;
  }
  return null;
}

function toNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function buildStats(values) {
  const cleaned = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (cleaned.length === 0) {
    return null;
  }

  const sum = cleaned.reduce((accumulator, value) => accumulator + value, 0);
  const p50Index = Math.floor(0.5 * (cleaned.length - 1));
  const p95Index = Math.floor(0.95 * (cleaned.length - 1));

  return {
    count: cleaned.length,
    min: cleaned[0],
    max: cleaned[cleaned.length - 1],
    mean: sum / cleaned.length,
    p50: cleaned[p50Index],
    p95: cleaned[p95Index],
  };
}

function csvEscape(raw) {
  const value = String(raw ?? "");
  if (!/[",\n]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows) {
  if (rows.length === 0) {
    return "";
  }

  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  }

  return `${lines.join("\n")}\n`;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shortLabel(value, maxLength = 20) {
  const text = asString(value);
  if (!text) {
    return "-";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}...`;
}

function formatNumber(value, maximumFractionDigits = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }

  return value.toLocaleString(undefined, { maximumFractionDigits });
}

function formatPercent(value, maximumFractionDigits = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }

  return `${value.toLocaleString(undefined, { maximumFractionDigits })}%`;
}

function buildNoDataSvg(title, message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="320" viewBox="0 0 960 320" role="img" aria-label="${escapeXml(title)}">
  <rect width="960" height="320" fill="#ffffff" />
  <text x="28" y="46" fill="#0f172a" font-family="Arial, sans-serif" font-size="26" font-weight="700">${escapeXml(title)}</text>
  <rect x="28" y="72" width="904" height="220" rx="12" fill="#f8fafc" stroke="#cbd5e1" />
  <text x="480" y="188" fill="#475569" text-anchor="middle" font-family="Arial, sans-serif" font-size="18">${escapeXml(message)}</text>
</svg>
`;
}

function buildBarChartSvg({
  title,
  subtitle = "",
  labels,
  values,
  yAxisLabel,
  color = "#2563eb",
  colors = [],
  maxBars = 40,
  decimals = 2,
}) {
  const pairs = [];
  const maxLength = Math.max(labels.length, values.length);

  for (let index = 0; index < maxLength; index += 1) {
    const numericValue = toNumber(values[index]);
    if (numericValue === null || numericValue < 0) {
      continue;
    }

    pairs.push({
      label: asString(labels[index]) || `#${index + 1}`,
      value: numericValue,
      color: asString(colors[index]) || color,
    });
  }

  if (pairs.length === 0) {
    return buildNoDataSvg(title, "No data points were available for this chart.");
  }

  const displayed = pairs.slice(0, maxBars);
  const truncated = pairs.length > displayed.length;

  const width = 1200;
  const height = 500;
  const margin = {
    top: 74,
    right: 28,
    bottom: 170,
    left: 92,
  };

  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  const rawMaxValue = Math.max(...displayed.map((point) => point.value));
  const yMax = rawMaxValue > 0 ? rawMaxValue * 1.1 : 1;
  const slotWidth = chartWidth / displayed.length;
  const barWidth = Math.max(5, Math.min(40, slotWidth * 0.72));
  const tickCount = 5;

  const gridLines = [];
  for (let tick = 0; tick <= tickCount; tick += 1) {
    const ratio = tick / tickCount;
    const y = margin.top + ratio * chartHeight;
    const tickValue = yMax * (1 - ratio);
    gridLines.push(
      `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#e2e8f0" stroke-width="1" />`,
    );
    gridLines.push(
      `<text x="${margin.left - 10}" y="${y + 5}" fill="#64748b" text-anchor="end" font-family="Arial, sans-serif" font-size="12">${escapeXml(formatNumber(tickValue, decimals))}</text>`,
    );
  }

  const bars = displayed.map((point, index) => {
    const barHeight = (point.value / yMax) * chartHeight;
    const x = margin.left + index * slotWidth + (slotWidth - barWidth) / 2;
    const y = margin.top + chartHeight - barHeight;
    return `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${escapeXml(point.color)}" opacity="0.9" rx="2" />`;
  });

  const labelBaselineY = margin.top + chartHeight + 20;
  const labelsSvg = displayed.map((point, index) => {
    const x = margin.left + index * slotWidth + slotWidth / 2;
    const label = escapeXml(shortLabel(point.label, 24));
    return `<text x="${x}" y="${labelBaselineY}" fill="#334155" text-anchor="start" transform="rotate(42 ${x} ${labelBaselineY})" font-family="Arial, sans-serif" font-size="11">${label}</text>`;
  });

  const valuesSvg = displayed.length <= 20
    ? displayed.map((point, index) => {
      const barHeight = (point.value / yMax) * chartHeight;
      const x = margin.left + index * slotWidth + slotWidth / 2;
      const y = margin.top + chartHeight - barHeight - 6;
      return `<text x="${x}" y="${y}" fill="#1e293b" text-anchor="middle" font-family="Arial, sans-serif" font-size="11">${escapeXml(formatNumber(point.value, decimals))}</text>`;
    })
    : [];

  const suffix = truncated ? ` (showing first ${displayed.length} of ${pairs.length})` : "";
  const subtitleText = subtitle || `${displayed.length} data points${suffix}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
  <rect width="${width}" height="${height}" fill="#ffffff" />
  <text x="${margin.left}" y="38" fill="#0f172a" font-family="Arial, sans-serif" font-size="26" font-weight="700">${escapeXml(title)}</text>
  <text x="${margin.left}" y="60" fill="#64748b" font-family="Arial, sans-serif" font-size="14">${escapeXml(subtitleText)}</text>
  ${gridLines.join("\n  ")}
  <line x1="${margin.left}" y1="${margin.top + chartHeight}" x2="${width - margin.right}" y2="${margin.top + chartHeight}" stroke="#64748b" stroke-width="1.2" />
  <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + chartHeight}" stroke="#64748b" stroke-width="1.2" />
  <text x="22" y="${margin.top + chartHeight / 2}" fill="#334155" text-anchor="middle" transform="rotate(-90 22 ${margin.top + chartHeight / 2})" font-family="Arial, sans-serif" font-size="13">${escapeXml(yAxisLabel)}</text>
  ${bars.join("\n  ")}
  ${labelsSvg.join("\n  ")}
  ${valuesSvg.join("\n  ")}
</svg>
`;
}

function downsampleValues(values, maxPoints) {
  if (values.length <= maxPoints) {
    return {
      values,
      downsampled: false,
    };
  }

  const bucketSize = values.length / maxPoints;
  const next = [];

  for (let index = 0; index < maxPoints; index += 1) {
    const start = Math.floor(index * bucketSize);
    const end = Math.max(start + 1, Math.floor((index + 1) * bucketSize));
    const bucket = values.slice(start, end);
    const sum = bucket.reduce((accumulator, value) => accumulator + value, 0);
    next.push(sum / bucket.length);
  }

  return {
    values: next,
    downsampled: true,
  };
}

function buildLineChartSvg({
  title,
  subtitle = "",
  values,
  yAxisLabel,
  color = "#0f766e",
  maxPoints = 300,
  decimals = 2,
}) {
  const cleaned = values
    .map((value) => toNumber(value))
    .filter((value) => value !== null)
    .map((value) => value);

  if (cleaned.length === 0) {
    return buildNoDataSvg(title, "No data points were available for this chart.");
  }

  const sampled = downsampleValues(cleaned, maxPoints);
  const chartValues = sampled.values;

  const width = 1200;
  const height = 460;
  const margin = {
    top: 74,
    right: 28,
    bottom: 86,
    left: 92,
  };

  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  const rawMaxValue = Math.max(...chartValues);
  const yMax = rawMaxValue > 0 ? rawMaxValue * 1.1 : 1;

  const points = chartValues.map((value, index) => {
    const x = margin.left + (chartValues.length === 1 ? chartWidth / 2 : (index / (chartValues.length - 1)) * chartWidth);
    const y = margin.top + chartHeight - (value / yMax) * chartHeight;
    return {
      x,
      y,
      value,
    };
  });

  const tickCount = 5;
  const gridLines = [];
  for (let tick = 0; tick <= tickCount; tick += 1) {
    const ratio = tick / tickCount;
    const y = margin.top + ratio * chartHeight;
    const tickValue = yMax * (1 - ratio);
    gridLines.push(
      `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#e2e8f0" stroke-width="1" />`,
    );
    gridLines.push(
      `<text x="${margin.left - 10}" y="${y + 5}" fill="#64748b" text-anchor="end" font-family="Arial, sans-serif" font-size="12">${escapeXml(formatNumber(tickValue, decimals))}</text>`,
    );
  }

  const pathD = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");

  const circles = points.length <= 80
    ? points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="2.5" fill="${escapeXml(color)}" />`)
    : [];

  const subtitleText = subtitle || `${cleaned.length} samples${sampled.downsampled ? ` (downsampled to ${chartValues.length})` : ""}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
  <rect width="${width}" height="${height}" fill="#ffffff" />
  <text x="${margin.left}" y="38" fill="#0f172a" font-family="Arial, sans-serif" font-size="26" font-weight="700">${escapeXml(title)}</text>
  <text x="${margin.left}" y="60" fill="#64748b" font-family="Arial, sans-serif" font-size="14">${escapeXml(subtitleText)}</text>
  ${gridLines.join("\n  ")}
  <line x1="${margin.left}" y1="${margin.top + chartHeight}" x2="${width - margin.right}" y2="${margin.top + chartHeight}" stroke="#64748b" stroke-width="1.2" />
  <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + chartHeight}" stroke="#64748b" stroke-width="1.2" />
  <text x="22" y="${margin.top + chartHeight / 2}" fill="#334155" text-anchor="middle" transform="rotate(-90 22 ${margin.top + chartHeight / 2})" font-family="Arial, sans-serif" font-size="13">${escapeXml(yAxisLabel)}</text>
  <text x="${margin.left + chartWidth / 2}" y="${height - 20}" fill="#334155" text-anchor="middle" font-family="Arial, sans-serif" font-size="13">Sample index</text>
  <path d="${pathD}" fill="none" stroke="${escapeXml(color)}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
  ${circles.join("\n  ")}
</svg>
`;
}

function buildDashboardHtml(summary) {
  const roomLatencyP95 = summary.roomFlows.latencyMs ? `${formatNumber(summary.roomFlows.latencyMs.p95, 2)} ms` : "n/a";
  const transferDurationP95 = summary.transfers.durationMs ? `${formatNumber(summary.transfers.durationMs.p95, 2)} ms` : "n/a";
  const workspaceRttP95 = summary.workspaceRtt.rttMs ? `${formatNumber(summary.workspaceRtt.rttMs.p95, 2)} ms` : "n/a";
  const resyncP95 = summary.resync.resyncMs ? `${formatNumber(summary.resync.resyncMs.p95, 2)} ms` : "n/a";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Metrics Dashboard</title>
    <style>
      :root {
        color-scheme: light;
      }

      body {
        margin: 24px;
        font-family: Arial, sans-serif;
        color: #0f172a;
        background: #f8fafc;
      }

      h1 {
        margin: 0;
        font-size: 28px;
      }

      .subtle {
        margin-top: 6px;
        color: #64748b;
      }

      .cards {
        margin-top: 20px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
      }

      .card {
        background: #ffffff;
        border: 1px solid #dbe3ee;
        border-radius: 10px;
        padding: 14px;
      }

      .card h2 {
        margin: 0;
        font-size: 14px;
        color: #334155;
      }

      .card .value {
        margin-top: 8px;
        font-size: 24px;
        font-weight: 700;
      }

      .charts {
        margin-top: 20px;
        display: grid;
        grid-template-columns: 1fr;
        gap: 14px;
      }

      .chart-card {
        background: #ffffff;
        border: 1px solid #dbe3ee;
        border-radius: 10px;
        padding: 12px;
      }

      .chart-card img {
        width: 100%;
        height: auto;
        display: block;
      }

      code {
        background: #e2e8f0;
        padding: 1px 6px;
        border-radius: 6px;
      }
    </style>
  </head>
  <body>
    <h1>Metrics Dashboard</h1>
    <p class="subtle">Generated at ${escapeXml(summary.generatedAtIso)}. Raw outputs are in this folder as CSV and JSON files.</p>

    <section class="cards">
      <article class="card">
        <h2>Room Flow Success</h2>
        <div class="value">${escapeXml(formatPercent(summary.roomFlows.successRatePercent, 1))}</div>
        <p class="subtle">p95 latency: ${escapeXml(roomLatencyP95)}</p>
      </article>
      <article class="card">
        <h2>Transfer Completion</h2>
        <div class="value">${escapeXml(formatPercent(summary.transfers.completionRatePercent, 1))}</div>
        <p class="subtle">p95 duration: ${escapeXml(transferDurationP95)}</p>
      </article>
      <article class="card">
        <h2>Workspace RTT</h2>
        <div class="value">${escapeXml(workspaceRttP95)}</div>
        <p class="subtle">total samples: ${escapeXml(formatNumber(summary.workspaceRtt.total, 0))}</p>
      </article>
      <article class="card">
        <h2>Resync Convergence</h2>
        <div class="value">${escapeXml(formatPercent(summary.resync.convergenceRatePercent, 1))}</div>
        <p class="subtle">p95 resync: ${escapeXml(resyncP95)}</p>
      </article>
    </section>

    <section class="charts">
      <article class="chart-card"><img src="./room_latency_bar.svg" alt="Room latency chart" /></article>
      <article class="chart-card"><img src="./workspace_rtt_timeline.svg" alt="Workspace RTT timeline chart" /></article>
      <article class="chart-card"><img src="./transfer_duration_bar.svg" alt="Transfer duration chart" /></article>
      <article class="chart-card"><img src="./transfer_throughput_bar.svg" alt="Transfer throughput chart" /></article>
      <article class="chart-card"><img src="./resync_bar.svg" alt="Resync chart" /></article>
    </section>

    <p class="subtle">Open this dashboard file directly: <code>analysis/metrics_dashboard.html</code></p>
  </body>
</html>
`;
}

async function writeGraphArtifacts(analysisDir, roomRows, transferRows, workspaceRttRows, resyncRows, summary) {
  const roomLabels = roomRows.map((row, index) => `${row.intent || "flow"}-${row.outcomeType || "outcome"}-${index + 1}`);
  const roomValues = roomRows.map((row) => row.latencyMs);

  const transferDurationRows = transferRows.filter((row) => Number.isFinite(row.durationMs));
  const transferDurationLabels = transferDurationRows.map((row, index) =>
    `${shortLabel(row.fileName || row.transferId, 14)}-${index + 1}`,
  );
  const transferDurationValues = transferDurationRows.map((row) => row.durationMs);

  const throughputRows = transferRows.filter((row) => Number.isFinite(row.throughputMiBPerSecond));
  const throughputLabels = throughputRows.map((row, index) => `${shortLabel(row.fileName || row.transferId, 14)}-${index + 1}`);
  const throughputValues = throughputRows.map((row) => row.throughputMiBPerSecond);

  const resyncLabels = resyncRows.map((row, index) => `${row.disruptionType || "disruption"}-${index + 1}`);
  const resyncValues = resyncRows.map((row) => (row.resyncMs === null ? 0 : row.resyncMs));
  const resyncColors = resyncRows.map((row) => (row.converged ? "#16a34a" : "#dc2626"));

  const roomLatencySvg = buildBarChartSvg({
    title: "Room Flow Latency",
    labels: roomLabels,
    values: roomValues,
    yAxisLabel: "Latency (ms)",
    color: "#2563eb",
    maxBars: 50,
    decimals: 0,
  });

  const workspaceRttSvg = buildLineChartSvg({
    title: "Workspace Update RTT Timeline",
    subtitle: workspaceRttRows.length > 0 ? `${workspaceRttRows.length} total RTT samples` : "",
    values: workspaceRttRows.map((row) => row.rttMs),
    yAxisLabel: "RTT (ms)",
    color: "#0f766e",
    maxPoints: 300,
    decimals: 2,
  });

  const transferDurationSvg = buildBarChartSvg({
    title: "Transfer Duration",
    labels: transferDurationLabels,
    values: transferDurationValues,
    yAxisLabel: "Duration (ms)",
    color: "#0ea5e9",
    maxBars: 40,
    decimals: 0,
  });

  const transferThroughputSvg = buildBarChartSvg({
    title: "Transfer Throughput",
    labels: throughputLabels,
    values: throughputValues,
    yAxisLabel: "Throughput (MiB/s)",
    color: "#7c3aed",
    maxBars: 40,
    decimals: 3,
  });

  const resyncSvg = buildBarChartSvg({
    title: "Resync Time By Disruption",
    subtitle: "Green bars converged. Red bars did not converge (rendered as 0 ms).",
    labels: resyncLabels,
    values: resyncValues,
    yAxisLabel: "Resync (ms)",
    color: "#16a34a",
    colors: resyncColors,
    maxBars: 40,
    decimals: 0,
  });

  const dashboardHtml = buildDashboardHtml(summary);

  await fs.writeFile(path.join(analysisDir, "room_latency_bar.svg"), roomLatencySvg, "utf8");
  await fs.writeFile(path.join(analysisDir, "workspace_rtt_timeline.svg"), workspaceRttSvg, "utf8");
  await fs.writeFile(path.join(analysisDir, "transfer_duration_bar.svg"), transferDurationSvg, "utf8");
  await fs.writeFile(path.join(analysisDir, "transfer_throughput_bar.svg"), transferThroughputSvg, "utf8");
  await fs.writeFile(path.join(analysisDir, "resync_bar.svg"), resyncSvg, "utf8");
  await fs.writeFile(path.join(analysisDir, "metrics_dashboard.html"), dashboardHtml, "utf8");
}

async function readNdjson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const rows = [];

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed);
      const timestampMs = toTimestamp(parsed);
      if (timestampMs === null) {
        continue;
      }

      rows.push({
        ...parsed,
        __timestampMs: timestampMs,
      });
    } catch {
      // Ignore malformed lines so one bad entry does not break the report.
    }
  }

  rows.sort((left, right) => left.__timestampMs - right.__timestampMs);
  return rows;
}

async function resolveRunDirectory(input) {
  const cwd = process.cwd();
  const directPath = path.resolve(cwd, input);
  const hiddenMetricsPath = path.resolve(cwd, ".metrics", input);
  const legacyClientDistMetricsPath = path.resolve(cwd, "client", "dist-electron", ".metrics", input);

  for (const candidate of [directPath, hiddenMetricsPath, legacyClientDistMetricsPath]) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // continue
    }
  }

  throw new Error(`Run directory not found for input: ${input}`);
}

function buildRoomLatencyRows(recordsByPeer) {
  const outcomeTypes = new Set(["room_created", "room_joined", "room_action_error"]);
  const rows = [];

  for (const [peerFileId, records] of recordsByPeer.entries()) {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.eventType !== "room_flow_submit") {
        continue;
      }

      let outcome = null;
      for (let lookahead = index + 1; lookahead < records.length; lookahead += 1) {
        const candidate = records[lookahead];
        if (outcomeTypes.has(candidate.eventType)) {
          outcome = candidate;
          break;
        }
      }

      if (!outcome) {
        continue;
      }

      const latencyMs = outcome.__timestampMs - record.__timestampMs;
      rows.push({
        runId: asString(record.runId),
        peerFileId,
        intent: asString(record.intent),
        roomId: asString(record.roomId),
        submittedAtMs: record.__timestampMs,
        outcomeAtMs: outcome.__timestampMs,
        latencyMs,
        success: outcome.eventType === "room_created" || outcome.eventType === "room_joined",
        outcomeType: outcome.eventType,
        errorCode: asString(outcome.errorCode),
      });
    }
  }

  return rows;
}

function buildTransferRows(recordsByPeer) {
  const terminalStatuses = new Set(["completed", "failed", "cancelled", "declined"]);
  const startedStatuses = new Set(["accepted", "transferring", "downloading", "verifying", "seeding", "partial-seeding"]);
  const rows = [];

  const pickDirectionGroup = (group) => {
    const downloadGroup = group.filter((record) => asString(record.direction) === "download");
    if (downloadGroup.length > 0) {
      return { direction: "download", records: downloadGroup };
    }

    const uploadGroup = group.filter((record) => asString(record.direction) === "upload");
    if (uploadGroup.length > 0) {
      return { direction: "upload", records: uploadGroup };
    }

    return {
      direction: asString(group[0]?.direction),
      records: group,
    };
  };

  const isProgressComplete = (record, fileSize) => {
    const progress = toNumber(record.progress);
    if (progress !== null && progress >= 1) {
      return true;
    }

    const transferredBytes = toNumber(record.transferredBytes);
    return fileSize > 0 && transferredBytes !== null && transferredBytes >= fileSize;
  };

  for (const [peerFileId, records] of recordsByPeer.entries()) {
    const transferGroups = new Map();

    for (const record of records) {
      if (record.eventType !== "transfer_status") {
        continue;
      }

      const transferId = asString(record.transferId);
      if (!transferId) {
        continue;
      }

      const group = transferGroups.get(transferId) ?? [];
      group.push(record);
      transferGroups.set(transferId, group);
    }

    for (const [transferId, group] of transferGroups.entries()) {
      group.sort((left, right) => left.__timestampMs - right.__timestampMs);

      const { direction, records: directionRecords } = pickDirectionGroup(group);
      if (directionRecords.length === 0) {
        continue;
      }

      const fileSizeHint = Math.max(
        ...directionRecords.map((record) => toNumber(record.fileSize) ?? 0),
      );

      const startRecord = directionRecords.find((record) => startedStatuses.has(asString(record.status))) ?? directionRecords[0];
      const reverseRecords = [...directionRecords].reverse();
      let endRecord = reverseRecords.find((record) => terminalStatuses.has(asString(record.status)));
      if (!endRecord) {
        endRecord = reverseRecords.find((record) => isProgressComplete(record, fileSizeHint));
      }
      if (!endRecord && direction === "download") {
        endRecord = reverseRecords.find((record) => asString(record.status) === "verifying");
      }
      endRecord = endRecord ?? directionRecords[directionRecords.length - 1];

      if (!startRecord || !endRecord) {
        continue;
      }

      const durationMs = Math.max(0, endRecord.__timestampMs - startRecord.__timestampMs);
      const fileSize = toNumber(endRecord.fileSize) ?? toNumber(startRecord.fileSize) ?? fileSizeHint;
      const endStatus = asString(endRecord.status);
      const completed = endStatus === "completed"
        || (direction === "download" && (endStatus === "verifying" || isProgressComplete(endRecord, fileSize)));
      const throughputBytesPerSecond = completed && durationMs > 0 && fileSize > 0
        ? fileSize / (durationMs / 1000)
        : null;

      rows.push({
        runId: asString(endRecord.runId || startRecord.runId),
        peerFileId,
        transferId,
        direction: asString(startRecord.direction || endRecord.direction),
        fileId: asString(endRecord.fileId || startRecord.fileId),
        fileName: asString(endRecord.fileName || startRecord.fileName),
        fileSize,
        startAtMs: startRecord.__timestampMs,
        endAtMs: endRecord.__timestampMs,
        durationMs,
        completed,
        endStatus,
        throughputBytesPerSecond,
        throughputMiBPerSecond: throughputBytesPerSecond === null ? null : throughputBytesPerSecond / 1048576,
      });
    }
  }

  return rows;
}

function buildWorkspaceRttRows(recordsByPeer) {
  const rows = [];

  for (const [peerFileId, records] of recordsByPeer.entries()) {
    for (const record of records) {
      if (record.eventType !== "workspace_update_rtt") {
        continue;
      }

      const rttMs = toNumber(record.rttMs);
      if (rttMs === null) {
        continue;
      }

      rows.push({
        runId: asString(record.runId),
        peerFileId,
        metricMessageId: asString(record.metricMessageId),
        sourceType: asString(record.sourceType),
        ackSourceType: asString(record.ackSourceType),
        remotePeerId: asString(record.remotePeerId),
        rttMs,
        estimatedOneWayMs: rttMs / 2,
        recordedAtMs: record.__timestampMs,
      });
    }
  }

  return rows;
}

function buildResyncRows(recordsByPeer) {
  const disruptions = [];
  const snapshots = [];

  for (const [peerFileId, records] of recordsByPeer.entries()) {
    for (const record of records) {
      if (record.eventType === "room_state_snapshot") {
        snapshots.push({
          peerFileId,
          timestampMs: record.__timestampMs,
          roomId: asString(record.roomId),
          participantCount: toNumber(record.participantCount),
          roomStatus: asString(record.roomStatus),
        });
      }

      if (record.eventType === "participant_joined" || record.eventType === "participant_left") {
        disruptions.push({
          eventType: record.eventType,
          timestampMs: record.__timestampMs,
          roomId: asString(record.roomId),
          targetParticipantCount: toNumber(record.participantCount),
          participantPeerId: asString(record.participantPeerId),
        });
      }
    }
  }

  const peers = Array.from(recordsByPeer.keys());
  const rows = [];

  for (const disruption of disruptions) {
    if (disruption.targetParticipantCount === null || !disruption.roomId) {
      continue;
    }

    const convergedAtByPeer = [];
    for (const peer of peers) {
      const firstMatch = snapshots.find((snapshot) =>
        snapshot.peerFileId === peer
        && snapshot.roomId === disruption.roomId
        && snapshot.timestampMs >= disruption.timestampMs
        && snapshot.roomStatus === "open"
        && snapshot.participantCount === disruption.targetParticipantCount,
      );

      if (!firstMatch) {
        convergedAtByPeer.length = 0;
        break;
      }

      convergedAtByPeer.push(firstMatch.timestampMs);
    }

    if (convergedAtByPeer.length !== peers.length) {
      rows.push({
        roomId: disruption.roomId,
        disruptionType: disruption.eventType,
        participantPeerId: disruption.participantPeerId,
        disruptionAtMs: disruption.timestampMs,
        targetParticipantCount: disruption.targetParticipantCount,
        converged: false,
        resyncMs: null,
      });
      continue;
    }

    const convergedAtMs = Math.max(...convergedAtByPeer);
    rows.push({
      roomId: disruption.roomId,
      disruptionType: disruption.eventType,
      participantPeerId: disruption.participantPeerId,
      disruptionAtMs: disruption.timestampMs,
      targetParticipantCount: disruption.targetParticipantCount,
      converged: true,
      resyncMs: Math.max(0, convergedAtMs - disruption.timestampMs),
    });
  }

  return rows;
}

function computeSummary(roomRows, transferRows, workspaceRttRows, resyncRows) {
  const roomLatencies = roomRows.map((row) => row.latencyMs);
  const transferDurations = transferRows.map((row) => row.durationMs);
  const throughputValues = transferRows
    .map((row) => row.throughputBytesPerSecond)
    .filter((value) => value !== null);
  const workspaceRtts = workspaceRttRows.map((row) => row.rttMs);
  const resyncTimes = resyncRows
    .filter((row) => row.converged && row.resyncMs !== null)
    .map((row) => row.resyncMs);

  const roomSuccess = roomRows.filter((row) => row.success).length;
  const transferSuccess = transferRows.filter((row) => row.completed).length;
  const resyncSuccess = resyncRows.filter((row) => row.converged).length;

  return {
    generatedAtIso: new Date().toISOString(),
    roomFlows: {
      total: roomRows.length,
      success: roomSuccess,
      successRatePercent: roomRows.length > 0 ? (roomSuccess / roomRows.length) * 100 : 0,
      latencyMs: buildStats(roomLatencies),
    },
    transfers: {
      total: transferRows.length,
      completed: transferSuccess,
      completionRatePercent: transferRows.length > 0 ? (transferSuccess / transferRows.length) * 100 : 0,
      durationMs: buildStats(transferDurations),
      throughputBytesPerSecond: buildStats(throughputValues),
    },
    workspaceRtt: {
      total: workspaceRttRows.length,
      rttMs: buildStats(workspaceRtts),
      estimatedOneWayMs: buildStats(workspaceRtts.map((value) => value / 2)),
    },
    resync: {
      disruptions: resyncRows.length,
      converged: resyncSuccess,
      convergenceRatePercent: resyncRows.length > 0 ? (resyncSuccess / resyncRows.length) * 100 : 0,
      resyncMs: buildStats(resyncTimes),
    },
  };
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    usage();
    process.exit(1);
  }

  const runDir = await resolveRunDirectory(input);
  const children = await fs.readdir(runDir, { withFileTypes: true });
  const peerFiles = children
    .filter((entry) => entry.isFile() && entry.name.startsWith("peer_") && entry.name.endsWith(".ndjson"))
    .map((entry) => path.join(runDir, entry.name));

  if (peerFiles.length === 0) {
    throw new Error(`No peer_*.ndjson files found in ${runDir}`);
  }

  const recordsByPeer = new Map();
  for (const filePath of peerFiles) {
    const peerFileId = path.basename(filePath).replace(/^peer_/, "").replace(/\.ndjson$/, "");
    const records = await readNdjson(filePath);
    recordsByPeer.set(peerFileId, records);
  }

  const roomRows = buildRoomLatencyRows(recordsByPeer);
  const transferRows = buildTransferRows(recordsByPeer);
  const workspaceRttRows = buildWorkspaceRttRows(recordsByPeer);
  const resyncRows = buildResyncRows(recordsByPeer);
  const summary = computeSummary(roomRows, transferRows, workspaceRttRows, resyncRows);

  const analysisDir = path.join(runDir, "analysis");
  await fs.mkdir(analysisDir, { recursive: true });

  await fs.writeFile(path.join(analysisDir, "room_latency.csv"), rowsToCsv(roomRows), "utf8");
  await fs.writeFile(path.join(analysisDir, "transfer_metrics.csv"), rowsToCsv(transferRows), "utf8");
  await fs.writeFile(path.join(analysisDir, "workspace_rtt.csv"), rowsToCsv(workspaceRttRows), "utf8");
  await fs.writeFile(path.join(analysisDir, "resync_metrics.csv"), rowsToCsv(resyncRows), "utf8");
  await fs.writeFile(path.join(analysisDir, "metrics_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeGraphArtifacts(analysisDir, roomRows, transferRows, workspaceRttRows, resyncRows, summary);

  console.log(`Analyzed run directory: ${runDir}`);
  console.log(`Peer files processed: ${peerFiles.length}`);
  console.log(`Analysis output: ${analysisDir}`);
  console.log(`Dashboard output: ${path.join(analysisDir, "metrics_dashboard.html")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
