# Security and Encryption In Transit

## Overview
This project now applies two layers of in-transit protection for peer-to-peer communication:

1. Transport encryption (channel security)
- libp2p peer links use Noise protocol encryption.
- WebSocket fallback enforces secure endpoints (`wss://`) for non-local traffic.

2. Application payload encryption (message security)
- Peer payloads are encrypted with WebCrypto (`AES-GCM`) before transmission.
- Keys are derived with PBKDF2-SHA256 from per-room shared secrets.
- Encrypted envelope metadata includes version, IV, and salt, while payload data is never sent in plaintext.

## Scope: What Is Encrypted
The encrypted payload path applies to all data carried by peer messaging APIs:

- Workspace synchronization updates
- Authentication payloads and room credentials exchanged over peer transport
- File transfer signaling/metadata and any file-transfer control messages

Any traffic sent through `sendDirectMessage` or room broadcast is encrypted before bytes are counted/transmitted.

## Implementation Locations
- Transport encryption utility:
  - `src/modules/security/TransportEncryption.ts`
- Networking integration and transport enforcement:
  - `src/modules/networking/NetworkingLayer.ts`
- Validation tests:
  - `src/modules/security/TransportEncryption.test.ts`
  - `src/modules/networking/NetworkingLayer.test.ts`

## Security Initialization and Audit Logging
During network startup, the networking layer logs:
- transport security initialization
- selected secure transport (`libp2p-noise`)
- payload encryption mode (`AES-GCM`)

WebSocket setup logs transport policy validation and whether secure transport is active.

## Validation Steps
Use the following checks to confirm traffic is encrypted and plaintext is not exposed.

1. Unit tests for cryptography and transport policy
```bash
npm run test -- src/modules/security/TransportEncryption.test.ts src/modules/networking/NetworkingLayer.test.ts
```

2. Lint and full test validation
```bash
npm run lint && npm run test
```

3. Runtime inspection of outbound payloads
- Attach a `message-sent` listener and verify `event.details.encrypted === true`.
- Confirm message payloads are encrypted envelopes (`__encrypted: true`) instead of raw business objects.

4. Negative validation for insecure WebSocket
- Attempt `ws://example.com/...` and verify connection setup is blocked.
- Confirm `wss://...` succeeds.

## Operational Guidance
- Set explicit per-room transport secrets early in room setup using `setRoomTransportSecret(roomId, secret)`.
- Rotate room transport secrets when room membership changes.
- Keep WebCrypto available in runtime environments; startup fails if unavailable.
