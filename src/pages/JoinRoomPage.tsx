import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Form, TextInput } from '../components/ui';
import type { Peer, Room } from '../models/types';
import { getRoomManager } from '../modules/room-peer/RoomManager';
import { AuthenticationError, RoomLogger } from '../modules/room-peer/RoomPeerManager';
import { useUIStore } from '../store/useUIStore';

interface JoinState {
  step: 'initial' | 'auth-required' | 'joining';
  roomId: string;
  authMethod?: string;
  attempts: number;
}

export function JoinRoomPage() {
  const navigate = useNavigate();
  const store = useUIStore();
  const roomManager = getRoomManager();

  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({ roomId: '', credential: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [joinState, setJoinState] = useState<JoinState>({
    step: 'initial',
    roomId: '',
    attempts: 0,
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) {
      setErrors((prev) => ({ ...prev, [name]: '' }));
    }
  };

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!formData.roomId.trim()) {
      newErrors.roomId = 'Room ID or invite code is required';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  const handleInitialJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setLoading(true);
    try {
      if (!store.currentPeerId) {
        throw new Error('Current peer ID not set');
      }

      // Create peer object for joining
      const peer = {
        id: store.currentPeerId,
        displayName: store.currentPeerName,
        status: 'online' as const,
        capabilities: ['edit', 'view'],
        lastSeenAt: new Date().toISOString(),
      };

      // Try to join the room without credentials first
      try {
        const room = await roomManager.joinRoom(formData.roomId, peer);

        // Successfully joined without authentication
        completeRoomJoin(room, peer);
      } catch (error) {
        if (error instanceof AuthenticationError) {
          if (error.code === 'ROOM_NOT_FOUND') {
            store.addStatusMessage({
              type: 'error',
              message: 'Room not found. Check the ID and try again.',
              duration: 3000,
            });
          } else if (error.code === 'ACCOUNT_LOCKED') {
            const remainingMinutes = Math.ceil((error.remainingLockout || 0) / 1000 / 60);
            store.addStatusMessage({
              type: 'error',
              message: `Too many failed attempts. Try again in ${remainingMinutes} minute(s).`,
              duration: 5000,
            });
          } else {
            // Authentication required
            const authMethod = roomManager.getRoomAuthMethod(formData.roomId);
            setJoinState({
              step: 'auth-required',
              roomId: formData.roomId,
              authMethod: authMethod || 'password',
              attempts: 0,
            });
            store.addStatusMessage({
              type: 'info',
              message: `This room requires authentication via ${authMethod || 'password'}.`,
              duration: 3000,
            });
          }
        } else {
          throw error;
        }
      }
    } catch (error) {
      RoomLogger.error('Failed to join room', {
        error: error instanceof Error ? error.message : String(error),
        roomId: formData.roomId,
      });
      store.addStatusMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to join room.',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleAuthenticationSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.credential.trim()) {
      setErrors({ credential: 'Credential is required' });
      return;
    }

    setLoading(true);
    try {
      if (!store.currentPeerId) {
        throw new Error('Current peer ID not set');
      }

      const peer = {
        id: store.currentPeerId,
        displayName: store.currentPeerName,
        status: 'online' as const,
        capabilities: ['edit', 'view'],
        lastSeenAt: new Date().toISOString(),
      };

      // Try to join with credential
      const room = await roomManager.joinRoom(joinState.roomId, peer, {
        credential: formData.credential,
      });

      completeRoomJoin(room, peer);
    } catch (error) {
      if (error instanceof AuthenticationError) {
        const newAttempts = joinState.attempts + 1;
        setJoinState((prev) => ({ ...prev, attempts: newAttempts }));

        if (error.code === 'ACCOUNT_LOCKED') {
          const remainingMinutes = Math.ceil((error.remainingLockout || 0) / 1000 / 60);
          store.addStatusMessage({
            type: 'error',
            message: `Account locked due to multiple failed attempts. Try again in ${remainingMinutes} minute(s).`,
            duration: 5000,
          });
          setJoinState({ step: 'initial', roomId: '', attempts: 0 });
          setFormData({ roomId: '', credential: '' });
        } else {
          setErrors({
            credential: `Invalid credential (attempt ${newAttempts}/5)`,
          });
          store.addStatusMessage({
            type: 'error',
            message: `Invalid ${joinState.authMethod}. Please try again.`,
            duration: 3000,
          });
        }
      } else {
        RoomLogger.error('Failed to join room with credential', {
          error: error instanceof Error ? error.message : String(error),
          roomId: joinState.roomId,
        });
        store.addStatusMessage({
          type: 'error',
          message: error instanceof Error ? error.message : 'Authentication failed.',
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const completeRoomJoin = (room: Room, peer: Peer) => {
    RoomLogger.info('Room joined from UI', {
      roomId: room.id,
      peerId: peer.id,
    });

    // Set current room in store
    store.setCurrentRoom(room);

    // Add the joining peer and all room peers to known peers
    store.addKnownPeer(peer);
    room.peers.forEach((p: Peer) => {
      if (p.id !== peer.id) {
        store.addKnownPeer(p);
      }
    });

    store.addStatusMessage({
      type: 'success',
      message: `Successfully joined "${room.name}"`,
      duration: 4000,
    });

    navigate('/workspace');
  };

  const handleReset = () => {
    setJoinState({ step: 'initial', roomId: '', attempts: 0 });
    setFormData({ roomId: '', credential: '' });
    setErrors({});
  };

  return (
    <div className="mx-auto max-w-md">
      {joinState.step === 'initial' ? (
        <Form title="Join an Existing Room" onSubmit={handleInitialJoin}>
          <TextInput
            label="Room ID or Invite Code"
            name="roomId"
            placeholder="e.g., room-123abc or INVITE-CODE"
            value={formData.roomId}
            onChange={handleChange}
            error={errors.roomId}
            required
          />

          <div className="rounded-lg bg-blue-50 p-3">
            <p className="text-sm text-blue-900">
              💡 You can get the room ID from the room creator or an active participant.
            </p>
          </div>

          <div className="flex gap-3 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => navigate('/')}
            >
              Cancel
            </Button>
            <Button type="submit" loading={loading}>
              Join Room
            </Button>
          </div>
        </Form>
      ) : (
        <Form title={`Authenticate to Join Room`} onSubmit={handleAuthenticationSubmit}>
          <div className="mb-4 rounded-lg bg-amber-50 p-3">
            <p className="text-sm font-semibold text-amber-900">
              🔐 This room requires authentication
            </p>
            <p className="mt-1 text-sm text-amber-800">
              Method: <span className="font-medium">{joinState.authMethod}</span>
            </p>
          </div>

          {joinState.authMethod === 'invite-token' ? (
            <TextInput
              label="Invite Token"
              name="credential"
              placeholder="Enter the 8-character invite code"
              value={formData.credential}
              onChange={handleChange}
              error={errors.credential}
              required
              maxLength={8}
            />
          ) : (
            <TextInput
              label={joinState.authMethod === 'invite-token' ? 'Invite Token' : 'Room Password'}
              name="credential"
              type={joinState.authMethod === 'invite-token' ? 'text' : 'password'}
              placeholder={`Enter the ${joinState.authMethod === 'invite-token' ? 'invite token' : 'password'}`}
              value={formData.credential}
              onChange={handleChange}
              error={errors.credential}
              required
            />
          )}

          <div className="mt-4 rounded-lg bg-blue-50 p-3">
            <p className="text-sm text-blue-900">
              💡 Enter the credential provided by the room creator or an active member.
            </p>
          </div>

          <div className="flex gap-3 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={handleReset}
              disabled={loading}
            >
              Back
            </Button>
            <Button type="submit" loading={loading}>
              Authenticate & Join
            </Button>
          </div>
        </Form>
      )}
    </div>
  );
}
