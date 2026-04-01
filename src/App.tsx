import { StatusMessages } from './components/StatusMessages';
import { FileTransferBridge } from './modules/file-transfer/FileTransferBridge';
import { SharedFileDirectoryBridge } from './modules/file-transfer/SharedFileDirectoryBridge';
import { AppRoutes } from './routes/AppRoutes';
import { UIStoreProvider } from './store/UIStoreProvider';

function App() {
  return (
    <UIStoreProvider>
      <SharedFileDirectoryBridge />
      <FileTransferBridge />
      <StatusMessages />
      <AppRoutes />
    </UIStoreProvider>
  );
}

export default App;
