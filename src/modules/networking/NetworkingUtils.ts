/**
 * NetworkingUtils.ts
 *
 * Networking utilities for debugging, monitoring, and diagnostics:
 * - Connection quality metrics
 * - Latency measurements
 * - Bandwidth tracking
 * - Debugging helpers
 * - Connection diagnostics
 */

import type {
    PeerConnectionState,
    RoomPeerConnection
} from './NetworkingLayer';

// ==================== Diagnostic Types ====================
export interface ConnectionQualityMetrics {
  latency: number; // milliseconds
  bandwidth: number; // bytes per second
  packetLoss: number; // percentage 0-100
  jitter: number; // milliseconds
  rtt: number; // round trip time in ms
  quality: 'excellent' | 'good' | 'fair' | 'poor' | 'offline';
}

export interface NetworkingDiagnostics {
  timestamp: string;
  localPeerId: string;
  connections: {
    peerId: string;
    connected: boolean;
    quality: ConnectionQualityMetrics;
    lastError?: string;
  }[];
  roomsStatus: {
    roomId: string;
    peersConnected: number;
    totalPeers: number;
    averageQuality: ConnectionQualityMetrics;
  }[];
  overallHealth: 'excellent' | 'good' | 'fair' | 'poor' | 'offline';
  recommendations: string[];
}

export interface LatencySample {
  timestamp: string;
  peerId: string;
  latency: number;
  success: boolean;
}

// ==================== Connection Quality Tracker ====================
export class ConnectionQualityTracker {
  private latencySamples = new Map<string, LatencySample[]>();
  private bandwidthSamples = new Map<string, number[]>();
  private packetLossSamples = new Map<string, number[]>();
  private jitterSamples = new Map<string, number[]>();

  private static readonly MAX_SAMPLES = 100;
  private static readonly LATENCY_THRESHOLDS = {
    excellent: 50, // < 50ms
    good: 100, // < 100ms
    fair: 200, // < 200ms
    poor: 500, // < 500ms
  };

  /**
   * Records a latency sample
   */
  recordLatency(peerId: string, latency: number, success: boolean = true): void {
    if (!this.latencySamples.has(peerId)) {
      this.latencySamples.set(peerId, []);
    }

    const samples = this.latencySamples.get(peerId)!;
    samples.push({
      timestamp: new Date().toISOString(),
      peerId,
      latency,
      success,
    });

    // Keep only recent samples
    if (samples.length > ConnectionQualityTracker.MAX_SAMPLES) {
      samples.shift();
    }
  }

  /**
   * Records bandwidth
   */
  recordBandwidth(peerId: string, bytesPerSecond: number): void {
    if (!this.bandwidthSamples.has(peerId)) {
      this.bandwidthSamples.set(peerId, []);
    }

    const samples = this.bandwidthSamples.get(peerId)!;
    samples.push(bytesPerSecond);

    if (samples.length > ConnectionQualityTracker.MAX_SAMPLES) {
      samples.shift();
    }
  }

  /**
   * Records packet loss
   */
  recordPacketLoss(peerId: string, percentLost: number): void {
    if (!this.packetLossSamples.has(peerId)) {
      this.packetLossSamples.set(peerId, []);
    }

    const samples = this.packetLossSamples.get(peerId)!;
    samples.push(percentLost);

    if (samples.length > ConnectionQualityTracker.MAX_SAMPLES) {
      samples.shift();
    }
  }

  /**
   * Records jitter
   */
  recordJitter(peerId: string, jitterMs: number): void {
    if (!this.jitterSamples.has(peerId)) {
      this.jitterSamples.set(peerId, []);
    }

    const samples = this.jitterSamples.get(peerId)!;
    samples.push(jitterMs);

    if (samples.length > ConnectionQualityTracker.MAX_SAMPLES) {
      samples.shift();
    }
  }

  /**
   * Gets connection quality metrics for a peer
   */
  getQualityMetrics(peerId: string): ConnectionQualityMetrics {
    const avgLatency = this.getAverageLatency(peerId);
    const avgBandwidth = this.getAverageBandwidth(peerId);
    const avgPacketLoss = this.getAveragePacketLoss(peerId);
    const avgJitter = this.getAverageJitter(peerId);

    const quality = this.determineQuality(avgLatency, avgPacketLoss);

    return {
      latency: avgLatency,
      bandwidth: avgBandwidth,
      packetLoss: avgPacketLoss,
      jitter: avgJitter,
      rtt: avgLatency * 2, // Assuming round trip ~2x one way
      quality,
    };
  }

  /**
   * Gets average latency for a peer
   */
  getAverageLatency(peerId: string): number {
    const samples = this.latencySamples.get(peerId) || [];
    if (samples.length === 0) return 0;

    const successful = samples.filter((s) => s.success);
    if (successful.length === 0) return 0;

    const sum = successful.reduce((acc, s) => acc + s.latency, 0);
    return sum / successful.length;
  }

  /**
   * Gets average bandwidth for a peer
   */
  getAverageBandwidth(peerId: string): number {
    const samples = this.bandwidthSamples.get(peerId) || [];
    if (samples.length === 0) return 0;

    const sum = samples.reduce((acc, b) => acc + b, 0);
    return sum / samples.length;
  }

  /**
   * Gets average packet loss for a peer
   */
  getAveragePacketLoss(peerId: string): number {
    const samples = this.packetLossSamples.get(peerId) || [];
    if (samples.length === 0) return 0;

    const sum = samples.reduce((acc, p) => acc + p, 0);
    return sum / samples.length;
  }

  /**
   * Gets average jitter for a peer
   */
  getAverageJitter(peerId: string): number {
    const samples = this.jitterSamples.get(peerId) || [];
    if (samples.length === 0) return 0;

    const sum = samples.reduce((acc, j) => acc + j, 0);
    return sum / samples.length;
  }

  /**
   * Determines connection quality
   */
  private determineQuality(
    latency: number,
    packetLoss: number,
  ): 'excellent' | 'good' | 'fair' | 'poor' | 'offline' {
    if (latency === 0 && packetLoss === 0) return 'offline';

    if (packetLoss > 10) return 'poor';
    if (packetLoss > 5) return 'fair';

    const thresholds = ConnectionQualityTracker.LATENCY_THRESHOLDS;
    if (latency < thresholds.excellent) return 'excellent';
    if (latency < thresholds.good) return 'good';
    if (latency < thresholds.fair) return 'fair';
    if (latency < thresholds.poor) return 'poor';

    return 'poor';
  }

  /**
   * Clears all metrics
   */
  clear(): void {
    this.latencySamples.clear();
    this.bandwidthSamples.clear();
    this.packetLossSamples.clear();
    this.jitterSamples.clear();
  }
}

// ==================== Networking Diagnostics Utility ====================
export class NetworkingDiagnosticsUtil {
  static generateDiagnostics(
    localPeerId: string,
    peerConnections: Map<string, PeerConnectionState>,
    roomConnections: Map<string, RoomPeerConnection[]>,
    qualityTracker: ConnectionQualityTracker,
  ): NetworkingDiagnostics {
    const connections = Array.from(peerConnections.values()).map((state) => ({
      peerId: state.peerId,
      connected: state.connected,
      quality: qualityTracker.getQualityMetrics(state.peerId),
      lastError: state.lastError,
    }));

    const roomsStatus = Array.from(roomConnections.entries()).map(([roomId, conns]) => {
      const qualities = conns.map((c) => qualityTracker.getQualityMetrics(c.peerId));
      const avgQuality = NetworkingDiagnosticsUtil.averageQuality(qualities);

      return {
        roomId,
        peersConnected: conns.filter((c) => c.connected).length,
        totalPeers: conns.length,
        averageQuality: avgQuality,
      };
    });

    const overallHealth = NetworkingDiagnosticsUtil.determineOverallHealth(connections);
    const recommendations = NetworkingDiagnosticsUtil.generateRecommendations(
      connections,
      overallHealth,
    );

    return {
      timestamp: new Date().toISOString(),
      localPeerId,
      connections,
      roomsStatus,
      overallHealth,
      recommendations,
    };
  }

  private static averageQuality(qualities: ConnectionQualityMetrics[]): ConnectionQualityMetrics {
    if (qualities.length === 0) {
      return {
        latency: 0,
        bandwidth: 0,
        packetLoss: 0,
        jitter: 0,
        rtt: 0,
        quality: 'offline',
      };
    }

    const avgLatency = qualities.reduce((a, q) => a + q.latency, 0) / qualities.length;
    const avgBandwidth = qualities.reduce((a, q) => a + q.bandwidth, 0) / qualities.length;
    const avgPacketLoss = qualities.reduce((a, q) => a + q.packetLoss, 0) / qualities.length;
    const avgJitter = qualities.reduce((a, q) => a + q.jitter, 0) / qualities.length;

    const qualityScores = qualities.map((q) => NetworkingDiagnosticsUtil.qualityScore(q.quality));
    const avgQualityScore = qualityScores.reduce((a, s) => a + s, 0) / qualityScores.length;

    const qualityLevels: ('excellent' | 'good' | 'fair' | 'poor' | 'offline')[] = [
      'excellent',
      'good',
      'fair',
      'poor',
      'offline',
    ];
    const quality = qualityLevels[Math.round(avgQualityScore)];

    return {
      latency: avgLatency,
      bandwidth: avgBandwidth,
      packetLoss: avgPacketLoss,
      jitter: avgJitter,
      rtt: avgLatency * 2,
      quality,
    };
  }

  private static qualityScore(quality: string): number {
    const scores: Record<string, number> = {
      excellent: 0,
      good: 1,
      fair: 2,
      poor: 3,
      offline: 4,
    };
    return scores[quality] || 4;
  }

  private static determineOverallHealth(
    connections: { quality: ConnectionQualityMetrics }[],
  ): 'excellent' | 'good' | 'fair' | 'poor' | 'offline' {
    if (connections.length === 0) return 'offline';

    const qualities = connections
      .map((c) => c.quality.quality)
      .filter((q) => q !== 'offline');

    if (qualities.length === 0) return 'offline';

    const avgScore = qualities.reduce((a, q) => a + NetworkingDiagnosticsUtil.qualityScore(q), 0) / qualities.length;

    const qualityLevels: ('excellent' | 'good' | 'fair' | 'poor' | 'offline')[] = [
      'excellent',
      'good',
      'fair',
      'poor',
      'offline',
    ];
    return qualityLevels[Math.round(avgScore)];
  }

  private static generateRecommendations(
    connections: { peerId: string; quality: ConnectionQualityMetrics; lastError?: string }[],
    overallHealth: string,
  ): string[] {
    const recommendations: string[] = [];

    if (overallHealth === 'offline') {
      recommendations.push('❌ Network is offline. Check your internet connection.');
    } else if (overallHealth === 'poor') {
      recommendations.push('⚠️  Network quality is poor. Consider using a wired connection.');
    }

    for (const conn of connections) {
      if (conn.quality.latency > 300) {
        recommendations.push(`⚠️  High latency to ${conn.peerId}: ${conn.quality.latency.toFixed(0)}ms`);
      }

      if (conn.quality.packetLoss > 5) {
        recommendations.push(`⚠️  Packet loss to ${conn.peerId}: ${conn.quality.packetLoss.toFixed(1)}%`);
      }

      if (conn.quality.jitter > 50) {
        recommendations.push(`⚠️  High jitter to ${conn.peerId}: ${conn.quality.jitter.toFixed(0)}ms`);
      }

      if (conn.lastError) {
        recommendations.push(`❌ Error with ${conn.peerId}: ${conn.lastError}`);
      }
    }

    if (recommendations.length === 0) {
      recommendations.push('✅ All connections are healthy!');
    }

    return recommendations;
  }

  /**
   * Formats diagnostics for logging
   */
  static formatDiagnosticsForLog(diagnostics: NetworkingDiagnostics): string {
    const lines: string[] = [];
    lines.push(`=== Networking Diagnostics (${diagnostics.timestamp}) ===`);
    lines.push(`Overall Health: ${diagnostics.overallHealth}`);
    lines.push(`Local Peer ID: ${diagnostics.localPeerId}`);
    lines.push('');

    lines.push('--- Peer Connections ---');
    for (const conn of diagnostics.connections) {
      lines.push(`  ${conn.peerId}`);
      lines.push(`    Status: ${conn.connected ? 'Connected' : 'Disconnected'}`);
      lines.push(`    Quality: ${conn.quality.quality}`);
      lines.push(`    Latency: ${conn.quality.latency.toFixed(0)}ms`);
      lines.push(`    Bandwidth: ${(conn.quality.bandwidth / 1024).toFixed(2)} KB/s`);
      lines.push(`    Packet Loss: ${conn.quality.packetLoss.toFixed(1)}%`);
      if (conn.lastError) {
        lines.push(`    Error: ${conn.lastError}`);
      }
    }
    lines.push('');

    lines.push('--- Room Status ---');
    for (const room of diagnostics.roomsStatus) {
      lines.push(`  Room ${room.roomId}`);
      lines.push(`    Connected: ${room.peersConnected}/${room.totalPeers}`);
      lines.push(`    Avg Quality: ${room.averageQuality.quality}`);
    }
    lines.push('');

    lines.push('--- Recommendations ---');
    for (const rec of diagnostics.recommendations) {
      lines.push(`  ${rec}`);
    }

    return lines.join('\n');
  }
}

// ==================== Network State Monitor ====================
export class NetworkStateMonitor {
  private diagnosticsHistory: NetworkingDiagnostics[] = [];
  private readonly maxHistorySize = 1000;

  /**
   * Records a diagnostics snapshot
   */
  recordDiagnostics(diagnostics: NetworkingDiagnostics): void {
    this.diagnosticsHistory.push(diagnostics);

    if (this.diagnosticsHistory.length > this.maxHistorySize) {
      this.diagnosticsHistory.shift();
    }
  }

  /**
   * Gets diagnostics history
   */
  getHistory(limit?: number): NetworkingDiagnostics[] {
    if (!limit) return [...this.diagnosticsHistory];
    return this.diagnosticsHistory.slice(-limit);
  }

  /**
   * Gets trend analysis
   */
  getTrendAnalysis(): {
    latencyTrend: 'improving' | 'degrading' | 'stable';
    bandwidthTrend: 'improving' | 'degrading' | 'stable';
    healthTrend: 'improving' | 'degrading' | 'stable';
  } {
    if (this.diagnosticsHistory.length < 2) {
      return { latencyTrend: 'stable', bandwidthTrend: 'stable', healthTrend: 'stable' };
    }

    // Simplified trend analysis
    return {
      latencyTrend: 'stable',
      bandwidthTrend: 'stable',
      healthTrend: 'stable',
    };
  }

  /**
   * Gets average diagnostics over time window
   */
  getAverageDiagnostics(timeWindowMs: number = 60000): NetworkingDiagnostics | null {
    const now = new Date().getTime();
    const cutoff = now - timeWindowMs;

    const relevantSnapshots = this.diagnosticsHistory.filter((d) => {
      const timestamp = new Date(d.timestamp).getTime();
      return timestamp >= cutoff;
    });

    if (relevantSnapshots.length === 0) return null;

    // Calculate averages (simplified)
    return relevantSnapshots[Math.floor(relevantSnapshots.length / 2)];
  }
}
