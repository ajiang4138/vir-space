import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Form, TextInput } from '../components/ui';
import { getRoomManager } from '../modules/room-peer/RoomManager';
import { RoomLogger } from '../modules/room-peer/RoomPeerManager';
import { useUIStore } from '../store/useUIStore';

export function JoinRoomPage() {
  const navigate = useNavigate();
  const store = useUIStore();
  const roomManager = getRoomManager();

  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({ roomId: '', authentication: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});

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

  const handleSubmit = async (e: React.FormEvent) => {
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

      // Try to join the room
      const room = await roomManager.joinRoom(formData.roomId, peer);

      RoomLogger.info('Room joined from UI', {
        roomId: room.id,
        peerId: peer.id,
      });

      // Set current room in store
      store.setCurrentRoom(room);

      // Add the joining peer and all room peers to known peers
      store.addKnownPeer(peer);
      room.peers.forEach((p) => {
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
    } catch (error) {
      RoomLogger.error('Failed to join room', {
        error: error instanceof Error ? error.message : String(error),
        roomId: formData.roomId,
      });
      store.addStatusMessage({
        type: 'error',
        message: 'Failed to join room. Check the ID and try again.',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <Form title="Join an Existing Room" onSubmit={handleSubmit}>
        <TextInput
          label="Room ID or Invite Code"
          name="roomId"
          placeholder="e.g., room-123abc or INVITE-CODE"
          value={formData.roomId}
          onChange={handleChange}
          error={errors.roomId}
          required
        />

        <TextInput
          label="Authentication (if required)"
          name="authentication"
          type="password"
          placeholder="Leave blank if public room"
          value={formData.authentication}
          onChange={handleChange}
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
    </div>
  );
}
