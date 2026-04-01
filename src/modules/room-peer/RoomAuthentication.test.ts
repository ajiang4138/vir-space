import { beforeEach, describe, expect, it } from 'vitest';
import type { Peer } from '../../models/types';
import { AuthenticationService } from '../security/AuthenticationService';
import { AuthenticationError, InMemoryRoomPeerManager } from './RoomPeerManager';

describe('AuthenticationService', () => {
  let authService: AuthenticationService;

  beforeEach(() => {
    authService = new AuthenticationService();
  });

  // ==================== Password Hashing Tests ====================
  describe('Password Hashing', () => {
    it('should hash a password', () => {
      const password = 'mysecurepassword';
      const hash = authService.hashPassword(password);

      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash).toContain('hash');
    });

    it('should verify correct password', () => {
      const password = 'mysecurepassword';
      const hash = authService.hashPassword(password);

      expect(authService.verifyPassword(password, hash)).toBe(true);
    });

    it('should reject incorrect password', () => {
      const password = 'mysecurepassword';
      const wrong = 'wrongpassword';
      const hash = authService.hashPassword(password);

      expect(authService.verifyPassword(wrong, hash)).toBe(false);
    });

    it('should reject invalid hash format', () => {
      expect(authService.verifyPassword('password', 'invalid-hash')).toBe(false);
    });
  });

  // ==================== Invite Token Tests ====================
  describe('Invite Tokens', () => {
    it('should generate a valid invite token', () => {
      const token = authService.generateInviteToken();

      expect(token).toBeDefined();
      expect(token.length).toBe(8);
      expect(/^[A-Z0-9]{8}$/.test(token)).toBe(true);
    });

    it('should generate unique tokens', () => {
      const token1 = authService.generateInviteToken();
      const token2 = authService.generateInviteToken();

      expect(token1).not.toBe(token2);
    });

    it('should add invite token to auth config', () => {
      const config = authService.createAuthConfig('invite-token');
      const token = authService.addInviteToken(config);

      expect(config.inviteTokens?.has(token)).toBe(true);
      expect(token.length).toBe(8);
    });

    it('should validate and consume invite token', () => {
      const config = authService.createAuthConfig('invite-token');
      const token = authService.addInviteToken(config);
      const peerId = 'test-peer-1';

      const valid = authService.validateAndConsumeInviteToken(config, token, peerId);

      expect(valid).toBe(true);
      expect(config.inviteTokens?.get(token)?.usedAt).toBeDefined();
      expect(config.inviteTokens?.get(token)?.usedByPeerId).toBe(peerId);
    });

    it('should reject already consumed token', () => {
      const config = authService.createAuthConfig('invite-token');
      const token = authService.addInviteToken(config);
      const peerId = 'test-peer-1';

      authService.validateAndConsumeInviteToken(config, token, peerId);
      const secondUse = authService.validateAndConsumeInviteToken(
        config,
        token,
        'test-peer-2',
      );

      expect(secondUse).toBe(false);
    });

    it('should reject expired invite token', () => {
      const config = authService.createAuthConfig('invite-token');
      const expiresIn = -1000; // Already expired
      const token = authService.addInviteToken(config, expiresIn);
      const peerId = 'test-peer-1';

      const valid = authService.validateAndConsumeInviteToken(config, token, peerId);

      expect(valid).toBe(false);
    });
  });

  // ==================== Shared Secret Tests ====================
  describe('Shared Secret', () => {
    it('should hash and verify shared secret', () => {
      const secret = 'shared-secret-value';
      const hash = authService.hashSharedSecret(secret);

      expect(authService.verifySharedSecret(secret, hash)).toBe(true);
    });

    it('should reject incorrect shared secret', () => {
      const secret = 'shared-secret-value';
      const wrong = 'wrong-secret';
      const hash = authService.hashSharedSecret(secret);

      expect(authService.verifySharedSecret(wrong, hash)).toBe(false);
    });
  });

  // ==================== Authentication Flow Tests ====================
  describe('Authentication Flow', () => {
    it('should authorize for public rooms (no auth config)', () => {
      const result = authService.authenticatePeerForRoom(
        undefined,
        'any-credential',
        'peer-1',
        'room-1',
      );

      expect(result.authorized).toBe(true);
      expect(result.errorCode).toBeUndefined();
    });

    it('should authorize with correct password', () => {
      const config = authService.createAuthConfig('password');
      config.passwordHash = authService.hashPassword('secret123');

      const result = authService.authenticatePeerForRoom(
        config,
        'secret123',
        'peer-1',
        'room-1',
      );

      expect(result.authorized).toBe(true);
    });

    it('should reject with incorrect password', () => {
      const config = authService.createAuthConfig('password');
      config.passwordHash = authService.hashPassword('secret123');

      const result = authService.authenticatePeerForRoom(
        config,
        'wrongpassword',
        'peer-1',
        'room-1',
      );

      expect(result.authorized).toBe(false);
      expect(result.errorCode).toBe('INVALID_CREDENTIALS');
    });

    it('should authorize with valid invite token', () => {
      const config = authService.createAuthConfig('invite-token');
      const token = authService.addInviteToken(config);

      const result = authService.authenticatePeerForRoom(
        config,
        token,
        'peer-1',
        'room-1',
      );

      expect(result.authorized).toBe(true);
    });

    it('should reject invalid invite token', () => {
      const config = authService.createAuthConfig('invite-token');

      const result = authService.authenticatePeerForRoom(
        config,
        'INVALID00',
        'peer-1',
        'room-1',
      );

      expect(result.authorized).toBe(false);
      expect(result.errorCode).toBe('INVALID_CREDENTIALS');
    });

    it('should track failed attempts', () => {
      const config = authService.createAuthConfig('password');
      config.passwordHash = authService.hashPassword('secret123');

      // First failed attempt
      authService.authenticatePeerForRoom(config, 'wrong', 'peer-1', 'room-1');
      let remaining = authService.getRemainingLockoutTime('peer-1', 'room-1');
      expect(remaining).toBe(0);

      // Make max attempts - 1
      for (let i = 0; i < 3; i++) {
        authService.authenticatePeerForRoom(config, 'wrong', 'peer-1', 'room-1');
      }

      remaining = authService.getRemainingLockoutTime('peer-1', 'room-1');
      expect(remaining).toBe(0);

      // Final failed attempt should lock
      authService.authenticatePeerForRoom(config, 'wrong', 'peer-1', 'room-1');
      remaining = authService.getRemainingLockoutTime('peer-1', 'room-1');
      expect(remaining).toBeGreaterThan(0);
    });

    it('should reject authentication when account is locked', () => {
      const config = authService.createAuthConfig('password');
      config.passwordHash = authService.hashPassword('secret123');

      // Trigger lockout
      for (let i = 0; i < 5; i++) {
        authService.authenticatePeerForRoom(config, 'wrong', 'peer-1', 'room-1');
      }

      // Should be locked
      const result = authService.authenticatePeerForRoom(
        config,
        'secret123', // Even correct password is rejected
        'peer-1',
        'room-1',
      );

      expect(result.authorized).toBe(false);
      expect(result.errorCode).toBe('ACCOUNT_LOCKED');
      
      // Check remaining lockout time separately
      const remaining = authService.getRemainingLockoutTime('peer-1', 'room-1');
      expect(remaining).toBeGreaterThan(0);
    });
  });

  // ==================== Configuration Tests ====================
  describe('Configuration', () => {
    it('should create password auth config', () => {
      const config = authService.createAuthConfig('password');

      expect(config.method).toBe('password');
      expect(config.requireAuthForJoin).toBe(true);
      expect(config.maxAttempts).toBe(5);
      expect(config.lockoutDurationMs).toBe(5 * 60 * 1000);
    });

    it('should create invite-token config', () => {
      const config = authService.createAuthConfig('invite-token');

      expect(config.method).toBe('invite-token');
      expect(config.requireAuthForJoin).toBe(true);
    });
  });

  // ==================== History Tests ====================
  describe('History', () => {
    it('should track authentication attempts', () => {
      const config = authService.createAuthConfig('password');
      config.passwordHash = authService.hashPassword('secret123');

      authService.authenticatePeerForRoom(config, 'wrong1', 'peer-1', 'room-1');
      authService.authenticatePeerForRoom(config, 'secret123', 'peer-1', 'room-1');

      const history = authService.getAuthenticationHistory('peer-1');

      expect(history.length).toBe(2);
      expect(history[0].success).toBe(false);
      expect(history[1].success).toBe(true);
    });
  });
});

describe('Room Authentication Integration', () => {
  let roomManager: InMemoryRoomPeerManager;
  let ownerPeer: Peer;
  let joiningPeer: Peer;

  beforeEach(() => {
    roomManager = new InMemoryRoomPeerManager();
    ownerPeer = {
      id: 'owner-1',
      displayName: 'Room Owner',
      status: 'online',
      capabilities: ['admin', 'edit'],
      lastSeenAt: new Date().toISOString(),
    };
    joiningPeer = {
      id: 'peer-1',
      displayName: 'Joining Peer',
      status: 'online',
      capabilities: ['edit'],
      lastSeenAt: new Date().toISOString(),
    };
  });

  // ==================== Public Room Tests ====================
  describe('Public Rooms', () => {
    it('should allow joining public room without credentials', async () => {
      const room = roomManager.createRoom('Public Room', ownerPeer, false, 'public');

      const result = await roomManager.joinRoom(room.id, joiningPeer);

      expect(result.peers.some((p) => p.id === joiningPeer.id)).toBe(true);
    });

    it('should be discoverable in public rooms list', async () => {
      roomManager.createRoom('Public Room', ownerPeer, false, 'public');

      const rooms = await roomManager.discoverRooms();

      expect(rooms.length).toBeGreaterThan(0);
      expect(rooms.some((r) => r.name === 'Public Room')).toBe(true);
    });
  });

  // ==================== Password Protected Rooms ====================
  describe('Password Protected Rooms', () => {
    it('should reject join without password', async () => {
      const room = roomManager.createRoom(
        'Protected Room',
        ownerPeer,
        true,
        'password',
      );
      roomManager.setRoomPassword(room.id, 'secure123');

      await expect(
        roomManager.joinRoom(room.id, joiningPeer),
      ).rejects.toThrow(AuthenticationError);
    });

    it('should reject join with wrong password', async () => {
      const room = roomManager.createRoom(
        'Protected Room',
        ownerPeer,
        true,
        'password',
      );
      roomManager.setRoomPassword(room.id, 'secure123');

      await expect(
        roomManager.joinRoom(room.id, joiningPeer, {
          credential: 'wrongpassword',
        }),
      ).rejects.toThrow(AuthenticationError);
    });

    it('should allow join with correct password', async () => {
      const room = roomManager.createRoom(
        'Protected Room',
        ownerPeer,
        true,
        'password',
      );
      roomManager.setRoomPassword(room.id, 'secure123');

      const result = await roomManager.joinRoom(room.id, joiningPeer, {
        credential: 'secure123',
      });

      expect(result.peers.some((p) => p.id === joiningPeer.id)).toBe(true);
    });
  });

  // ==================== Invite Token Rooms ====================
  describe('Invite Token Rooms', () => {
    it('should reject join without invite token', async () => {
      const room = roomManager.createRoom(
        'Token Room',
        ownerPeer,
        true,
        'invite-token',
      );

      await expect(
        roomManager.joinRoom(room.id, joiningPeer),
      ).rejects.toThrow(AuthenticationError);
    });

    it('should reject join with invalid token', async () => {
      const room = roomManager.createRoom(
        'Token Room',
        ownerPeer,
        true,
        'invite-token',
      );

      await expect(
        roomManager.joinRoom(room.id, joiningPeer, { credential: 'INVALID00' }),
      ).rejects.toThrow(AuthenticationError);
    });

    it('should allow join with valid invite token', async () => {
      const room = roomManager.createRoom(
        'Token Room',
        ownerPeer,
        true,
        'invite-token',
      );
      const token = roomManager.addRoomInviteToken(room.id);

      const result = await roomManager.joinRoom(room.id, joiningPeer, {
        credential: token,
      });

      expect(result.peers.some((p) => p.id === joiningPeer.id)).toBe(true);
    });

    it('should reject reuse of token', async () => {
      const room = roomManager.createRoom(
        'Token Room',
        ownerPeer,
        true,
        'invite-token',
      );
      const token = roomManager.addRoomInviteToken(room.id);

      // First use should work
      const peer1 = {
        ...joiningPeer,
        id: 'peer-1',
      };
      await roomManager.joinRoom(room.id, peer1, { credential: token });

      // Second use should fail
      const peer2 = {
        ...joiningPeer,
        id: 'peer-2',
      };
      await expect(
        roomManager.joinRoom(room.id, peer2, { credential: token }),
      ).rejects.toThrow();
    });
  });

  // ==================== Shared Secret Rooms ====================
  describe('Shared Secret Rooms', () => {
    it('should require shared secret to join', async () => {
      const room = roomManager.createRoom(
        'Secret Room',
        ownerPeer,
        true,
        'shared-secret',
      );
      roomManager.setRoomSharedSecret(room.id, 'my-secret');

      await expect(
        roomManager.joinRoom(room.id, joiningPeer),
      ).rejects.toThrow(AuthenticationError);
    });

    it('should allow join with correct secret', async () => {
      const room = roomManager.createRoom(
        'Secret Room',
        ownerPeer,
        true,
        'shared-secret',
      );
      roomManager.setRoomSharedSecret(room.id, 'my-secret');

      const result = await roomManager.joinRoom(room.id, joiningPeer, {
        credential: 'my-secret',
      });

      expect(result.peers.some((p) => p.id === joiningPeer.id)).toBe(true);
    });
  });

  // ==================== Authentication Query Tests ====================
  describe('Authentication Queries', () => {
    it('should report auth method for room', () => {
      const room = roomManager.createRoom(
        'Protected',
        ownerPeer,
        true,
        'password',
      );

      const method = roomManager.getRoomAuthMethod(room.id);

      expect(method).toBe('password');
    });

    it('should report if room is password protected', () => {
      const room = roomManager.createRoom(
        'Protected',
        ownerPeer,
        true,
        'password',
      );

      const protected_ = roomManager.isRoomPasswordProtected(room.id);

      expect(protected_).toBe(true);
    });

    it('should return false for non-password rooms', () => {
      const room = roomManager.createRoom(
        'Public',
        ownerPeer,
        false,
        'public',
      );

      const protected_ = roomManager.isRoomPasswordProtected(room.id);

      expect(protected_).toBe(false);
    });
  });
});
