export interface EncryptedPayloadEnvelope {
  __encrypted: true;
  version: 1;
  algorithm: 'AES-GCM';
  salt: string;
  iv: string;
  ciphertext: string;
  createdAt: string;
}

export interface TransportSecurityReport {
  webCryptoAvailable: boolean;
  configuredRooms: number;
  fallbackSecretUsageCount: number;
}

export class TransportEncryptionManager {
  private static readonly PBKDF2_ITERATIONS = 120_000;
  private static readonly AES_KEY_LENGTH = 256;
  private static readonly SALT_LENGTH = 16;
  private static readonly IV_LENGTH = 12;

  private roomSecrets = new Map<string, string>();
  private fallbackSecretUsageCount = 0;

  setRoomSecret(roomId: string, secret: string): void {
    this.roomSecrets.set(roomId, secret);
  }

  getSecurityReport(): TransportSecurityReport {
    return {
      webCryptoAvailable: typeof globalThis.crypto?.subtle !== 'undefined',
      configuredRooms: this.roomSecrets.size,
      fallbackSecretUsageCount: this.fallbackSecretUsageCount,
    };
  }

  isEncryptedEnvelope(payload: unknown): payload is EncryptedPayloadEnvelope {
    if (!payload || typeof payload !== 'object') {
      return false;
    }

    const candidate = payload as Partial<EncryptedPayloadEnvelope>;
    return (
      candidate.__encrypted === true &&
      candidate.version === 1 &&
      candidate.algorithm === 'AES-GCM' &&
      typeof candidate.salt === 'string' &&
      typeof candidate.iv === 'string' &&
      typeof candidate.ciphertext === 'string'
    );
  }

  async encryptPayload(roomId: string, payload: unknown): Promise<EncryptedPayloadEnvelope> {
    const subtle = this.requireSubtleCrypto();
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));

    const salt = globalThis.crypto.getRandomValues(new Uint8Array(TransportEncryptionManager.SALT_LENGTH));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(TransportEncryptionManager.IV_LENGTH));
    const key = await this.deriveRoomKey(roomId, salt, subtle);

    const encrypted = await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: this.toArrayBuffer(iv),
      },
      key,
      this.toArrayBuffer(plaintext),
    );

    return {
      __encrypted: true,
      version: 1,
      algorithm: 'AES-GCM',
      salt: this.toBase64(salt),
      iv: this.toBase64(iv),
      ciphertext: this.toBase64(new Uint8Array(encrypted)),
      createdAt: new Date().toISOString(),
    };
  }

  async decryptPayload(roomId: string, envelope: EncryptedPayloadEnvelope): Promise<unknown> {
    const subtle = this.requireSubtleCrypto();

    const salt = this.fromBase64(envelope.salt);
    const iv = this.fromBase64(envelope.iv);
    const ciphertext = this.fromBase64(envelope.ciphertext);

    const key = await this.deriveRoomKey(roomId, salt, subtle);
    const decrypted = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: this.toArrayBuffer(iv),
      },
      key,
      this.toArrayBuffer(ciphertext),
    );

    return JSON.parse(new TextDecoder().decode(decrypted));
  }

  private async deriveRoomKey(
    roomId: string,
    salt: Uint8Array,
    subtle: SubtleCrypto,
  ): Promise<CryptoKey> {
    const roomSecret = this.resolveRoomSecret(roomId);
    const secretBytes = new TextEncoder().encode(roomSecret);

    const keyMaterial = await subtle.importKey('raw', secretBytes, 'PBKDF2', false, ['deriveKey']);

    return subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: this.toArrayBuffer(salt),
        iterations: TransportEncryptionManager.PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      keyMaterial,
      {
        name: 'AES-GCM',
        length: TransportEncryptionManager.AES_KEY_LENGTH,
      },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  private resolveRoomSecret(roomId: string): string {
    const explicitSecret = this.roomSecrets.get(roomId);
    if (explicitSecret) {
      return explicitSecret;
    }

    this.fallbackSecretUsageCount++;
    return `vir-space-room-fallback:${roomId}`;
  }

  private requireSubtleCrypto(): SubtleCrypto {
    if (!globalThis.crypto?.subtle) {
      throw new Error('WebCrypto subtle API is required for transport encryption');
    }
    return globalThis.crypto.subtle;
  }

  private toBase64(bytes: Uint8Array): string {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(bytes).toString('base64');
    }

    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  private fromBase64(value: string): Uint8Array {
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(value, 'base64'));
    }

    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  private toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
}
