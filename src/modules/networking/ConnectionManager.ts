/**
 * ConnectionManager.ts
 *
 * Manages peer-to-peer connections within rooms and handles:
 * - Connection lifecycle (open, maintain, close)
 * - Connection pooling
 * - Automatic reconnection
 * - Connection health monitoring
 * - Graceful connection closure
 */

// ==================== Connection Types ====================
export type ConnectionProtocol = 'tcp' | 'webrtc' | 'websocket' | 'unknown';

export interface ConnectionInfo {
  connectionId: string;
  roomId: string;
  peerId: string;
  protocol: ConnectionProtocol;
  established: boolean;
  createdAt: string;
  lastActivityAt: string;
  bytesReceived: number;
  bytesSent: number;
  consecutiveHeartbeatFailures: number;
}

export interface ConnectionPoolStats {
  totalConnections: number;
  activeConnections: number;
  reconnectingConnections: number;
  stalledConnections: number;
  availableConnectionSlots: number;
}

// ==================== Connection Manager ====================
export class ConnectionManager {
  private connections = new Map<string, ConnectionInfo>();
  private connectionsByRoom = new Map<string, Set<string>>();
  private heartbeatIntervals = new Map<string, NodeJS.Timeout>();
  private reconnectIntervals = new Map<string, NodeJS.Timeout>();

  private static readonly MAX_CONNECTIONS_PER_ROOM = 100;
  private static readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private static readonly HEARTBEAT_TIMEOUT = 10000; // 10 seconds
  private static readonly MAX_FAILED_HEARTBEATS = 3;
  private static readonly RECONNECT_DELAY = 5000; // 5 seconds

  constructor() {}

  /**
   * Opens a connection to a peer in a room
   */
  async openConnection(
    roomId: string,
    peerId: string,
    protocol: ConnectionProtocol = 'tcp',
  ): Promise<ConnectionInfo> {
    // Check if connection already exists
    const existingConnectionId = this.findConnectionId(roomId, peerId);
    if (existingConnectionId) {
      const existing = this.connections.get(existingConnectionId)!;
      if (existing.established) {
        return existing;
      }
    }

    // Check room capacity
    const roomConnections = this.connectionsByRoom.get(roomId) || new Set();
    if (roomConnections.size >= ConnectionManager.MAX_CONNECTIONS_PER_ROOM) {
      throw new Error(`Room ${roomId} has reached maximum connections limit`);
    }

    // Create new connection
    const connectionId = this.generateConnectionId(roomId, peerId);
    const connectionInfo: ConnectionInfo = {
      connectionId,
      roomId,
      peerId,
      protocol,
      established: true,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      bytesReceived: 0,
      bytesSent: 0,
      consecutiveHeartbeatFailures: 0,
    };

    this.connections.set(connectionId, connectionInfo);

    if (!roomConnections.has(connectionId)) {
      roomConnections.add(connectionId);
      this.connectionsByRoom.set(roomId, roomConnections);
    }

    // Start heartbeat
    this.startHeartbeat(connectionId);

    return connectionInfo;
  }

  /**
   * Closes a connection
   */
  async closeConnection(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    // Stop heartbeat
    this.stopHeartbeat(connectionId);

    // Remove from room connections
    const roomConnections = this.connectionsByRoom.get(connection.roomId);
    if (roomConnections) {
      roomConnections.delete(connectionId);
    }

    // Remove connection
    this.connections.delete(connectionId);
  }

  /**
   * Gets connection info
   */
  getConnection(connectionId: string): ConnectionInfo | null {
    return this.connections.get(connectionId) || null;
  }

  /**
   * Gets all connections for a room
   */
  getRoomConnections(roomId: string): ConnectionInfo[] {
    const connectionIds = this.connectionsByRoom.get(roomId) || new Set();
    return Array.from(connectionIds)
      .map((id) => this.connections.get(id))
      .filter((c) => c !== undefined) as ConnectionInfo[];
  }

  /**
   * Gets all connections
   */
  getAllConnections(): ConnectionInfo[] {
    return Array.from(this.connections.values());
  }

  /**
   * Records data sent on a connection
   */
  recordDataSent(connectionId: string, bytes: number): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.bytesSent += bytes;
      connection.lastActivityAt = new Date().toISOString();
    }
  }

  /**
   * Records data received on a connection
   */
  recordDataReceived(connectionId: string, bytes: number): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.bytesReceived += bytes;
      connection.lastActivityAt = new Date().toISOString();
      connection.consecutiveHeartbeatFailures = 0; // Reset heartbeat failures
    }
  }

  /**
   * Gets connection pool statistics
   */
  getStats(): ConnectionPoolStats {
    const allConnections = Array.from(this.connections.values());
    const activeConnections = allConnections.filter((c) => c.established).length;

    return {
      totalConnections: allConnections.length,
      activeConnections,
      reconnectingConnections: this.reconnectIntervals.size,
      stalledConnections: allConnections.filter((c) => this.isConnectionStalled(c)).length,
      availableConnectionSlots:
        ConnectionManager.MAX_CONNECTIONS_PER_ROOM -
        Math.max(
          ...Array.from(this.connectionsByRoom.values()).map((s) => s.size),
          0,
        ),
    };
  }

  /**
   * Closes all connections in a room
   */
  async closeRoomConnections(roomId: string): Promise<void> {
    const connectionIds = Array.from(this.connectionsByRoom.get(roomId) ?? new Set<string>());

    for (const connectionId of connectionIds) {
      await this.closeConnection(connectionId);
    }

    this.connectionsByRoom.delete(roomId);
  }

  /**
   * Starts heartbeat for a connection
   */
  private startHeartbeat(connectionId: string): void {
    if (this.heartbeatIntervals.has(connectionId)) {
      return; // Already running
    }

    const interval = setInterval(async () => {
      const connection = this.connections.get(connectionId);
      if (!connection) {
        this.stopHeartbeat(connectionId);
        return;
      }

      try {
        // Simulate heartbeat check
        const isHealthy = await this.performHealthCheck(connectionId);

        if (!isHealthy) {
          connection.consecutiveHeartbeatFailures++;

          if (
            connection.consecutiveHeartbeatFailures >= ConnectionManager.MAX_FAILED_HEARTBEATS
          ) {
            console.warn(
              `Connection ${connectionId} failed heartbeat checks. Attempting reconnection.`,
            );
            await this.attemptReconnection(connectionId);
          }
        } else {
          connection.consecutiveHeartbeatFailures = 0;
        }
      } catch (error) {
        console.error(`Error during heartbeat for connection ${connectionId}:`, error);
      }
    }, ConnectionManager.HEARTBEAT_INTERVAL);

    this.heartbeatIntervals.set(connectionId, interval);
  }

  /**
   * Stops heartbeat for a connection
   */
  private stopHeartbeat(connectionId: string): void {
    const interval = this.heartbeatIntervals.get(connectionId);
    if (interval) {
      clearInterval(interval);
      this.heartbeatIntervals.delete(connectionId);
    }
  }

  /**
   * Performs a health check on the connection
   */
  private async performHealthCheck(_connectionId: string): Promise<boolean> {
    const connection = this.connections.get(_connectionId);
    if (!connection) {
      return false;
    }

    const idleMs = Date.now() - new Date(connection.lastActivityAt).getTime();
    return idleMs <= ConnectionManager.HEARTBEAT_TIMEOUT;
  }

  /**
   * Attempts to reconnect a failed connection
   */
  private async attemptReconnection(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    connection.established = false;

    if (this.reconnectIntervals.has(connectionId)) {
      return; // Already reconnecting
    }

    const timeout = setTimeout(async () => {
      try {
        // Try to reconnect
        await this.openConnection(connection.roomId, connection.peerId, connection.protocol);
        this.reconnectIntervals.delete(connectionId);
      } catch (error) {
        console.error(`Reconnection failed for ${connectionId}:`, error);

        // Schedule another attempt if not too many failures
        if (
          connection.consecutiveHeartbeatFailures <
          ConnectionManager.MAX_FAILED_HEARTBEATS * 2
        ) {
          this.reconnectIntervals.set(
            connectionId,
            setTimeout(
              () => this.attemptReconnection(connectionId),
              ConnectionManager.RECONNECT_DELAY,
            ),
          );
        }
      }
    }, ConnectionManager.RECONNECT_DELAY);

    this.reconnectIntervals.set(connectionId, timeout);
  }

  /**
   * Checks if a connection is stalled
   */
  private isConnectionStalled(connection: ConnectionInfo): boolean {
    const now = new Date().getTime();
    const lastActivity = new Date(connection.lastActivityAt).getTime();
    const stallThreshold = 5 * 60 * 1000; // 5 minutes

    return now - lastActivity > stallThreshold;
  }

  /**
   * Finds a connection ID for a peer in a room
   */
  private findConnectionId(roomId: string, peerId: string): string | null {
    const roomConnections = this.connectionsByRoom.get(roomId) || new Set();

    for (const connectionId of roomConnections) {
      const conn = this.connections.get(connectionId);
      if (conn && conn.peerId === peerId) {
        return connectionId;
      }
    }

    return null;
  }

  /**
   * Generates a unique connection ID
   */
  private generateConnectionId(roomId: string, peerId: string): string {
    return `conn-${roomId}-${peerId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Cleanup: clears all connections and intervals
   */
  cleanup(): void {
    // Clear all heartbeat intervals
    for (const interval of this.heartbeatIntervals.values()) {
      clearInterval(interval);
    }
    this.heartbeatIntervals.clear();

    // Clear all reconnect timeouts
    for (const timeout of this.reconnectIntervals.values()) {
      clearTimeout(timeout);
    }
    this.reconnectIntervals.clear();

    // Clear connections
    this.connections.clear();
    this.connectionsByRoom.clear();
  }
}
