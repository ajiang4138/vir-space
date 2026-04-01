# Room Authentication & Access Control - Implementation Guide

## Overview

A complete room authentication and access control system that protects room access while maintaining flexibility for different use cases. Supports four authentication methods: public, password-protected, shared-secret, and invite-token-based access.

## Features

✅ **Four Authentication Methods**
- Public rooms - anyone can join
- Password-protected - room-level password authentication  
- Shared secret - cryptographic shared secret validation
- Invite tokens - one-time use invite codes

✅ **Security Features**
- Account lockout after failed attempts (default: 5 attempts, 5-minute lockout)
- Timing-safe credential comparison (prevents timing attacks)
- Hash-based credential storage (no plaintext)
- Attempt tracking and audit trail
- Configurable security parameters

✅ **User Experience**
- Clear error messages for authentication failures
- Multi-step UI for authentication
- Visual feedback on lockout status
- Remaining lockout time display

✅ **Type Safety**
- Full TypeScript support
- Compile-time type checking for auth configs
- Error types for better error handling

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  CreateRoomPage / JoinRoomPage          │
│                   UI Layer (React Components)            │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────v────────────────────────────────────┐
│         RoomManager (Orchestration Layer)               │
│  - createRoom() with authMethod parameter              │
│  - joinRoom() with credential options                  │
│  - setRoomPassword/setRoomSharedSecret                │
│  - addRoomInviteToken()                                │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────v────────────────────────────────────┐
│    RoomPeerManager (Room Management)                     │
│  - Enforces authentication on join                      │
│  - Stores room auth configs                            │
│  - Tracks authenticated peers                          │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────v────────────────────────────────────┐
│    AuthenticationService (Core Auth Logic)              │
│  - Password hashing & verification                      │
│  - Shared secret validation                             │
│  - Invite token generation & validation                 │
│  - Attempt tracking & account lockout                   │
│  - History & audit trail                                │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────v────────────────────────────────────┐
│      SecurityLayer (Payload Signing & Validation)       │
│  - Crypto signing of auth payloads                      │
│  - Payload validation & expiration checks               │
│  - Integration with auth service                        │
└─────────────────────────────────────────────────────────┘
```

## Data Types

### RoomAuthConfig
```typescript
interface RoomAuthConfig {
  method: 'password' | 'shared-secret' | 'invite-token' | 'public';
  passwordHash?: string;           // For password method
  secretHash?: string;             // For shared-secret method
  inviteTokens?: Map<...>;        // For invite-token method
  requireAuthForJoin: boolean;     // Authentication enforcement flag
  maxAttempts?: number;            // Failed attempt limit (default: 5)
  lockoutDurationMs?: number;      // Account lockout duration (default: 5 min)
}
```

### AuthenticationResult
```typescript
interface AuthenticationResult {
  authorized: boolean;
  errorCode?: string;              // 'INVALID_CREDENTIALS' | 'ACCOUNT_LOCKED'
  errorMessage?: string;
  timestamp: string;
}
```

### JoinRoomOptions
```typescript
interface JoinRoomOptions {
  credential?: string;            // Password, secret, or invite token
  attemptId?: string;             // Optional attempt tracking ID
}
```

## Usage Examples

### 1. Creating a Public Room

```typescript
const roomManager = getRoomManager();
const owner = { id: 'peer-1', displayName: 'Alice', ... };

// Create public room (no authentication)
const room = roomManager.createRoom('Team Workspace', owner, false, 'public');
// Anyone can join without credentials
const joined = await roomManager.joinRoom(room.id, joiningPeer);
```

### 2. Creating a Password-Protected Room

```typescript
// Create password-protected room
const room = roomManager.createRoom('Private Team', owner, true, 'password');

// Set the password
roomManager.setRoomPassword(room.id, 'SecurePass123!');

// Others must provide password to join
const joined = await roomManager.joinRoom(room.id, joiningPeer, {
  credential: 'SecurePass123!'
});
```

### 3. Creating a Shared Secret Room

```typescript
// Create shared-secret room
const room = roomManager.createRoom('Secure Space', owner, true, 'shared-secret');

// Set the shared secret
roomManager.setRoomSharedSecret(room.id, 'sharedSecret@123');

// Others must provide the secret
const joined = await roomManager.joinRoom(room.id, joiningPeer, {
  credential: 'sharedSecret@123'
});
```

### 4. Creating an Invite-Token Room

```typescript
// Create invite-token room
const room = roomManager.createRoom('Exclusive Room', owner, true, 'invite-token');

// Generate invite tokens
const token1 = roomManager.addRoomInviteToken(room.id);  // No expiry
const token2 = roomManager.addRoomInviteToken(room.id, 24 * 60 * 60 * 1000); // 24 hours

// Others join with a token (one-time use)
const joined = await roomManager.joinRoom(room.id, joiningPeer, {
  credential: token1
});

// Same token cannot be reused
const joined2 = await roomManager.joinRoom(room.id, anotherPeer, {
  credential: token1  // Will fail - already used
});
```

### 5. Handling Authentication Errors

```typescript
import { AuthenticationError } from './RoomPeerManager';

try {
  await roomManager.joinRoom(roomId, peer, { credential: userInput });
} catch (error) {
  if (error instanceof AuthenticationError) {
    if (error.code === 'INVALID_CREDENTIALS') {
      // Show "Invalid password" message
      console.error('Wrong credential');
    } else if (error.code === 'ACCOUNT_LOCKED') {
      const minutes = Math.ceil((error.remainingLockout || 0) / 1000 / 60);
      // Show "Try again in X minutes"
      console.error(`Locked for ${minutes} more minutes`);
    } else if (error.code === 'ROOM_NOT_FOUND') {
      // Show "Room not found" message
      console.error('Room does not exist');
    }
  }
}
```

## UI Flow - Join Room with Authentication

```
┌─────────────────────────────────┐
│ Enter Room ID                   │
│ [Room ID Input] [Join]          │
└──────────────┬──────────────────┘
               │
        ┌──────v──────┐
        │ Room Found? │
        └──┬───────┬──┘
           │       │
        No │       │ Yes
        ┌──v──┐  ┌─v──────────────────┐
        │Error│  │ Auth Required?     │
        └─────┘  └─┬┬────────────┬────┘
                  ││            │
              No ││            │ Yes
         ┌───────v┘│      ┌────v──────────────┐
         │ Join    │      │ Show Auth Prompt  │
         │         │      │ [Credential Input]│
         └─────────┘      │ [Authenticate]    │
                          └────┬─────────┬────┘
                               │         │
                           Pass│         │Fail
                          ┌────v──┐  ┌──v──────┐
                          │ Join  │  │ Error + │
                          │       │  │ Retry   │
                          └───────┘  └─────────┘
```

## UI Flow - Create Room with Authentication

```
┌──────────────────────────────────────────┐
│ Select Authentication Method              │
│ ○ Public    ○ Password                    │
│ ○ Secret    ○ Invite Token               │
└──────────┬───────────────────────────────┘
           │
    ┌──────v──────────────┐
    │ Method Specific UI  │
    │ - Password: 2 inputs│
    │ - Secret: 2 inputs  │
    │ - Token: Generate   │
    │ - Public: none      │
    └──────┬──────────────┘
           │
    ┌──────v──────────────┐
    │ Create Room         │
    │ Set Auth Config     │
    │ Room Created ✓      │
    └─────────────────────┘
```

## Security Considerations

### 1. Credential Storage
- Passwords and secrets are **hashed**, never stored plaintext
- Uses a simple but sufficient hashing for demo purposes
- Production should use bcrypt or Argon2

### 2. Timing-Safe Comparison
- Credential verification uses timing-safe comparison
- Prevents timing-based attacks on password guessing

### 3. Account Lockout
- Automatic lockout after 5 failed attempts (configurable)
- 5-minute lockout period by default (configurable)
- Resets on successful authentication

### 4. Invite Tokens
- One-time use - once consumed, token is marked used
- Can have expiration times
- Randomly generated 8-character tokens

### 5. Transport Security
- This implementation handles authentication logic
- In production, should transmit credentials over TLS/HTTPS
- Consider end-to-end encryption for sensitive applications

## Configuration

### Modifying Lockout Parameters

```typescript
const authConfig = authService.createAuthConfig('password');
authConfig.maxAttempts = 10;           // Increase to 10 attempts
authConfig.lockoutDurationMs = 15 * 60 * 1000;  // 15 minutes

// Apply to room
roomManager.setRoomPassword(roomId, password);
// Then update config on the room
```

### Invite Token Expiration

```typescript
// Generate token that expires in 7 days
const token = roomManager.addRoomInviteToken(
  roomId, 
  7 * 24 * 60 * 60 * 1000  // 7 days in milliseconds
);
```

## Testing

Run the comprehensive test suite:

```bash
npm run test -- RoomAuthentication.test.ts
```

Tests cover:
- Password hashing and verification ✓
- Invite token generation and validation ✓
- Shared secret handling ✓
- Authentication flow ✓
- Account lockout mechanism ✓
- Public/private room access ✓
- Token reuse prevention ✓
- Integration scenarios ✓

## API Reference

### RoomManager Methods

```typescript
// Create room with auth
createRoom(name: string, owner: Peer, isPrivate: boolean, authMethod?: string): Room

// Join room (possibly with credential)
joinRoom(roomId: string, peer: Peer, options?: JoinRoomOptions): Promise<Room>

// Set room password
setRoomPassword(roomId: string, password: string): void

// Set room shared secret
setRoomSharedSecret(roomId: string, secret: string): void

// Generate and add invite token
addRoomInviteToken(roomId: string, expiresIn?: number): string

// Direct authentication
authenticateForRoom(roomId: string, peerId: string, credential: string): boolean

// Query room auth method
getRoomAuthMethod(roomId: string): string | null

// Check if password protected
isRoomPasswordProtected(roomId: string): boolean
```

### AuthenticationService Methods

```typescript
// Password operations
hashPassword(password: string): string
verifyPassword(password: string, hash: string): boolean

// Invite tokens
generateInviteToken(): string
addInviteToken(authConfig: RoomAuthConfig, expiresIn?: number): string
validateAndConsumeInviteToken(authConfig: RoomAuthConfig, token: string, peerId: string): boolean

// Shared secret
hashSharedSecret(secret: string): string
verifySharedSecret(secret: string, hash: string): boolean

// Main authentication flow
authenticatePeerForRoom(
  authConfig: RoomAuthConfig | undefined,
  credential: string | undefined,
  peerId: string,
  roomId: string
): AuthenticationResult

// Query and management
getRemainingLockoutTime(peerId: string, roomId: string): number
getAuthenticationHistory(peerId: string): AuthAttempt[]
clearAllRecords(): void
```

## Error Codes

| Code | Meaning | What to Do |
|------|---------|-----------|
| `INVALID_CREDENTIALS` | Wrong password/secret/token | Ask user to try again |
| `ACCOUNT_LOCKED` | Too many failed attempts | Wait for lockout to expire |
| `ROOM_NOT_FOUND` | Room ID doesn't exist | Verify room ID |
| `AUTHENTICATION_REQUIRED` | Room requires auth | Prompt for credential |
| `EXPIRED_TOKEN` | Invite token expired | Request new token |

## Integration Checklist

- ✅ Room creation with auth method selection
- ✅ Join flow with credential input  
- ✅ Password-protected rooms
- ✅ Shared-secret rooms
- ✅ Invite-token rooms
- ✅ Public rooms (no auth)
- ✅ Account lockout mechanism
- ✅ Error handling and reporting
- ✅ UI feedback for auth states  
- ✅ Test coverage
- ✅ SecurityLayer integration
- ✅ Type-safe implementation

## Future Enhancements

1. **Multi-factor Authentication**
   - Require multiple credentials
   - Time-based one-time passwords (TOTP)

2. **Role-Based Access Control**
   - Different access levels (owner, admin, member, viewer)
   - Permission-scoped join

3. **OAuth/Social Login**
   - GitHub, Google authentication
   - Enterprise SSO integration

4. **Credential Rotation**
   - Periodic password/secret rotation
   - Automatic challenges at intervals

5. **Audit Logging**
   - Detailed audit trails
   - Export logs for compliance
   - Suspicious activity detection

6. **Advanced Token Features**
   - Scoped tokens (time, usage limits)
   - Hierarchical tokens
   - Token renewal

## Troubleshooting

### Q: User is locked out after failed attempts
**A:** Check lockout time with `getRemainingLockoutTime()`. Wait for duration to expire or reset via `clearAllRecords()`.

### Q: Invite token not working
**A:** Ensure token hasn't expired or been used. Generate new with `addRoomInviteToken()`.

### Q: Password comparison failing inconsistently  
**A:** This shouldn't happen - hashing is deterministic. Check password hash storage.

### Q: Need to change room auth method
**A:** Create a new auth config and assign via `setRoomPassword()` or similar methods.

## Support

For issues, questions, or feature requests related to authentication:
1. Check test file for usage examples
2. Review error codes and handling
3. Consult this guide's architecture section
4. Check SecurityLayer for integration points
