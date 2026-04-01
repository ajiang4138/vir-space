import { describe, expect, it } from 'vitest';
import { TransportEncryptionManager } from './TransportEncryption';

describe('TransportEncryptionManager', () => {
  it('encrypts and decrypts payloads with WebCrypto', async () => {
    const manager = new TransportEncryptionManager();
    manager.setRoomSecret('room-1', 'super-secret-key');

    const payload = {
      type: 'workspace-update',
      operations: [{ id: 'op-1', kind: 'draw', x: 10, y: 20 }],
      auth: { token: 'example-token' },
    };

    const envelope = await manager.encryptPayload('room-1', payload);
    expect(manager.isEncryptedEnvelope(envelope)).toBe(true);
    expect(envelope.ciphertext).not.toContain('workspace-update');
    expect(envelope.ciphertext).not.toContain('example-token');

    const decrypted = await manager.decryptPayload('room-1', envelope);
    expect(decrypted).toEqual(payload);
  });

  it('fails decryption when room secret does not match', async () => {
    const sender = new TransportEncryptionManager();
    sender.setRoomSecret('room-1', 'secret-a');

    const receiver = new TransportEncryptionManager();
    receiver.setRoomSecret('room-1', 'secret-b');

    const envelope = await sender.encryptPayload('room-1', { type: 'auth', token: 'abc' });

    await expect(receiver.decryptPayload('room-1', envelope)).rejects.toThrow();
  });
});
