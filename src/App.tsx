import { StatusMessages } from './components/StatusMessages';
import { FileTransferBridge } from './modules/file-transfer/FileTransferBridge';
import { SharedFileDirectoryBridge } from './modules/file-transfer/SharedFileDirectoryBridge';
import { useRoomMembershipIntegration } from './modules/useRoomMembershipIntegration';
import { useRoomNetworkingIntegration } from './modules/useRoomNetworkingIntegration';
import { AppRoutes } from './routes/AppRoutes';
import { UIStoreProvider } from './store/UIStoreProvider';

function RuntimeBridges() {
  useRoomMembershipIntegration();
  useRoomNetworkingIntegration();

  return null;
}

function App() {
  return (
    <UIStoreProvider>
      <RuntimeBridges />
      <SharedFileDirectoryBridge />
      <FileTransferBridge />
      <StatusMessages />
      <AppRoutes />
    </UIStoreProvider>
  );
}

export default App;
