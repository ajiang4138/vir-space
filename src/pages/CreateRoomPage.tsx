import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Form, TextInput } from '../components/ui';
import { getRoomManager } from '../modules/room-peer/RoomManager';
import { RoomLogger } from '../modules/room-peer/RoomPeerManager';
import { useUIStore } from '../store/useUIStore';

type AuthMethod = 'public' | 'password' | 'shared-secret' | 'invite-token';

export function CreateRoomPage() {
  const navigate = useNavigate();
  const store = useUIStore();
  const roomManager = getRoomManager();

  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    roomName: '',
    authMethod: 'public' as AuthMethod,
    credential: '',
    confirmCredential: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) {
      setErrors((prev) => ({ ...prev, [name]: '' }));
    }
  };

  const validate = () => {
    const newErrors: Record<string, string> = {};

    // Validate room name
    if (!formData.roomName.trim()) {
      newErrors.roomName = 'Room name is required';
    } else if (formData.roomName.length > 100) {
      newErrors.roomName = 'Room name must be 100 characters or less';
    }

    // Validate credential based on auth method
    if (formData.authMethod !== 'public') {
      if (!formData.credential.trim()) {
        newErrors.credential = `${
          formData.authMethod === 'invite-token'
            ? 'Generate invite'
            : formData.authMethod === 'shared-secret'
              ? 'Shared secret'
              : 'Password'
        } is required`;
      }

      // For password and shared-secret, validate confirmation
      if (
        formData.authMethod !== 'invite-token' &&
        formData.credential !== formData.confirmCredential
      ) {
        newErrors.confirmCredential = 'Credentials do not match';
      }

      // Validate password minimum length
      if (
        formData.authMethod === 'password' &&
        formData.credential.length < 4
      ) {
        newErrors.credential = 'Password must be at least 4 characters';
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const generateInviteToken = () => {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let token = '';
    for (let i = 0; i < 8; i++) {
      token += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    setFormData((prev) => ({
      ...prev,
      credential: token,
      confirmCredential: '',
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setLoading(true);
    try {
      if (!store.currentPeerId) {
        throw new Error('Current peer ID not set');
      }

      // Create owner peer object
      const ownerPeer = {
        id: store.currentPeerId,
        displayName: store.currentPeerName,
        status: 'online' as const,
        capabilities: ['admin', 'edit'],
        lastSeenAt: new Date().toISOString(),
      };

      // Create room using RoomManager
      const room = roomManager.createRoom(
        formData.roomName,
        ownerPeer,
        formData.authMethod !== 'public', // isPrivate
        formData.authMethod !== 'public' ? formData.authMethod : undefined,
      );

      RoomLogger.info('Room created from UI', {
        roomId: room.id,
        authMethod: formData.authMethod,
      });

      // Set up authentication based on method
      if (
        formData.authMethod === 'password' ||
        formData.authMethod === 'shared-secret'
      ) {
        if (formData.authMethod === 'password') {
          roomManager.setRoomPassword(room.id, formData.credential);
        } else {
          roomManager.setRoomSharedSecret(room.id, formData.credential);
        }
      } else if (formData.authMethod === 'invite-token') {
        // Ensure invite token is set up for the room
        if (!formData.credential) {
          roomManager.addRoomInviteToken(room.id);
        }
      }

      // Set current room in store
      store.setCurrentRoom(room);

      // Add the owner as a known peer
      store.addKnownPeer(ownerPeer);

      // Show message based on auth method
      let message = `Room "${room.name}" created successfully!`;
      if (formData.authMethod === 'password') {
        message += ' Password-protected.';
      } else if (formData.authMethod === 'shared-secret') {
        message += ' Secret-protected.';
      } else if (formData.authMethod === 'invite-token') {
        message += ` Invite code: ${formData.credential}`;
      } else {
        message += ' Public access.';
      }

      store.addStatusMessage({
        type: 'success',
        message,
        duration: 5000,
      });

      // For invite token, show token before navigating
      if (formData.authMethod === 'invite-token') {
        // Keep user on this page briefly or navigate with state
      }

      navigate('/workspace');
    } catch (error) {
      RoomLogger.error('Failed to create room', {
        error: error instanceof Error ? error.message : String(error),
        authMethod: formData.authMethod,
      });
      store.addStatusMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to create room',
      });
    } finally {
      setLoading(false);
    }
  };

  const getAuthMethodDescription = (method: AuthMethod): string => {
    switch (method) {
      case 'public':
        return 'Anyone can discover and join this room';
      case 'password':
        return 'Joiners must provide the password';
      case 'shared-secret':
        return 'Joiners must provide the shared secret';
      case 'invite-token':
        return 'Only those with invite codes can join';
      default:
        return '';
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <Form title="Create a New Room" onSubmit={handleSubmit}>
        {/* Room Name */}
        <TextInput
          label="Room Name"
          name="roomName"
          placeholder="My Collaborative Workspace"
          value={formData.roomName}
          onChange={handleChange}
          error={errors.roomName}
          required
        />

        {/* Authentication Method Selection */}
        <div className="space-y-3">
          <label className="block text-sm font-medium text-slate-700">
            Access Control Method
          </label>
          <div className="space-y-2">
            {(['public', 'password', 'shared-secret', 'invite-token'] as AuthMethod[]).map(
              (method) => (
                <label key={method} className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="authMethod"
                    value={method}
                    checked={formData.authMethod === method}
                    onChange={handleChange}
                    className="mt-1"
                  />
                  <div className="flex-1">
                    <div className="font-medium text-slate-900 capitalize">
                      {method === 'invite-token' ? 'Invite Token' : method}
                    </div>
                    <div className="text-xs text-slate-600">
                      {getAuthMethodDescription(method)}
                    </div>
                  </div>
                </label>
              ),
            )}
          </div>
        </div>

        {/* Conditional Credential Input */}
        {formData.authMethod !== 'public' && (
          <div className="space-y-3 border-t pt-3">
            {formData.authMethod === 'invite-token' ? (
              <>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Invite Code
                  </label>
                  <div className="flex gap-2">
                    <div className="flex-1 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-mono">
                      {formData.credential || 'Click Generate'}
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={generateInviteToken}
                      disabled={loading}
                    >
                      Generate
                    </Button>
                  </div>
                  <p className="mt-1 text-xs text-slate-600">
                    Share this code with people you want to invite
                  </p>
                  {errors.credential && (
                    <p className="mt-1 text-xs text-red-600">{errors.credential}</p>
                  )}
                </div>
              </>
            ) : (
              <>
                <TextInput
                  label={
                    formData.authMethod === 'shared-secret'
                      ? 'Shared Secret'
                      : 'Password'
                  }
                  name="credential"
                  type="password"
                  placeholder={`Enter a secure ${
                    formData.authMethod === 'shared-secret'
                      ? 'secret'
                      : 'password'
                  }`}
                  value={formData.credential}
                  onChange={handleChange}
                  error={errors.credential}
                  required
                />

                <TextInput
                  label={`Confirm ${
                    formData.authMethod === 'shared-secret'
                      ? 'Secret'
                      : 'Password'
                  }`}
                  name="confirmCredential"
                  type="password"
                  placeholder="Re-enter to confirm"
                  value={formData.confirmCredential}
                  onChange={handleChange}
                  error={errors.confirmCredential}
                  required
                />
              </>
            )}

            <div className="rounded-lg bg-amber-50 p-3">
              <p className="text-xs font-semibold text-amber-900">
                🔐 Security Note:
              </p>
              <p className="mt-1 text-xs text-amber-800">
                Keep your {formData.authMethod === 'invite-token' ? 'codes' : 'credentials'}{' '}
                private. Only share with trusted participants.
              </p>
            </div>
          </div>
        )}

        {/* Help Text */}
        <div className="rounded-lg bg-blue-50 p-3">
          <p className="text-sm text-blue-900">
            💡 You can change the access control method later if needed.
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => navigate('/')}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button type="submit" loading={loading}>
            Create Room
          </Button>
        </div>
      </Form>
    </div>
  );
}
