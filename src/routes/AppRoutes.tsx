import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '../layout/AppLayout';
import { CreateRoomPage } from '../pages/CreateRoomPage';
import { DiscoverRoomPage } from '../pages/DiscoverRoomPage';
import { JoinRoomPage } from '../pages/JoinRoomPage';
import { LandingPage } from '../pages/LandingPage';
import { PeerPresencePanelPage } from '../pages/PeerPresencePanelPage';
import { SharedFilePanelPage } from '../pages/SharedFilePanelPage';
import { WorkspaceViewPage } from '../pages/WorkspaceViewPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<LandingPage />} />
        <Route path="/create-room" element={<CreateRoomPage />} />
        <Route path="/discover-room" element={<DiscoverRoomPage />} />
        <Route path="/join-room" element={<JoinRoomPage />} />
        <Route path="/workspace" element={<WorkspaceViewPage />} />
        <Route path="/shared-files" element={<SharedFilePanelPage />} />
        <Route path="/peer-presence" element={<PeerPresencePanelPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
