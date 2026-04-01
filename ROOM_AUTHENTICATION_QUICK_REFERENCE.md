# Room Authentication - Quick Reference

## Quick Start

### Create Public Room (No Auth)
```typescript
const room = roomManager.createRoom('Team Space', owner, false, 'public');
// Anyone can join
await roomManager.joinRoom(room.id, peer);
```

### Create Password-Protected Room
```typescript
const room = roomManager.createRoom('Private', owner, true, 'password');
roomManager.setRoomPassword(room.id, 'SecurePass123');

// Joining requires password
await roomManager.joinRoom(room.id, peer, { credential: 'SecurePass123' });
```

### Create Invite-Token Room
```typescript
const room = roomManager.createRoom('Exclusive', owner, true, 'invite-token');
const token = roomManager.addRoomInviteToken(room.id);  // "ABCD1234"

// Share token with users
// They join: await roomManager.joinRoom(room.id, peer, { credential: token });
```

### Create Shared-Secret Room
```typescript
const room = roomManager.createRoom('Secret', owner, true, 'shared-secret');
roomManager.setRoomSharedSecret(room.id, 'sharedSecret@123');

// Join with secret
await roomManager.joinRoom(room.id, peer, { credential: 'sharedSecret@123' });
```

## Error Handling

```typescript
import { AuthenticationError } from './RoomPeerManager';

try {
  await roomManager.joinRoom(roomId, peer, { credential });
} catch (error) {
  if (error instanceof AuthenticationError) {
    if (error.code === 'INVALID_CREDENTIALS') {
      console.error('Wrong credential');
    } else if (error.code === 'ACCOUNT_LOCKED') {
      const mins = Math.ceil((error.remainingLockout || 0) / 1000 / 60);
      console.error(`Try again in ${mins} minutes`);
    } else if (error.code === 'ROOM_NOT_FOUND') {
      console.error('Room does not exist');
    }
  }
}
```

## UI Flow - Two Page Integration

### CreateRoomPage
- Select auth method (radio buttons)
- Enter room name
- If not public: enter credentials
- Confirm and create

### JoinRoomPage
- Enter room ID
- If auth required: prompted for credentials
- With retry counter (X/5 attempts)
- Shows lockout countdown

## Configuration

```typescript
const config = authService.createAuthConfig('password');
config.maxAttempts = 10;           // Default: 5
config.lockoutDurationMs = 15 * 60 * 1000;  // Default: 5 min
```

## Query Methods

```typescript
// Get auth method for a room
const method = roomManager.getRoomAuthMethod(roomId);  // 'password' | 'public' | ...

// Check if password protected
const protected = roomManager.isRoomPasswordProtected(roomId);  // true | false

// Check remaining lockout time
const remaining = authService.getRemainingLockoutTime(peerId, roomId);  // milliseconds
```

## Auth Methods Summary

| Method | Storage | One-Time | Expiry | Use Case |
|--------|---------|----------|--------|----------|
| Public | None | N/A | N/A | Open collaboration |
| Password | Hash | No | No | General protection |
| Shared-Secret | Hash | No | No | Group access |
| Invite-Token | Map | Yes | Optional | Controlled access |

## Security Features

✓ Hash-based storage (no plaintext)
✓ Timing-safe comparison  
✓ Account lockout (5 attempts → 5 min)
✓ Token one-time use
✓ Audit trail tracking
✓ Configurable parameters

## Error Codes Reference

| Code | Meaning | User Message |
|------|---------|--------------|
| `INVALID_CREDENTIALS` | Wrong password/secret/token | "Invalid. Try again." |
| `ACCOUNT_LOCKED` | 5+ failed attempts | "Too many tries. Wait X min." |
| `ROOM_NOT_FOUND` | Room doesn't exist | "Room not found." |
| `AUTHENTICATION_REQUIRED` | Auth needed but not provided | "Please provide credentials." |
| `EXPIRED_TOKEN` | Token expired | "Code expired. Get new one." |

## Files Overview

| File | Purpose | Lines |
|------|---------|-------|
| `AuthenticationService` | Core auth logic | 260 |
| `RoomPeerManager` | Room + auth mgmt | 500+ |
| `RoomManager` | Public API | 200+ |
| `RoomAuthentication.test.ts` | Tests | 450+ |
| `CreateRoomPage` | Auth setup UI | 200+ |
| `JoinRoomPage` | Auth join flow | 200+ |

## Common Tasks

### Generate new invite token
```typescript
const token = roomManager.addRoomInviteToken(roomId);
// Optional expiration (24 hours)
const tokenExpiring = roomManager.addRoomInviteToken(roomId, 24*60*60*1000);
```

### Verify if peer can authenticate
```typescript
const authorized = roomManager.authenticateForRoom(roomId, peerId, credential);
```

### Check join attempt history
```typescript
const history = authService.getAuthenticationHistory(peerId);
history.forEach(attempt => {
  console.log(`${attempt.timestamp}: ${attempt.success ? 'OK' : 'FAIL'}`);
});
```

### Reset all authentication records
```typescript
authService.clearAllRecords();  // For testing/debugging only
```

## Testing

```bash
# Run authentication tests
npm run test -- RoomAuthentication.test.ts

# Run all tests
npm run test
```

## Production Checklist

- [ ] Review `ROOM_AUTHENTICATION_GUIDE.md` for full API
- [ ] Run test suite: `npm run test`
- [ ] Test each auth method manually
- [ ] Test lockout mechanism
- [ ] Test UI error states
- [ ] Consider bcrypt for production hashing
- [ ] Plan credential rotation strategy
- [ ] Set up audit logging
- [ ] Add monitoring/alerting for lockouts
- [ ] Document for your team

## Documentation

- **Full Guide:** `ROOM_AUTHENTICATION_GUIDE.md`
- **Implementation Summary:** `ROOM_AUTHENTICATION_SUMMARY.md`
- **Tests:** `RoomAuthentication.test.ts` (self-documenting)
- **Code Comments:** Extensive inline documentation
