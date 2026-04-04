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
  const startedStatuses = new Set(["accepted", "transferring", "verifying"]);
  const rows = [];

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

      const startRecord = group.find((record) => startedStatuses.has(asString(record.status))) ?? group[0];
      const endRecord = group.find((record) => terminalStatuses.has(asString(record.status)));
      if (!startRecord || !endRecord) {
        continue;
      }

      const durationMs = Math.max(0, endRecord.__timestampMs - startRecord.__timestampMs);
      const fileSize = toNumber(endRecord.fileSize) ?? toNumber(startRecord.fileSize) ?? 0;
      const completed = asString(endRecord.status) === "completed";
      const throughputBytesPerSecond = completed && durationMs > 0 && fileSize > 0
        ? fileSize / (durationMs / 1000)
        : null;

      rows.push({
        runId: asString(endRecord.runId || startRecord.runId),
        peerFileId,
        transferId,
        direction: asString(endRecord.direction || startRecord.direction),
        fileId: asString(endRecord.fileId || startRecord.fileId),
        fileName: asString(endRecord.fileName || startRecord.fileName),
        fileSize,
        startAtMs: startRecord.__timestampMs,
        endAtMs: endRecord.__timestampMs,
        durationMs,
        endStatus: asString(endRecord.status),
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
  const transferSuccess = transferRows.filter((row) => row.endStatus === "completed").length;
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

  console.log(`Analyzed run directory: ${runDir}`);
  console.log(`Peer files processed: ${peerFiles.length}`);
  console.log(`Analysis output: ${analysisDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
