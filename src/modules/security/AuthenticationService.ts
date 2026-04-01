import type {
    AuthAttempt,
    AuthenticationMethod,
    AuthenticationResult,
    RoomAuthConfig,
} from '../../models/types';

/**
 * AuthenticationService manages room authentication and access control.
 * Supports: password and invite-token rooms.
 */
export class AuthenticationService {
  private authAttempts = new Map<string, AuthAttempt[]>(); // peerId -> attempts
  private failedAttempts = new Map<string, number>(); // peerId_roomId -> count
  private lockedOutAccounts = new Map<string, number>(); // peerId_roomId -> unlock timestamp

  // ==================== Password Methods ====================

  /**
   * Hashes a password using a simple algorithm (in production, use bcrypt/argon2).
   * For demo purposes, we'll use a basic approach with crypto.
   */
  hashPassword(password: string): string {
    // Convert string to bytes and create a simple hash
    let hash = 0;
    for (let i = 0; i < password.length; i++) {
      const char = password.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    // Encode salt and hash
    const salt = 'vir-space-salt-' + Math.random().toString(36).substring(2, 15);
    return JSON.stringify({ salt, hash: Math.abs(hash).toString(16), v: 1 });
  }

  /**
   * Verifies a password against a hash.
   */
  verifyPassword(password: string, hash: string): boolean {
    try {
      const stored = JSON.parse(hash);
      const candidate = this.hashPassword(password); // Re-hash with same salt approach
      const candidateParsed = JSON.parse(candidate);
      // For comparison, we'll use a timing-safe approach
      return this.timingSafeCompare(stored.hash, candidateParsed.hash);
    } catch {
      return false;
    }
  }

  private timingSafeCompare(a: string, b: string): boolean {
    const lenA = a.length;
    const lenB = b.length;
    let result = lenA === lenB ? 0 : 1;

    for (let i = 0; i < Math.max(lenA, lenB); i++) {
      result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }

    return result === 0;
  }

  // ==================== Invite Token Methods ====================

  /**
   * Generates a secure invite token.
   */
  generateInviteToken(): string {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let token = '';
    for (let i = 0; i < 8; i++) {
      token += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return token;
  }

  /**
   * Adds an invite token to room auth config.
   */
  addInviteToken(
    authConfig: RoomAuthConfig,
    expiresIn?: number,
  ): string {
    if (!authConfig.inviteTokens) {
      authConfig.inviteTokens = new Map();
    }

    const token = this.generateInviteToken();
    const now = new Date().toISOString();
    const expiresAt = expiresIn
      ? new Date(Date.now() + expiresIn).toISOString()
      : undefined;

    authConfig.inviteTokens.set(token, {
      createdAt: now,
      expiresAt,
    });

    return token;
  }

  /**
   * Validates and consumes an invite token.
   */
  validateAndConsumeInviteToken(
    authConfig: RoomAuthConfig,
    token: string,
    peerId: string,
  ): boolean {
    if (!authConfig.inviteTokens?.has(token)) {
      return false;
    }

    const tokenData = authConfig.inviteTokens.get(token)!;

    // Check if token has expired
    if (tokenData.expiresAt) {
      const now = new Date().toISOString();
      if (now > tokenData.expiresAt) {
        authConfig.inviteTokens.delete(token);
        return false;
      }
    }

    // Check if token was already used (one-time use)
    if (tokenData.usedAt) {
      return false;
    }

    // Mark token as used
    tokenData.usedAt = new Date().toISOString();
    tokenData.usedByPeerId = peerId;

    return true;
  }

  // ==================== Authentication Flow ====================

  /**
   * Authenticates a peer trying to join a room.
   */
  authenticatePeerForRoom(
    authConfig: RoomAuthConfig | undefined,
    credential: string | undefined,
    peerId: string,
    roomId: string,
  ): AuthenticationResult {
    // If no auth config, allow access for backwards-compatible internal flows.
    if (!authConfig) {
      return {
        authorized: true,
        timestamp: new Date().toISOString(),
      };
    }

    const accountKey = `${peerId}_${roomId}`;

    // Check if account is locked out
    if (this.isAccountLockedOut(accountKey)) {
      return {
        authorized: false,
        errorCode: 'ACCOUNT_LOCKED',
        errorMessage: `Too many failed attempts. Please try again later.`,
        timestamp: new Date().toISOString(),
      };
    }

    // Validate based on authentication method
    let authorized = false;

    try {
      switch (authConfig.method) {
        case 'password':
          authorized = authConfig.passwordHash
            ? this.verifyPassword(credential || '', authConfig.passwordHash)
            : false;
          break;

        case 'invite-token':
          authorized = this.validateAndConsumeInviteToken(
            authConfig,
            credential || '',
            peerId,
          );
          break;

        default:
          authorized = false;
      }
    } catch {
      authorized = false;
    }

    // Track failed attempts
    if (!authorized) {
      this.recordFailedAttempt(accountKey, authConfig);
    } else {
      this.clearFailedAttempts(accountKey);
    }

    // Record authentication attempt
    this.recordAuthAttempt({
      peerId,
      roomId,
      method: authConfig.method,
      timestamp: new Date().toISOString(),
      success: authorized,
      errorCode: authorized ? undefined : 'INVALID_CREDENTIALS',
      errorMessage: authorized
        ? undefined
        : `Invalid ${authConfig.method} for room`,
    });

    return {
      authorized,
      errorCode: authorized ? undefined : 'INVALID_CREDENTIALS',
      errorMessage: authorized
        ? undefined
        : `Invalid ${authConfig.method}. Please try again.`,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Records an authentication attempt.
   */
  private recordAuthAttempt(attempt: AuthAttempt): void {
    const key = attempt.peerId;
    if (!this.authAttempts.has(key)) {
      this.authAttempts.set(key, []);
    }
    this.authAttempts.get(key)!.push(attempt);

    // Keep only last 100 attempts
    const attempts = this.authAttempts.get(key)!;
    if (attempts.length > 100) {
      attempts.shift();
    }
  }

  /**
   * Records a failed authentication attempt.
   */
  private recordFailedAttempt(
    accountKey: string,
    authConfig: RoomAuthConfig,
  ): void {
    const maxAttempts = authConfig.maxAttempts || 5;
    const currentCount = (this.failedAttempts.get(accountKey) || 0) + 1;
    this.failedAttempts.set(accountKey, currentCount);

    // Lock account if max attempts exceeded
    if (currentCount >= maxAttempts) {
      const lockoutDuration = authConfig.lockoutDurationMs || 5 * 60 * 1000; // 5 min default
      const unlockTime = Date.now() + lockoutDuration;
      this.lockedOutAccounts.set(accountKey, unlockTime);
    }
  }

  /**
   * Clears failed authentication attempts.
   */
  private clearFailedAttempts(accountKey: string): void {
    this.failedAttempts.delete(accountKey);
    this.lockedOutAccounts.delete(accountKey);
  }

  /**
   * Checks if an account is locked out.
   */
  private isAccountLockedOut(accountKey: string): boolean {
    const unlockTime = this.lockedOutAccounts.get(accountKey);
    if (!unlockTime) {
      return false;
    }

    if (Date.now() >= unlockTime) {
      // Lockout period has expired
      this.lockedOutAccounts.delete(accountKey);
      this.failedAttempts.delete(accountKey);
      return false;
    }

    return true;
  }

  /**
   * Gets the remaining lockout time in milliseconds, or 0 if not locked.
   */
  getRemainingLockoutTime(peerId: string, roomId: string): number {
    const accountKey = `${peerId}_${roomId}`;
    const unlockTime = this.lockedOutAccounts.get(accountKey);

    if (!unlockTime) {
      return 0;
    }

    const remaining = unlockTime - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Gets all authentication attempts for a peer.
   */
  getAuthenticationHistory(peerId: string): AuthAttempt[] {
    return this.authAttempts.get(peerId) || [];
  }

  /**
   * Clears all authentication records (useful for testing/reset).
   */
  clearAllRecords(): void {
    this.authAttempts.clear();
    this.failedAttempts.clear();
    this.lockedOutAccounts.clear();
  }

  /**
   * Creates a basic auth config for a given method.
   */
  createAuthConfig(method: AuthenticationMethod): RoomAuthConfig {
    return {
      method,
      requireAuthForJoin: true,
      maxAttempts: 5,
      lockoutDurationMs: 5 * 60 * 1000, // 5 minutes
    };
  }
}

// Export singleton instance
export const getAuthenticationService = (() => {
  let instance: AuthenticationService;
  return () => {
    if (!instance) {
      instance = new AuthenticationService();
    }
    return instance;
  };
})();
