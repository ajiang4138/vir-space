/**
 * PeerDiscovery.ts
 *
 * Handles peer discovery mechanisms including:
 * - mDNS (local network discovery)
 * - DHT (distributed hash table) discovery
 * - Bootstrap node discovery
 * - Peer announce mechanisms
 */

import type { Libp2p } from 'libp2p';

// ==================== Discovery Types ====================
export type DiscoveryMethod = 'mdns' | 'dht' | 'bootstrap' | 'manual';

export interface DiscoveredPeer {
  peerId: string;
  multiaddrs: string[];
  discoveryMethod: DiscoveryMethod;
  discoveredAt: string;
  lastSeen: string;
  capabilities: string[];
}

export interface DiscoveryStats {
  totalDiscovered: number;
  currentActive: number;
  averageDiscoveryTime: number;
  methodStats: Record<DiscoveryMethod, number>;
}

export interface PeerCapabilities {
  supportsFileTransfer: boolean;
  supportsWorkspaceSync: boolean;
  supportsRealtimePresence: boolean;
  supportedProtocols: string[];
}

// ==================== Peer Discovery Manager ====================
export class PeerDiscoveryManager {
  private node: Libp2p | null = null;
  private discoveredPeers = new Map<string, DiscoveredPeer>();
  private discoveryListeners: ((peer: DiscoveredPeer) => void)[] = [];
  private discoveryTimes: number[] = [];
  private methodStats: Record<DiscoveryMethod, number> = {
    mdns: 0,
    dht: 0,
    bootstrap: 0,
    manual: 0,
  };

  constructor(node: Libp2p) {
    this.node = node;
    this.setupDiscoveryListeners();
  }

  /**
   * Sets up listeners for peer discovery events
   */
  private setupDiscoveryListeners(): void {
    if (!this.node) {
      return;
    }

    // Listen for peer discovery events
    this.node.addEventListener('peer:discovery', (evt) => {
      const peerId = evt.detail.id.toString();
      const multiaddrs = evt.detail.multiaddrs.map((m) => m.toString()) || [];

      this.handlePeerDiscovered(peerId, multiaddrs, 'mdns');
    });
  }

  /**
   * Handles a discovered peer
   */
  private handlePeerDiscovered(
    peerId: string,
    multiaddrs: string[],
    method: DiscoveryMethod,
  ): void {
    const startTime = Date.now();

    if (this.discoveredPeers.has(peerId)) {
      // Update existing peer
      const peer = this.discoveredPeers.get(peerId)!;
      peer.lastSeen = new Date().toISOString();
      peer.multiaddrs = [...new Set([...peer.multiaddrs, ...multiaddrs])];
    } else {
      // New peer discovered
      const peer: DiscoveredPeer = {
        peerId,
        multiaddrs,
        discoveryMethod: method,
        discoveredAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        capabilities: [],
      };

      this.discoveredPeers.set(peerId, peer);

      // Update discovery stats
      this.methodStats[method]++;
      const discoveryTime = Date.now() - startTime;
      this.discoveryTimes.push(discoveryTime);
    }

    // Notify listeners
    const peer = this.discoveredPeers.get(peerId)!;
    for (const listener of this.discoveryListeners) {
      try {
        listener(peer);
      } catch (error) {
        console.error('Error in discovery listener:', error);
      }
    }
  }

  /**
   * Registers a peer discovery listener
   */
  onPeerDiscovered(listener: (peer: DiscoveredPeer) => void): () => void {
    this.discoveryListeners.push(listener);

    // Return unsubscribe function
    return () => {
      const index = this.discoveryListeners.indexOf(listener);
      if (index >= 0) {
        this.discoveryListeners.splice(index, 1);
      }
    };
  }

  /**
   * Gets all discovered peers
   */
  getDiscoveredPeers(): DiscoveredPeer[] {
    return Array.from(this.discoveredPeers.values());
  }

  /**
   * Gets a specific discovered peer
   */
  getDiscoveredPeer(peerId: string): DiscoveredPeer | null {
    return this.discoveredPeers.get(peerId) || null;
  }

  /**
   * Gets discovery statistics
   */
  getDiscoveryStats(): DiscoveryStats {
    return {
      totalDiscovered: this.discoveredPeers.size,
      currentActive: Array.from(this.discoveredPeers.values()).filter((p) => {
        const lastSeenTime = new Date(p.lastSeen).getTime();
        const now = Date.now();
        return now - lastSeenTime < 60000; // 1 minute
      }).length,
      averageDiscoveryTime:
        this.discoveryTimes.length > 0
          ? this.discoveryTimes.reduce((a, b) => a + b, 0) / this.discoveryTimes.length
          : 0,
      methodStats: { ...this.methodStats },
    };
  }

  /**
   * Adds a peer manually to the discovered peers
   */
  addManualPeer(peerId: string, multiaddrs: string[], capabilities?: PeerCapabilities): void {
    const peer: DiscoveredPeer = {
      peerId,
      multiaddrs,
      discoveryMethod: 'manual',
      discoveredAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      capabilities: capabilities ? this.capabilitiesToArray(capabilities) : [],
    };

    this.discoveredPeers.set(peerId, peer);
    this.methodStats.manual++;

    for (const listener of this.discoveryListeners) {
      try {
        listener(peer);
      } catch (error) {
        console.error('Error in discovery listener:', error);
      }
    }
  }

  /**
   * Removes a peer from discovered peers
   */
  removePeer(peerId: string): void {
    this.discoveredPeers.delete(peerId);
  }

  /**
   * Prunes old peers (not seen for more than specified time)
   */
  pruneStalePeers(maxAge: number = 300000): number {
    let pruned = 0;
    const now = Date.now();

    for (const [peerId, peer] of this.discoveredPeers.entries()) {
      const lastSeenTime = new Date(peer.lastSeen).getTime();
      if (now - lastSeenTime > maxAge) {
        this.discoveredPeers.delete(peerId);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Converts capabilities object to string array
   */
  private capabilitiesToArray(capabilities: PeerCapabilities): string[] {
    const arr: string[] = [];
    if (capabilities.supportsFileTransfer) arr.push('file-transfer');
    if (capabilities.supportsWorkspaceSync) arr.push('workspace-sync');
    if (capabilities.supportsRealtimePresence) arr.push('presence');
    arr.push(...capabilities.supportedProtocols);
    return arr;
  }

  /**
   * Filters peers by capability
   */
  filterByCapability(capability: string): DiscoveredPeer[] {
    return Array.from(this.discoveredPeers.values()).filter((peer) =>
      peer.capabilities.includes(capability),
    );
  }

  /**
   * Gets discovery health status
   */
  getDiscoveryHealth(): {
    status: 'healthy' | 'degraded' | 'offline';
    peersFound: number;
    methodsActive: number;
  } {
    const activeMethods = Object.values(this.methodStats).filter((count) => count > 0).length;
    const peersFound = this.discoveredPeers.size;

    let status: 'healthy' | 'degraded' | 'offline' = 'offline';
    if (peersFound > 0 && activeMethods >= 2) {
      status = 'healthy';
    } else if (peersFound > 0) {
      status = 'degraded';
    }

    return { status, peersFound, methodsActive: activeMethods };
  }
}
