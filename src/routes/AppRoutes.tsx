import { useState } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { Button, Form, TextInput } from '../components/ui';
import { AppLayout } from '../layout/AppLayout';
import { CreateRoomPage } from '../pages/CreateRoomPage';
import { JoinRoomPage } from '../pages/JoinRoomPage';
import { LandingPage } from '../pages/LandingPage';
import { SharedFilePanelPage } from '../pages/SharedFilePanelPage';
import { WorkspaceViewPage } from '../pages/WorkspaceViewPage';
import { useUIStore } from '../store/useUIStore';

function SessionGate() {
  const { currentPeerId, currentPeerName, setCurrentPeer } = useUIStore();
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');

  const isSessionReady = Boolean(currentPeerId && currentPeerName.trim());

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();

    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setError('Username is required');
      return;
    }

    setCurrentPeer(crypto.randomUUID(), trimmedName);
    setDisplayName('');
    setError('');
  };

  if (isSessionReady) {
    return <Outlet />;
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl items-center px-6 py-10">
      <div className="w-full rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">
            Session setup
          </p>
          <h1 className="mt-2 text-3xl font-bold text-slate-900">
            Choose a display name
          </h1>
          <p className="mt-2 text-slate-600">
            This name is used for this session only and is required before you can continue.
          </p>
        </div>

        <Form title="Start Session" onSubmit={handleSubmit}>
          <TextInput
            label="Display Name"
            name="displayName"
            placeholder="e.g., Maya"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            error={error}
            required
          />

          <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
            You can change this later by clearing the session state and starting over.
          </div>

          <div className="flex justify-end pt-2">
            <Button type="submit">Continue</Button>
          </div>
        </Form>
      </div>
    </div>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<SessionGate />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<LandingPage />} />
          <Route path="/create-room" element={<CreateRoomPage />} />
          <Route path="/join-room" element={<JoinRoomPage />} />
          <Route path="/workspace" element={<WorkspaceViewPage />} />
          <Route path="/shared-files" element={<SharedFilePanelPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
