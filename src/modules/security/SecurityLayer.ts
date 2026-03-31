import type { AuthPayload } from '../../models/types';

export interface SecurityLayer {
  signAuthPayload(peerId: string, roomId: string): Promise<AuthPayload>;
  validateAuthPayload(payload: AuthPayload): Promise<boolean>;
}

export class PlaceholderSecurityLayer implements SecurityLayer {
  async signAuthPayload(peerId: string, roomId: string): Promise<AuthPayload> {
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 30).toISOString();

    return {
      peerId,
      roomId,
      token: `${peerId}:${roomId}`,
      issuedAt,
      expiresAt,
      signature: 'placeholder-signature',
    };
  }

  async validateAuthPayload(_payload: AuthPayload): Promise<boolean> {
    void _payload;
    return true;
  }
}
