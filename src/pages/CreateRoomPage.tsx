import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Form, TextInput } from '../components/ui';
import { getRoomManager } from '../modules/room-peer/RoomManager';
import { RoomLogger } from '../modules/room-peer/RoomPeerManager';
import { useUIStore } from '../store/useUIStore';

export function CreateRoomPage() {
  const navigate = useNavigate();
  const store = useUIStore();
  const roomManager = getRoomManager();

  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({ roomName: '', accessPassword: '' });
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
    if (!formData.roomName.trim()) {
      newErrors.roomName = 'Room name is required';
    }
    if (formData.roomName.length > 100) {
      newErrors.roomName = 'Room name must be 100 characters or less';
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
        !!formData.accessPassword // isPrivate
      );

      RoomLogger.info('Room created from UI', { roomId: room.id });

      // Set current room in store
      store.setCurrentRoom(room);

      // Add the owner as a known peer
      store.addKnownPeer(ownerPeer);

      store.addStatusMessage({
        type: 'success',
        message: `Room "${room.name}" created successfully! Room ID: ${room.id.slice(0, 8)}...`,
        duration: 4000,
      });

      navigate('/workspace');
    } catch (error) {
      RoomLogger.error('Failed to create room', {
        error: error instanceof Error ? error.message : String(error),
      });
      store.addStatusMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to create room',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <Form title="Create a New Room" onSubmit={handleSubmit}>
        <TextInput
          label="Room Name"
          name="roomName"
          placeholder="My Collaborative Workspace"
          value={formData.roomName}
          onChange={handleChange}
          error={errors.roomName}
          required
        />

        <TextInput
          label="Access Password (Optional)"
          name="accessPassword"
          type="password"
          placeholder="Leave blank for public access"
          value={formData.accessPassword}
          onChange={handleChange}
        />

        <p className="text-sm text-slate-600">
          {formData.accessPassword
            ? 'This room will be private. Only users with the password can join.'
            : 'This room will be public. Anyone can discover and join.'}
        </p>

        <div className="flex gap-3 pt-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => navigate('/')}
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
