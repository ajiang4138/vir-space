# P2P Networking Layer Documentation

## Overview

This document describes the complete peer-to-peer (P2P) networking layer for Vir Space, built on **libp2p**. The networking layer enables direct peer-to-peer communication without a centralized server, supporting multiple simultaneous connections, automatic peer discovery, NAT traversal, and comprehensive monitoring.

## Architecture

### Components

1. **LibP2PNetworkingLayer** (`NetworkingLayer.ts`)
   - Core P2P networking using libp2p
   - Handles peer discovery (mDNS, DHT, Bootstrap)
   - Manages multiple simultaneous peer connections
   - Provides message routing and transport API
   - Handles reconnection logic

2. **PeerDiscoveryManager** (`PeerDiscovery.ts`)
   - Discovers peers using mDNS (local network)
   - Discovers peers using DHT (distributed)
   - Tracks discovered peers and their capabilities
   - Provides peer filtering and health status

3. **ConnectionManager** (`ConnectionManager.ts`)
   - Manages connection lifecycle within rooms
   - Maintains connection pool per room
   - Monitors connection health via heartbeats
   - Handles automatic reconnection
   - Tracks bandwidth and latency per connection

4. **NetworkingUtils** (`NetworkingUtils.ts`)
   - Connection quality metrics calculation
   - Comprehensive diagnostics generation
   - Network state monitoring
   - Trend analysis and health recommendations

5. **IntegratedNetworkingManager** (`NetworkingIntegration.ts`)
   - Combines all networking components
   - Provides high-level API for room operations
   - Manages room lifecycle integration

## Key Features

### 1. Peer Discovery

The system discovers peers using multiple methods simultaneously:

- **mDNS** (Multicast DNS): Local network peer discovery
- **DHT** (Distributed Hash Table): Global peer discovery
- **Bootstrap Nodes**: Connection to well-known bootstrap peers
- **Manual Registration**: Explicit peer registration

```typescript
// Discovered peers are automatically tracked
const discoveredPeers = discoveryManager.getDiscoveredPeers();
```

### 2. Direct Peer Communication

Once peers are discovered, direct connections are established:

```typescript
// Send direct message to specific peer
await networkingManager.sendMessageToPeer(
  roomId,
  targetPeerId,
  { type: 'update', data: {...} }
);

// Broadcast to all peers in room
await networkingManager.broadcastToRoom(
  roomId,
  { type: 'presence', data: {...} }
);
```

### 3. Multiple Simultaneous Connections

Supports up to 100 simultaneous peer connections per room:

```typescript
// Connection manager tracks multiple connections
const stats = connectionManager.getStats();
console.log(`Active connections: ${stats.activeConnections}`);
```

### 4. NAT Traversal

Configured with STUN servers for NAT traversal:

```
STUN Servers:
- stun:stun.l.google.com:19302
- stun:stun1.l.google.com:19302
```

The libp2p layer automatically handles:
- UDP hole punching
- Port mapping discovery
- STUN server queries

### 5. Automatic Reconnection

Failed connections automatically attempt to reconnect:

```typescript
// Reconnection happens automatically
// Max 5 reconnection attempts with 5-second intervals
// Failed connections emit 'reconnect-failed' event
```

## Networking Events

The system emits comprehensive events throughout the connection lifecycle:

### Event Types

1. **peer-discovered** - A new peer has been discovered
2. **connection-opened** - Connection established to a peer
3. **connection-closed** - Connection closed to a peer
4. **message-sent** - Message successfully sent
5. **message-received** - Message received from peer
6. **reconnect-attempt** - Attempting to reconnect
7. **reconnect-success** - Successfully reconnected
8. **reconnect-failed** - Reconnection failed
9. **error** - An error occurred

### Event Listener Example

```typescript
networkingManager.networkingLayer.on('message-received', (event) => {
  console.log('Message from:', event.peerId);
  console.log('Room:', event.roomId);
  console.log('Data:', event.details?.data);
});
```

## API Reference

### INetworkingLayer Interface

```typescript
interface INetworkingLayer {
  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // Messaging
  sendMessage(message: SignalingMessage): Promise<void>;
  sendDirectMessage(roomId: string, toPeerId: string, data: unknown): Promise<void>;
  broadcastToRoom(roomId: string, data: unknown, excludePeerId?: string): Promise<void>;

  // Connection Info
  getPeerConnectionState(peerId: string): PeerConnectionState | null;
  getRoomConnections(roomId: string): RoomPeerConnection[];
  getConnectedPeers(): string[];
  getLocalPeerId(): string;

  // Statistics
  getNetworkingStats(): NetworkingStats;

  // Events
  on(event: NetworkingEventType, listener: (event: NetworkingEvent) => void): void;
  off(event: NetworkingEventType, listener: (event: NetworkingEvent) => void): void;
}
```

### ConnectionManager API

```typescript
interface ConnectionManager {
  // Connection Lifecycle
  openConnection(roomId: string, peerId: string, protocol?: ConnectionProtocol): Promise<ConnectionInfo>;
  closeConnection(connectionId: string): Promise<void>;
  closeRoomConnections(roomId: string): Promise<void>;

  // Connection Info
  getConnection(connectionId: string): ConnectionInfo | null;
  getRoomConnections(roomId: string): ConnectionInfo[];
  getAllConnections(): ConnectionInfo[];

  // Data Tracking
  recordDataSent(connectionId: string, bytes: number): void;
  recordDataReceived(connectionId: string, bytes: number): void;

  // Statistics
  getStats(): ConnectionPoolStats;
}
```

## Usage Examples

### Basic Setup

```typescript
import { IntegratedNetworkingManager } from './modules/networking/NetworkingIntegration';

// Initialize networking
const networking = new IntegratedNetworkingManager();
await networking.initialize();

// Get local peer ID
const localPeerId = networking.networkingLayer.getLocalPeerId();
console.log('Local peer ID:', localPeerId);
```

### Join a Room

```typescript
// Join a room
await networking.joinRoom(room, localPeer);

// Room peers are automatically discovered and connected
const connections = networking.connectionManager.getRoomConnections(room.id);
console.log(`Connected to ${connections.length} peers`);
```

### Send Messages

```typescript
// Send to specific peer
await networking.sendMessageToPeer(
  roomId,
  peerId,
  {
    type: 'workspace-sync',
    fileId: '123',
    content: '...'
  }
);

// Broadcast to room
await networking.broadcastToRoom(
  roomId,
  {
    type: 'cursor-position',
    x: 100,
    y: 200
  },
  true // exclude self
);
```

### Monitor Quality

```typescript
// Record latency measurement
networking.recordLatency(peerId, 45, true); // 45ms, successful

// Get quality metrics
const metrics = networking.getPeerQualityMetrics(peerId);
console.log(`Latency: ${metrics.latency}ms`);
console.log(`Quality: ${metrics.quality}`);
console.log(`Packet Loss: ${metrics.packetLoss}%`);

// Get comprehensive diagnostics
const diagnostics = networking.getDiagnostics();
console.log(networking.getDiagnosticsReport());
```

### Handle Events

```typescript
// Register room-specific event handler
networking.registerRoomEventHandler(roomId, (event) => {
  if (event.type === 'message') {
    console.log('Message:', event.data);
  }
});

// Or listen to global networking events
networking.networkingLayer.on('connection-opened', (event) => {
  console.log('Connected to:', event.peerId);
});

networking.networkingLayer.on('error', (event) => {
  console.error('Network error:', event.error);
});
```

### Diagnostics and Debugging

```typescript
// Print full diagnostics report
networking.printDiagnostics();

// Output:
// === Networking Diagnostics (2026-04-01T12:00:00.000Z) ===
// Overall Health: GOOD
// Local Peer ID: 12D3KooWAbcdef...
//
// --- Peer Connections ---
//   12D3KooWXyzabc...
//     Status: Connected
//     Quality: good
//     Latency: 45ms
//     Bandwidth: 1.23 MB/s
//     Packet Loss: 0.0%
// ...

// Get specific stats
const stats = networking.getNetworkingStats();
console.log('Connected peers:', stats.connectedPeers);
console.log('Bytes received:', stats.totalBytesReceived);
console.log('Bytes sent:', stats.totalBytesSent);

const connStats = networking.getConnectionStats();
console.log('Active connections:', connStats.activeConnections);
```

## Performance Characteristics

### Connection Management

- **Max Connections per Room**: 100
- **Heartbeat Interval**: 30 seconds
- **Heartbeat Timeout**: 10 seconds
- **Max Failed Heartbeats**: 3 before reconnection attempt
- **Reconnection Delay**: 5 seconds between attempts
- **Max Reconnection Attempts**: 5

### Data Tracking

- **Latency Samples**: Last 100 measurements per peer
- **Bandwidth Samples**: Last 100 measurements per peer
- **Diagnostics History**: Last 1000 snapshots
- **Connection Pool**: Unlimited (constrained by room limits)

## Network Requirements

### Ports

- **TCP**: Dynamic (usually 30000-60000 range)
- **UDP**: Dynamic for STUN/ICE
- **mDNS**: UDP 5353 (local network)

### Firewall Requirements

1. **Outbound**: TCP and UDP for direct connections
2. **Inbound**: TCP for incoming peer connections (optional with NAT traversal)
3. **STUN Queries**: UDP to Google STUN servers

## Error Handling

The networking layer handles common errors gracefully:

### Connection Errors

- Automatic reconnection on connection failure
- Event emission for monitoring
- Gradual backoff for repeated failures

### Message Errors

- Failed messages are logged but don't crash the system
- Delivery guarantees depend on underlying protocol

### NAT Traversal Failures

- Graceful degradation if direct connection impossible
- Fallback to indirect routing through relay servers

## Debugging

### Set Log Level

```typescript
import { NetworkingLogger } from './modules/networking/NetworkingLayer';

NetworkingLogger.setLogLevel('debug'); // 'debug' | 'info' | 'warn' | 'error'
```

### Monitor Connections

```typescript
// Watch for connection events
setInterval(() => {
  const peers = networking.networkingLayer.getConnectedPeers();
  console.log('Connected peers:', peers);

  for (const peerId of peers) {
    const state = networking.networkingLayer.getPeerConnectionState(peerId);
    console.log(`${peerId}: ${state?.connected ? 'connected' : 'disconnected'}`);
  }
}, 10000);
```

### Health Check

```typescript
function checkNetworkHealth() {
  const diagnostics = networking.getDiagnostics();

  console.log(`Health: ${diagnostics.overallHealth}`);
  console.log(`Recommendations:`);
  for (const rec of diagnostics.recommendations) {
    console.log(`  ${rec}`);
  }
}

// Run health check every minute
setInterval(checkNetworkHealth, 60000);
```

## Integration with RoomManager

The networking layer integrates seamlessly with RoomManager:

```typescript
import { RoomManager } from './modules/room-peer/RoomManager';
import { IntegratedNetworkingManager } from './modules/networking/NetworkingIntegration';

const roomManager = new RoomManager();
const networking = new IntegratedNetworkingManager();

await networking.initialize();

// Create and join room
const room = roomManager.createRoom('My Room', localPeer);
await networking.joinRoom(room, localPeer);

// Broadcast presence updates
const unsubscribe = roomManager.onMembershipEvent((event) => {
  if (event.type === 'peer-joined') {
    networking.broadcastToRoom(room.id, {
      type: 'peer-status',
      peerId: event.peerId,
      status: 'online'
    });
  }
});
```

## Testing

### Local Testing

1. Start multiple instances of the application
2. Each instance creates a peer node
3. mDNS discovers peers on local network
4. Connections are established automatically

### Remote Testing

1. Configure bootstrap nodes
2. Connect to public DHT
3. Peers discover each other across the internet
4. Direct connections established via STUN

## Troubleshooting

### Peers Not Being Discovered

1. Check firewall settings
2. Verify mDNS is enabled locally
3. Check DHT bootstrap configuration
4. Enable debug logging

### Connection Failures

1. Check network connectivity
2. Verify firewall allows TCP/UDP
3. Review error logs
4. Check STUN server availability

### High Latency

1. Check network conditions
2. Monitor CPU and memory usage
3. Check packet loss percentage
4. Consider peer proximity

### Bandwidth Issues

1. Check network bandwidth availability
2. Monitor active connections
3. Review message sizes
4. Consider message compression

## Future Enhancements

1. **WebRTC Data Channels**: For browser compatibility
2. **Message Encryption**: End-to-end encryption for messages
3. **Bandwidth Limiting**: Rate limiting and QoS
4. **Custom Protocols**: Support for application-specific protocols
5. **Network Conditions Simulation**: For testing
6. **Relay Servers**: For peers behind restrictive firewalls

## Security Considerations

1. **Noise Protocol**: Encryption of all connections
2. **Peer Identification**: Cryptographic peer IDs
3. **TLS over TCP**: Optional additional encryption
4. **Message Validation**: Application-level validation required
5. **Rate Limiting**: Implement at application level

## References

- [libp2p Documentation](https://docs.libp2p.io/)
- [STUN (RFC 5389)](https://tools.ietf.org/html/rfc5389)
- [TURN (RFC 5766)](https://tools.ietf.org/html/rfc5766)
- [NAT Traversal Techniques](https://en.wikipedia.org/wiki/NAT_traversal)
