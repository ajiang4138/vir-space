/**
 * RoomManagerNetworkingExample.ts
 *
 * Example showing how to integrate the P2P networking layer
 * with the existing RoomManager for a complete peer-to-peer
 * multi-user workspace system.
 */

import type { Peer } from '../../models/types';
import { RoomManager } from '../room-peer/RoomManager';
import { IntegratedNetworkingManager } from './NetworkingIntegration';

/**
 * Example: Creating and joining a room with P2P networking
 */
export async function exampleCreateAndJoinRoom() {
  // Initialize components
  const roomManager = new RoomManager();
  const networking = new IntegratedNetworkingManager();

  try {
    // Start networking layer
    await networking.initialize();
    console.log('✅ Networking initialized');

    // Create a room
    const owner: Peer = {
      id: 'peer-001',
      displayName: 'Alice',
      status: 'online',
      capabilities: ['file-transfer', 'workspace-sync'],
      lastSeenAt: new Date().toISOString(),
    };

    const room = roomManager.createRoom('Design Workspace', owner, false);
    console.log(`✅ Room created: ${room.name} (${room.id})`);

    // Join the room with networking
    await networking.joinRoom(room, owner);
    console.log(`✅ Joined room with P2P networking`);

    // Another peer joins
    const peer2: Peer = {
      id: 'peer-002',
      displayName: 'Bob',
      status: 'online',
      capabilities: ['file-transfer', 'workspace-sync'],
      lastSeenAt: new Date().toISOString(),
    };

    const updatedRoom = await roomManager.joinRoom(room.id, peer2);
    await networking.joinRoom(updatedRoom, peer2);
    console.log(`✅ Peer Bob joined the room`);

    // Broadcast peer presence
    await networking.broadcastToRoom(
      room.id,
      {
        type: 'peer-joined',
        peerId: peer2.id,
        displayName: peer2.displayName,
        status: peer2.status,
      },
      false, // Don't exclude Bob
    );

    return { roomManager, networking, room };
  } catch (error) {
    console.error('❌ Error in room setup:', error);
    throw error;
  }
}

/**
 * Example: Sending workspace updates over P2P network
 */
export async function exampleBroadcastWorkspaceUpdate(
  networking: IntegratedNetworkingManager,
  roomId: string,
) {
  const workspaceUpdate = {
    type: 'workspace-update',
    timestamp: new Date().toISOString(),
    changes: [
      {
        fileId: 'file-123',
        fileName: 'design.sketch',
        operation: 'modified',
        content: '...',
      },
    ],
    metadata: {
      updatedBy: 'peer-001',
      totalFiles: 5,
    },
  };

  try {
    await networking.broadcastToRoom(roomId, workspaceUpdate, true); // Exclude self
    console.log('✅ Workspace update broadcast to all peers');
  } catch (error) {
    console.error('❌ Failed to broadcast workspace update:', error);
  }
}

/**
 * Example: Sending a file transfer initiation message
 */
export async function exampleInitiateFileTransfer(
  networking: IntegratedNetworkingManager,
  roomId: string,
  targetPeerId: string,
  fileId: string,
  fileName: string,
  fileSize: number,
) {
  const fileTransferMessage = {
    type: 'file-transfer-request',
    fileId,
    fileName,
    fileSize,
    mimeType: 'application/octet-stream',
    timestamp: new Date().toISOString(),
    transferId: `transfer-${Date.now()}`,
  };

  try {
    await networking.sendMessageToPeer(roomId, targetPeerId, fileTransferMessage);
    console.log(`✅ File transfer request sent to ${targetPeerId}`);
  } catch (error) {
    console.error('❌ Failed to send file transfer request:', error);
  }
}

/**
 * Example: Monitoring peer presence and connectivity
 */
export async function exampleMonitorPeerPresence(
  roomManager: RoomManager,
  networking: IntegratedNetworkingManager,
  roomId: string,
) {
  // Listen to room membership events
  const unsubscribeMembership = roomManager.onMembershipEvent((event) => {
    if (event.type === 'peer-joined') {
      console.log(`👤 Peer joined: ${event.peer?.displayName}`);

      // Broadcast welcome message
      networking
        .broadcastToRoom(
          roomId,
          {
            type: 'peer-welcome',
            peerId: event.peerId,
            welcomeMessage: `Welcome ${event.peer?.displayName}!`,
          },
          false, // Include the joined peer
        )
        .catch((error) => console.error('Failed to send welcome:', error));
    } else if (event.type === 'peer-left') {
      console.log(`👋 Peer left: ${event.peerId}`);
    }
  });

  // Listen to networking events
  networking.onNetworkingEvent('connection-opened', (evt) => {
    console.log(`🔗 Connected to peer: ${evt.peerId}`);
  });

  networking.onNetworkingEvent('connection-closed', (evt) => {
    console.log(`❌ Disconnected from peer: ${evt.peerId}`);
  });

  networking.onNetworkingEvent('reconnect-attempt', (evt) => {
    console.log(`🔄 Reconnecting to ${evt.peerId}...`);
  });

  // Return cleanup function
  return () => {
    unsubscribeMembership();
  };
}

/**
 * Example: Health monitoring and diagnostics
 */
export async function exampleMonitorNetworkHealth(
  networking: IntegratedNetworkingManager,
) {
  console.log('\n📊 Network Health Report:');
  console.log('='.repeat(50));

  // Print full diagnostics
  networking.printDiagnostics();

  // Get specific stats
  const stats = networking.getNetworkingStats();
  console.log('\n📈 Network Statistics:');
  console.log(`  Connected Peers: ${stats.connectedPeers}`);
  console.log(`  Bytes Received: ${(stats.totalBytesReceived / 1024).toFixed(2)} KB`);
  console.log(`  Bytes Sent: ${(stats.totalBytesSent / 1024).toFixed(2)} KB`);
  console.log(`  Avg Latency: ${stats.averageLatency.toFixed(0)}ms`);
  console.log(`  Reconnection Attempts: ${stats.reconnectionAttempts}`);

  // Get connection pool stats
  const connStats = networking.getConnectionStats();
  console.log('\n🔌 Connection Pool:');
  console.log(`  Total Connections: ${connStats.totalConnections}`);
  console.log(`  Active Connections: ${connStats.activeConnections}`);
  console.log(`  Stalled Connections: ${connStats.stalledConnections}`);
  console.log(`  Available Slots: ${connStats.availableConnectionSlots}/100`);
}

/**
 * Example: Responding to incoming messages
 */
export async function exampleHandleIncomingMessages(
  networking: IntegratedNetworkingManager,
  roomId: string,
) {
  const unsubscribe = networking.registerRoomEventHandler(roomId, (event) => {
    if (event.type === 'message') {
      const msg = event.data as {
        fromPeerId: string;
        data?: {
          type?: string;
          fileName?: string;
          fileSize?: number;
          changes?: unknown[];
          status?: string;
        };
      };
      const { fromPeerId, data } = msg;

      console.log(`📨 Message from ${fromPeerId}: ${data?.type}`);

      if (data?.type === 'file-transfer-request') {
        const sizeKb = typeof data.fileSize === 'number' ? (data.fileSize / 1024).toFixed(2) : '0.00';
        console.log(`   File: ${data.fileName} (${sizeKb} KB)`);
        // Handle file transfer request
      } else if (data?.type === 'workspace-update') {
        console.log(`   Workspace updated with ${data.changes?.length || 0} changes`);
        // Handle workspace update
      } else if (data?.type === 'peer-presence') {
        console.log(`   Peer presence: ${data.status}`);
        // Handle presence update
      }
    }
  });

  return unsubscribe;
}

/**
 * Example: Graceful shutdown
 */
export async function exampleGracefulShutdown(
  roomManager: RoomManager,
  networking: IntegratedNetworkingManager,
  roomId: string,
  peerId: string,
) {
  try {
    console.log('🔌 Initiating graceful shutdown...');

    // Broadcast goodbye message
    await networking.broadcastToRoom(roomId, {
      type: 'peer-leaving',
      peerId,
      message: 'Peer is leaving the room',
    });

    // Leave the room
    await roomManager.leaveRoom(roomId, peerId);
    console.log('✅ Left room');

    // Shutdown networking
    await networking.shutdown();
    console.log('✅ Networking shutdown complete');
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
  }
}

/**
 * Complete Example: Full Workflow
 */
export async function completeExample() {
  console.log('🚀 Starting P2P Networking Example\n');

  let cleanup: (() => void) | null = null;
  let messageHandler: (() => void) | null = null;

  try {
    // Step 1: Create and join room
    console.log('Step 1: Creating and joining room...');
    const { roomManager, networking, room } = await exampleCreateAndJoinRoom();

    // Step 2: Monitor peer presence
    console.log('\nStep 2: Setting up presence monitoring...');
    cleanup = await exampleMonitorPeerPresence(roomManager, networking, room.id);

    // Step 3: Set up message handling
    console.log('Step 3: Setting up message handler...');
    messageHandler = await exampleHandleIncomingMessages(networking, room.id);

    // Step 4: Broadcast workspace update
    console.log('\nStep 4: Broadcasting workspace update...');
    await exampleBroadcastWorkspaceUpdate(networking, room.id);

    // Step 5: Initiate file transfer
    console.log('\nStep 5: Initiating file transfer...');
    const peers = networking.getConnectedPeers();
    if (peers.length > 0) {
      await exampleInitiateFileTransfer(
        networking,
        room.id,
        peers[0],
        'file-123',
        'document.pdf',
        2048000,
      );
    }

    // Step 6: Monitor health
    console.log('\nStep 6: Network health check...');
    await exampleMonitorNetworkHealth(networking);

    // Keep running for a bit
    console.log('\n⏳ Running for 5 seconds...');
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Step 7: Graceful shutdown
    console.log('\nStep 7: Graceful shutdown...');
    await exampleGracefulShutdown(roomManager, networking, room.id, 'peer-001');

    console.log('\n✅ Example completed successfully!');
  } catch (error) {
    console.error('❌ Example failed:', error);
  } finally {
    // Cleanup
    if (cleanup) cleanup();
    if (messageHandler) messageHandler();
  }
}

// Uncomment to run the example:
// completeExample().catch(console.error);

/**
 * Summary of Integration Points:
 *
 * 1. **Room Creation**
 *    - RoomManager creates room
 *    - Networking joins room with all peers
 *
 * 2. **Peer Discovery**
 *    - mDNS finds local peers
 *    - DHT finds remote peers
 *    - Direct connections established automatically
 *
 * 3. **Event Synchronization**
 *    - RoomManager emits membership events
 *    - Networking broadcasts these to peers
 *    - All peers stay in sync
 *
 * 4. **Message Communication**
 *    - Workspace updates sent via P2P
 *    - File transfers initiated over P2P
 *    - Real-time presence updates broadcast
 *
 * 5. **Health Monitoring**
 *    - Network diagnostics available
 *    - Quality metrics per peer
 *    - Health recommendations
 *
 * 6. **Error Recovery**
 *    - Automatic reconnection on failures
 *    - Graceful degradation
 *    - User notification via events
 *
 * 7. **Shutdown**
 *    - Graceful peer disconnection
 *    - Broadcast goodbye messages
 *    - Clean resource cleanup
 */
