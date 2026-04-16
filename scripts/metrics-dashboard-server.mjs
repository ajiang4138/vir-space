#!/usr/bin/env node

import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

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

function formatNumber(value, maximumFractionDigits = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }

  return value.toLocaleString(undefined, { maximumFractionDigits });
}

function isMeaningfulThroughputMiB(value, decimals = 3) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return false;
  }

  // Drop samples that render as 0 at chart precision; these are often tiny-file artifacts.
  return Number(value.toFixed(decimals)) > 0;
}

function includeThroughputInAnalytics(row, decimals = 3) {
  if (!row || typeof row !== "object") {
    return false;
  }

  const throughputMiB = toNumber(row.throughputMiBPerSecond);
  if (!isMeaningfulThroughputMiB(throughputMiB, decimals)) {
    return false;
  }

  const fileName = asString(row.fileName).toLowerCase();
  // Exclude tiny CleanShot artifacts from throughput trend and stats.
  if (fileName.includes("cleanshot")) {
    return false;
  }

  return true;
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
  showTrendLine = false,
  trendLineColor = "#0f172a",
  showMedianLine = false,
  medianValue = null,
  stats = null,
  valueUnit = "ms",
  xAxisLabel = "Sample index",
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
  const statsFromData = stats && typeof stats === "object"
    ? stats
    : buildStats(displayed.map((point) => point.value));
  const unitSuffix = asString(valueUnit).trim();
  const withUnit = (value) => unitSuffix
    ? `${formatNumber(value, decimals)} ${unitSuffix}`
    : formatNumber(value, decimals);

  const referenceLegendEntries = [];
  if (statsFromData) {
    if (Number.isFinite(statsFromData.min)) {
      referenceLegendEntries.push({
        color: "#16a34a",
        text: `Min: ${withUnit(statsFromData.min)}`,
      });
    }
    if (Number.isFinite(statsFromData.max)) {
      referenceLegendEntries.push({
        color: "#dc2626",
        text: `Max: ${withUnit(statsFromData.max)}`,
      });
    }
    if (Number.isFinite(statsFromData.mean)) {
      referenceLegendEntries.push({
        color: "#1d4ed8",
        text: `Mean/Avg: ${withUnit(statsFromData.mean)}`,
      });
    }
    if (Number.isFinite(statsFromData.p50)) {
      referenceLegendEntries.push({
        color: "#f59e42",
        text: `Median: ${withUnit(statsFromData.p50)}`,
      });
    }
  }

  const medianForLine = showMedianLine
    ? (typeof medianValue === "number" && Number.isFinite(medianValue)
      ? medianValue
      : statsFromData && Number.isFinite(statsFromData.p50)
        ? statsFromData.p50
        : null)
    : null;

  const width = 1120;
  const height = 480;
  const margin = {
    top: referenceLegendEntries.length > 0 ? 118 : 74,
    right: 28,
    bottom: 168,
    left: 96,
  };

  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  const rawMaxValue = Math.max(...displayed.map((point) => point.value));
  const yMaxCandidates = [rawMaxValue];
  if (medianForLine !== null) {
    yMaxCandidates.push(medianForLine);
  }
  const yMaxBase = Math.max(...yMaxCandidates);
  const yMax = yMaxBase > 0 ? yMaxBase * 1.1 : 1;
  const slotWidth = chartWidth / displayed.length;
  const barWidth = Math.max(5, Math.min(36, slotWidth * 0.7));
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

  const trendPoints = displayed.map((point, index) => {
    const barHeight = (point.value / yMax) * chartHeight;
    const x = margin.left + index * slotWidth + slotWidth / 2;
    const y = margin.top + chartHeight - barHeight;
    return { x, y };
  });

  const trendLineSvg = showTrendLine && trendPoints.length > 1
    ? `<path d="${trendPoints.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")}" fill="none" stroke="${escapeXml(trendLineColor)}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />`
    : "";

  const trendPointDotsSvg = showTrendLine && trendPoints.length <= 80
    ? trendPoints.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="2.5" fill="${escapeXml(trendLineColor)}" />`).join("\n  ")
    : "";

  const medianLineSvg = medianForLine !== null
    ? `<line x1="${margin.left}" y1="${margin.top + chartHeight - (medianForLine / yMax) * chartHeight}" x2="${width - margin.right}" y2="${margin.top + chartHeight - (medianForLine / yMax) * chartHeight}" stroke="#f59e42" stroke-width="2" stroke-dasharray="8 4" />`
    : "";

  const labelBaselineY = margin.top + chartHeight + 18;
  const labelsSvg = displayed.map((point, index) => {
    const x = margin.left + index * slotWidth + slotWidth / 2;
    const label = escapeXml(shortLabel(point.label, 24));
    return `<text x="${x}" y="${labelBaselineY}" fill="#334155" text-anchor="start" transform="rotate(40 ${x} ${labelBaselineY})" font-family="Arial, sans-serif" font-size="11">${label}</text>`;
  });

  const legendSvg = referenceLegendEntries
    .map((entry, index) => `<text x="${width - margin.right - 8}" y="${36 + index * 18}" fill="${entry.color}" text-anchor="end" font-family="Arial, sans-serif" font-size="14" font-weight="700">${escapeXml(entry.text)}</text>`)
    .join("\n  ");

  const subtitleText = subtitle || `${displayed.length} data points${truncated ? ` (showing first ${displayed.length} of ${pairs.length})` : ""}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
  <rect width="${width}" height="${height}" fill="#ffffff" />
  <text x="${margin.left}" y="38" fill="#0f172a" font-family="Arial, sans-serif" font-size="26" font-weight="700">${escapeXml(title)}</text>
  <text x="${margin.left}" y="60" fill="#64748b" font-family="Arial, sans-serif" font-size="14">${escapeXml(subtitleText)}</text>
  ${legendSvg}
  ${gridLines.join("\n  ")}
  <line x1="${margin.left}" y1="${margin.top + chartHeight}" x2="${width - margin.right}" y2="${margin.top + chartHeight}" stroke="#64748b" stroke-width="1.2" />
  <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + chartHeight}" stroke="#64748b" stroke-width="1.2" />
  <text x="22" y="${margin.top + chartHeight / 2}" fill="#334155" text-anchor="middle" transform="rotate(-90 22 ${margin.top + chartHeight / 2})" font-family="Arial, sans-serif" font-size="13">${escapeXml(yAxisLabel)}</text>
  <text x="${margin.left + chartWidth / 2}" y="${height - 20}" fill="#334155" text-anchor="middle" font-family="Arial, sans-serif" font-size="13">${escapeXml(xAxisLabel)}</text>
  ${bars.join("\n  ")}
  ${trendLineSvg}
  ${trendPointDotsSvg}
  ${medianLineSvg}
  ${labelsSvg.join("\n  ")}
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
  showMedian = false,
  medianValue = null,
  showMean = false,
  meanValue = null,
  showMin = false,
  minValue = null,
  showMax = false,
  maxValue = null,
  valueUnit = "ms",
  statsLabel = "",
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
  const normalizedStatsLabel = asString(statsLabel).trim();

  const width = 1120;
  const height = 440;
  const margin = {
    top: normalizedStatsLabel ? 90 : 74,
    right: 28,
    bottom: 84,
    left: 96,
  };

  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  const rawMaxValue = Math.max(...chartValues);
  const maxCandidates = [rawMaxValue];
  if (showMedian && typeof medianValue === "number" && Number.isFinite(medianValue)) {
    maxCandidates.push(medianValue);
  }
  if (showMean && typeof meanValue === "number" && Number.isFinite(meanValue)) {
    maxCandidates.push(meanValue);
  }
  if (showMax && typeof maxValue === "number" && Number.isFinite(maxValue)) {
    maxCandidates.push(maxValue);
  }
  const plottedMaxValue = Math.max(...maxCandidates);
  const yMax = plottedMaxValue > 0 ? plottedMaxValue * 1.1 : 1;

  const points = chartValues.map((value, index) => {
    const x = margin.left + (chartValues.length === 1 ? chartWidth / 2 : (index / (chartValues.length - 1)) * chartWidth);
    const y = margin.top + chartHeight - (value / yMax) * chartHeight;
    return {
      x,
      y,
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

  const unitSuffix = asString(valueUnit).trim();
  const withUnit = (value) => unitSuffix ? `${formatNumber(value, 2)} ${unitSuffix}` : formatNumber(value, 2);

  let minLine = "";
  const referenceLegendEntries = [];
  if (showMin && typeof minValue === "number" && Number.isFinite(minValue)) {
    const minY = margin.top + chartHeight - (minValue / yMax) * chartHeight;
    minLine = `<line x1="${margin.left}" y1="${minY}" x2="${width - margin.right}" y2="${minY}" stroke="#16a34a" stroke-width="2" stroke-dasharray="2 6" />`;
    referenceLegendEntries.push({
      color: "#16a34a",
      text: `Min: ${withUnit(minValue)}`,
    });
  }

  let maxLine = "";
  if (showMax && typeof maxValue === "number" && Number.isFinite(maxValue)) {
    const maxY = margin.top + chartHeight - (maxValue / yMax) * chartHeight;
    maxLine = `<line x1="${margin.left}" y1="${maxY}" x2="${width - margin.right}" y2="${maxY}" stroke="#dc2626" stroke-width="2" stroke-dasharray="10 4" />`;
    referenceLegendEntries.push({
      color: "#dc2626",
      text: `Max: ${withUnit(maxValue)}`,
    });
  }

  let medianLine = "";
  if (showMedian && typeof medianValue === "number" && Number.isFinite(medianValue)) {
    const medianY = margin.top + chartHeight - (medianValue / yMax) * chartHeight;
    medianLine = `<line x1="${margin.left}" y1="${medianY}" x2="${width - margin.right}" y2="${medianY}" stroke="#f59e42" stroke-width="2" stroke-dasharray="8 4" />`;
    referenceLegendEntries.push({
      color: "#f59e42",
      text: `Median: ${withUnit(medianValue)}`,
    });
  }

  let meanLine = "";
  if (showMean && typeof meanValue === "number" && Number.isFinite(meanValue)) {
    const meanY = margin.top + chartHeight - (meanValue / yMax) * chartHeight;
    meanLine = `<line x1="${margin.left}" y1="${meanY}" x2="${width - margin.right}" y2="${meanY}" stroke="#1d4ed8" stroke-width="2" stroke-dasharray="4 6" />`;
    referenceLegendEntries.push({
      color: "#1d4ed8",
      text: `Mean/Avg: ${withUnit(meanValue)}`,
    });
  }

  const subtitleText = subtitle || `${cleaned.length} samples${sampled.downsampled ? ` (downsampled to ${chartValues.length})` : ""}`;
  const statsText = normalizedStatsLabel
    ? `<text x="${margin.left}" y="80" fill="#475569" font-family="Arial, sans-serif" font-size="13">${escapeXml(normalizedStatsLabel)}</text>`
    : "";
  const referenceLegendSvg = referenceLegendEntries
    .map((entry, index) => `<text x="${width - margin.right - 8}" y="${36 + index * 18}" fill="${entry.color}" text-anchor="end" font-family="Arial, sans-serif" font-size="14" font-weight="700">${escapeXml(entry.text)}</text>`)
    .join("\n  ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
  <rect width="${width}" height="${height}" fill="#ffffff" />
  <text x="${margin.left}" y="38" fill="#0f172a" font-family="Arial, sans-serif" font-size="26" font-weight="700">${escapeXml(title)}</text>
  <text x="${margin.left}" y="60" fill="#64748b" font-family="Arial, sans-serif" font-size="14">${escapeXml(subtitleText)}</text>
  ${referenceLegendSvg}
  ${statsText}
  ${gridLines.join("\n  ")}
  <line x1="${margin.left}" y1="${margin.top + chartHeight}" x2="${width - margin.right}" y2="${margin.top + chartHeight}" stroke="#64748b" stroke-width="1.2" />
  <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + chartHeight}" stroke="#64748b" stroke-width="1.2" />
  <text x="22" y="${margin.top + chartHeight / 2}" fill="#334155" text-anchor="middle" transform="rotate(-90 22 ${margin.top + chartHeight / 2})" font-family="Arial, sans-serif" font-size="13">${escapeXml(yAxisLabel)}</text>
  <text x="${margin.left + chartWidth / 2}" y="${height - 20}" fill="#334155" text-anchor="middle" font-family="Arial, sans-serif" font-size="13">Sample index</text>
  <path d="${pathD}" fill="none" stroke="${escapeXml(color)}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
  ${minLine}
  ${maxLine}
  ${meanLine}
  ${medianLine}
</svg>
`;
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
      // Ignore malformed lines.
    }
  }

  rows.sort((left, right) => left.__timestampMs - right.__timestampMs);
  return rows;
}

function buildRoomLatencyRows(recordsByPeer) {
  const submitOutcomeTypes = new Set(["room_created", "room_joined", "room_action_error"]);
  const leaveOutcomeTypes = new Set(["participant_left", "room_closed", "room_action_error"]);
  const endOutcomeTypes = new Set(["room_closed", "room_action_error"]);
  const rows = [];

  for (const [peerFileId, records] of recordsByPeer.entries()) {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.eventType !== "room_flow_submit"
        && record.eventType !== "leave_room_requested"
        && record.eventType !== "end_room_requested") {
        continue;
      }

      const intent = record.eventType === "room_flow_submit"
        ? asString(record.intent)
        : record.eventType === "leave_room_requested"
          ? "leave-room"
          : "end-room";

      const outcomeTypes = record.eventType === "room_flow_submit"
        ? submitOutcomeTypes
        : record.eventType === "leave_room_requested"
          ? leaveOutcomeTypes
          : endOutcomeTypes;

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

      rows.push({
        runId: asString(record.runId),
        peerFileId,
        intent,
        roomId: asString(record.roomId),
        submittedAtMs: record.__timestampMs,
        outcomeAtMs: outcome.__timestampMs,
        latencyMs: outcome.__timestampMs - record.__timestampMs,
        success: outcome.eventType === "room_created" || outcome.eventType === "room_joined",
        outcomeType: outcome.eventType,
        errorCode: asString(outcome.errorCode),
      });
    }
  }

  rows.sort((left, right) => right.outcomeAtMs - left.outcomeAtMs);
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

  rows.sort((left, right) => right.endAtMs - left.endAtMs);
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

  rows.sort((left, right) => right.recordedAtMs - left.recordedAtMs);
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

  rows.sort((left, right) => right.disruptionAtMs - left.disruptionAtMs);
  return rows;
}

function computeSummary(roomRows, transferRows, workspaceRttRows, resyncRows) {
  const roomLatencies = roomRows.map((row) => row.latencyMs);
  const transferDurations = transferRows.map((row) => row.durationMs);
  const throughputValues = transferRows
    .filter((row) => includeThroughputInAnalytics(row, 3))
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

function chartArtifacts(roomRows, transferRows, workspaceRttRows, resyncRows, options = {}) {
  const toActionLabel = (value) => {
    const normalized = asString(value).replace(/[_-]+/g, " ").trim();
    if (!normalized) {
      return "Unknown";
    }

    return normalized
      .split(/\s+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  };

  const roomLatencyValues = roomRows.map((row) => row.latencyMs);
  const roomLatencyStats = buildStats(roomLatencyValues);
  const roomLatencySvg = buildBarChartSvg({
    title: "Room Flow Latency",
    labels: roomRows.map((row, index) => `${row.intent || "flow"}-${row.outcomeType || "outcome"}-${index + 1}`),
    values: roomLatencyValues,
    yAxisLabel: "Latency (ms)",
    color: "#2563eb",
    maxBars: 60,
    decimals: 0,
    showMedianLine: true,
    medianValue: roomLatencyStats && Number.isFinite(roomLatencyStats.p50) ? roomLatencyStats.p50 : null,
    stats: roomLatencyStats,
    valueUnit: "ms",
  });

  const roomRowsByAction = new Map();
  for (const row of roomRows) {
    const actionKey = asString(row.intent) || asString(row.outcomeType) || "unknown";
    const group = roomRowsByAction.get(actionKey) ?? [];
    group.push(row);
    roomRowsByAction.set(actionKey, group);
  }

  const roomLatencyByActionPalette = ["#2563eb", "#0ea5e9", "#f97316", "#16a34a", "#c026d3", "#0f766e"];
  const roomLatencyByAction = Array.from(roomRowsByAction.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([actionKey, actionRows], index) => {
      const actionLabel = toActionLabel(actionKey);
      const normalizedActionKey = asString(actionKey).toLowerCase();
      const actionChartTitle = normalizedActionKey === "join"
        ? "Room Join Latency"
        : normalizedActionKey === "end-room"
          ? "End Room latency"
          : normalizedActionKey === "create"
            ? "Create Room Latency"
            : `Room Flow Latency: ${actionLabel}`;
      const actionValues = actionRows.map((row) => row.latencyMs);
      const actionStats = buildStats(actionValues);

      const color = roomLatencyByActionPalette[index % roomLatencyByActionPalette.length];
      return {
        action: actionKey,
        title: `${actionLabel} (${actionRows.length})`,
        svg: buildBarChartSvg({
          title: actionChartTitle,
          labels: actionRows.map((row, rowIndex) => `${row.outcomeType || "outcome"}-${rowIndex + 1}`),
          values: actionValues,
          yAxisLabel: "Latency (ms)",
          color,
          maxBars: 60,
          decimals: 0,
          showMedianLine: true,
          medianValue: actionStats && Number.isFinite(actionStats.p50) ? actionStats.p50 : null,
          stats: actionStats,
          valueUnit: "ms",
        }),
      };
    });

  const rttValues = workspaceRttRows.map((row) => row.rttMs);
  const rttStats = buildStats(rttValues);
  const workspaceRttSvg = buildBarChartSvg({
    title: "Overall Workspace Latency",
    labels: workspaceRttRows.map((_, index) => `sample-${index + 1}`),
    values: rttValues,
    yAxisLabel: "RTT (ms)",
    color: "#0f766e",
    maxBars: 60,
    decimals: 2,
    showMedianLine: true,
    medianValue: rttStats && Number.isFinite(rttStats.p50) ? rttStats.p50 : null,
    stats: rttStats,
    valueUnit: "ms",
  });

  const buildWorkspaceSourceChart = ({
    sourceType,
    title,
    color,
  }) => {
    const rows = workspaceRttRows.filter((row) => row.sourceType === sourceType || row.ackSourceType === sourceType);
    const values = rows.map((row) => row.rttMs);
    const stats = buildStats(values);

    return buildBarChartSvg({
      title,
      labels: rows.map((_, index) => `sample-${index + 1}`),
      values,
      yAxisLabel: "RTT (ms)",
      color,
      maxBars: 60,
      decimals: 2,
      showMedianLine: true,
      medianValue: stats && Number.isFinite(stats.p50) ? stats.p50 : null,
      stats,
      valueUnit: "ms",
    });
  };

  const workspaceRttChatSvg = buildWorkspaceSourceChart({
    sourceType: "chat-message",
    title: "Chatroom Latency",
    color: "#0ea5e9",
  });

  const workspaceRttWhiteboardSvg = buildWorkspaceSourceChart({
    sourceType: "whiteboard-update",
    title: "Whiteboard Latency",
    color: "#0f766e",
  });

  const workspaceRttEditorSvg = buildWorkspaceSourceChart({
    sourceType: "editor-update",
    title: "Shared Editor Latency",
    color: "#7c3aed",
  });

  const throughputRows = transferRows.filter((row) => includeThroughputInAnalytics(row, 3));
  const throughputValues = throughputRows.map((row) => row.throughputMiBPerSecond);
  const throughputStats = buildStats(throughputValues);
  const transferThroughputSvg = buildBarChartSvg({
    title: "Transfer Throughput",
    labels: throughputRows.map((row, index) => `${shortLabel(row.fileName || row.transferId, 14)}-${index + 1}`),
    values: throughputValues,
    yAxisLabel: "Throughput (MiB/s)",
    color: "#7c3aed",
    maxBars: 60,
    decimals: 3,
    showMedianLine: true,
    medianValue: throughputStats && Number.isFinite(throughputStats.p50) ? throughputStats.p50 : null,
    stats: throughputStats,
    valueUnit: "MiB/s",
  });

  const resyncValues = resyncRows.map((row) => (row.resyncMs === null ? 0 : row.resyncMs));
  const resyncStats = buildStats(resyncValues);
  const resyncSvg = buildBarChartSvg({
    title: "Resync Time By Disruption",
    subtitle: "Green converged, red did not.",
    labels: resyncRows.map((row, index) => `${row.disruptionType || "disruption"}-${index + 1}`),
    values: resyncValues,
    yAxisLabel: "Resync (ms)",
    color: "#16a34a",
    colors: resyncRows.map((row) => (row.converged ? "#16a34a" : "#dc2626")),
    maxBars: 60,
    decimals: 0,
    showMedianLine: true,
    medianValue: resyncStats && Number.isFinite(resyncStats.p50) ? resyncStats.p50 : null,
    stats: resyncStats,
    valueUnit: "ms",
  });

  return {
    roomLatencySvg,
    roomLatencyByAction,
    workspaceRttSvg,
    workspaceRttChatSvg,
    workspaceRttWhiteboardSvg,
    workspaceRttEditorSvg,
    transferThroughputSvg,
    resyncSvg,
  };
}

function flattenSummary(summary) {
  const rows = [];

  function pushGroup(prefix, value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, nested] of Object.entries(value)) {
        pushGroup(prefix ? `${prefix}.${key}` : key, nested);
      }
      return;
    }

    rows.push({
      metric: prefix,
      value,
    });
  }

  pushGroup("", summary);
  return rows;
}

function worksheetXml(name, rows) {
  const safeName = asString(name)
    .replace(/[\\\/?*\[\]:]/g, "-")
    .slice(0, 31) || "Sheet";

  if (rows.length === 0) {
    return `<Worksheet ss:Name="${escapeXml(safeName)}"><Table><Row><Cell><Data ss:Type="String">No rows</Data></Cell></Row></Table></Worksheet>`;
  }

  const headers = Object.keys(rows[0]);

  const headerCells = headers
    .map((header) => `<Cell ss:StyleID="header"><Data ss:Type="String">${escapeXml(header)}</Data></Cell>`)
    .join("");

  const bodyRows = rows
    .map((row) => {
      const cells = headers.map((header) => {
        const value = row[header];
        if (typeof value === "number" && Number.isFinite(value)) {
          return `<Cell><Data ss:Type="Number">${value}</Data></Cell>`;
        }

        if (typeof value === "boolean") {
          return `<Cell><Data ss:Type="String">${value ? "true" : "false"}</Data></Cell>`;
        }

        return `<Cell><Data ss:Type="String">${escapeXml(String(value ?? ""))}</Data></Cell>`;
      }).join("");

      return `<Row>${cells}</Row>`;
    })
    .join("");

  return `<Worksheet ss:Name="${escapeXml(safeName)}"><Table><Row>${headerCells}</Row>${bodyRows}</Table></Worksheet>`;
}

function buildExcelWorkbookXml({ summary, roomRows, transferRows, workspaceRttRows, resyncRows }) {
  const summaryRows = flattenSummary(summary);

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="header">
   <Font ss:Bold="1"/>
   <Interior ss:Color="#E2E8F0" ss:Pattern="Solid"/>
  </Style>
 </Styles>
 ${worksheetXml("Summary", summaryRows)}
 ${worksheetXml("RoomLatency", roomRows)}
 ${worksheetXml("Transfers", transferRows)}
 ${worksheetXml("WorkspaceRTT", workspaceRttRows)}
 ${worksheetXml("Resync", resyncRows)}
</Workbook>`;
}

function newestTimestampFromRecords(recordsByPeer) {
  let newest = 0;
  for (const records of recordsByPeer.values()) {
    for (const record of records) {
      if (record.__timestampMs > newest) {
        newest = record.__timestampMs;
      }
    }
  }
  return newest;
}

async function resolveMetricsBaseDir() {
  const override = process.env.VIR_SPACE_METRICS_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }

  return path.resolve(process.cwd(), ".metrics");
}

async function listRooms(metricsBaseDir) {
  try {
    const entries = await fs.readdir(metricsBaseDir, { withFileTypes: true });
    const rooms = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const runId = entry.name;
      const runDirPath = path.join(metricsBaseDir, runId);
      const children = await fs.readdir(runDirPath, { withFileTypes: true });
      const peerFiles = children.filter((child) => child.isFile() && child.name.startsWith("peer_") && child.name.endsWith(".ndjson"));

      let newestMtimeMs = 0;
      for (const peerFile of peerFiles) {
        const stat = await fs.stat(path.join(runDirPath, peerFile.name));
        newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
      }

      if (newestMtimeMs === 0) {
        newestMtimeMs = (await fs.stat(runDirPath)).mtimeMs;
      }

      rooms.push({
        runId,
        runDirPath,
        peerFileCount: peerFiles.length,
        newestMtimeMs,
        newestMtimeIso: new Date(newestMtimeMs).toISOString(),
      });
    }

    rooms.sort((left, right) => right.newestMtimeMs - left.newestMtimeMs);
    return rooms;
  } catch {
    return [];
  }
}

async function buildAllRoomLatencyRows(metricsBaseDir) {
  const rooms = await listRooms(metricsBaseDir);
  if (rooms.length === 0) {
    return [];
  }

  const recordsByPeer = new Map();

  for (const room of rooms) {
    let children = [];
    try {
      children = await fs.readdir(room.runDirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    const peerFiles = children
      .filter((entry) => entry.isFile() && entry.name.startsWith("peer_") && entry.name.endsWith(".ndjson"))
      .map((entry) => path.join(room.runDirPath, entry.name));

    for (const filePath of peerFiles) {
      try {
        const basePeerId = path.basename(filePath).replace(/^peer_/, "").replace(/\.ndjson$/, "");
        const peerFileId = `${room.runId}:${basePeerId}`;
        const records = await readNdjson(filePath);
        recordsByPeer.set(peerFileId, records);
      } catch {
        // Skip unreadable files so one bad run does not block chart aggregation.
      }
    }
  }

  return buildRoomLatencyRows(recordsByPeer);
}

async function loadRoomData(metricsBaseDir, runId) {
  if (!runId) {
    throw new Error("runId is required");
  }

  const normalizedRunId = runId.trim();
  if (!normalizedRunId || normalizedRunId.includes("/") || normalizedRunId.includes("\\")) {
    throw new Error("invalid runId");
  }

  const runDirPath = path.resolve(metricsBaseDir, normalizedRunId);
  const insideBase = runDirPath === metricsBaseDir || runDirPath.startsWith(`${metricsBaseDir}${path.sep}`);
  if (!insideBase) {
    throw new Error("invalid runId path");
  }

  const stat = await fs.stat(runDirPath);
  if (!stat.isDirectory()) {
    throw new Error(`runId does not reference a directory: ${normalizedRunId}`);
  }

  const children = await fs.readdir(runDirPath, { withFileTypes: true });
  const peerFiles = children
    .filter((entry) => entry.isFile() && entry.name.startsWith("peer_") && entry.name.endsWith(".ndjson"))
    .map((entry) => path.join(runDirPath, entry.name));

  if (peerFiles.length === 0) {
    throw new Error(`No peer_*.ndjson files found for ${normalizedRunId}`);
  }

  const recordsByPeer = new Map();
  for (const filePath of peerFiles) {
    const peerFileId = path.basename(filePath).replace(/^peer_/, "").replace(/\.ndjson$/, "");
    const records = await readNdjson(filePath);
    recordsByPeer.set(peerFileId, records);
  }

  const roomRows = buildRoomLatencyRows(recordsByPeer);
  const roomRowsForCharts = await buildAllRoomLatencyRows(metricsBaseDir);
  const roomRowsForChartsOrFallback = roomRowsForCharts.length > 0 ? roomRowsForCharts : roomRows;
  const transferRows = buildTransferRows(recordsByPeer);
  const workspaceRttRows = buildWorkspaceRttRows(recordsByPeer);
  const resyncRows = buildResyncRows(recordsByPeer);
  const summary = computeSummary(roomRows, transferRows, workspaceRttRows, resyncRows);
  const charts = chartArtifacts(
    roomRowsForChartsOrFallback,
    transferRows,
    workspaceRttRows,
    resyncRows,
    { roomFlowScopeLabel: "across all rooms" },
  );

  const newestRecordTimestampMs = newestTimestampFromRecords(recordsByPeer);
  const newestRoomFlowOutcomeMs = roomRowsForChartsOrFallback.length > 0
    ? roomRowsForChartsOrFallback[0].outcomeAtMs
    : 0;
  const revision = [
    newestRecordTimestampMs,
    roomRows.length,
    roomRowsForChartsOrFallback.length,
    newestRoomFlowOutcomeMs,
    transferRows.length,
    workspaceRttRows.length,
    resyncRows.length,
  ].join(":");

  return {
    runId: normalizedRunId,
    runDirPath,
    newestRecordTimestampMs,
    newestRecordTimestampIso: newestRecordTimestampMs > 0 ? new Date(newestRecordTimestampMs).toISOString() : null,
    peerFileCount: peerFiles.length,
    summary,
    charts,
    roomFlowChartScope: "all-rooms",
    roomFlowChartRowsCount: roomRowsForChartsOrFallback.length,
    roomRows,
    transferRows,
    workspaceRttRows,
    resyncRows,
    revision,
    generatedAtIso: new Date().toISOString(),
  };
}

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function errorResponse(res, statusCode, message) {
  jsonResponse(res, statusCode, {
    error: message,
  });
}

async function startServer() {
  const metricsBaseDir = await resolveMetricsBaseDir();
  const dashboardHtmlPath = path.resolve(process.cwd(), "scripts", "metrics-dashboard.html");

  const argPort = Number.parseInt(process.argv[2] ?? "", 10);
  const envPort = Number.parseInt(process.env.METRICS_DASHBOARD_PORT ?? "", 10);
  const port = Number.isFinite(argPort) && argPort > 0
    ? argPort
    : Number.isFinite(envPort) && envPort > 0
      ? envPort
      : 43123;

  const server = http.createServer(async (req, res) => {
    if (!req.url || !req.method) {
      errorResponse(res, 400, "Bad request");
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    try {
      if (req.method === "GET" && requestUrl.pathname === "/") {
        const html = await fs.readFile(dashboardHtmlPath, "utf8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/health") {
        jsonResponse(res, 200, {
          ok: true,
          metricsBaseDir,
          nowIso: new Date().toISOString(),
        });
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/rooms") {
        const rooms = await listRooms(metricsBaseDir);
        jsonResponse(res, 200, {
          rooms,
          generatedAtIso: new Date().toISOString(),
        });
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/room-data") {
        const runId = requestUrl.searchParams.get("runId") ?? "";
        const roomData = await loadRoomData(metricsBaseDir, runId);
        jsonResponse(res, 200, roomData);
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/export/excel") {
        const runId = requestUrl.searchParams.get("runId") ?? "";
        const roomData = await loadRoomData(metricsBaseDir, runId);
        const workbookXml = buildExcelWorkbookXml(roomData);
        const filename = `${roomData.runId}_metrics.xls`;

        res.writeHead(200, {
          "Content-Type": "application/vnd.ms-excel; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        });
        res.end(workbookXml);
        return;
      }

      errorResponse(res, 404, "Not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorResponse(res, 500, message);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Live metrics dashboard: http://127.0.0.1:${port}`);
    console.log(`Metrics base directory: ${metricsBaseDir}`);
  });
}

startServer().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start metrics dashboard server: ${message}`);
  process.exit(1);
});
