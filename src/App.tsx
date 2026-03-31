import { StatusMessages } from './components/StatusMessages';
import { AppRoutes } from './routes/AppRoutes';
import { UIStoreProvider } from './store/UIStoreProvider';

function App() {
  return (
    <UIStoreProvider>
      <StatusMessages />
      <AppRoutes />
    </UIStoreProvider>
  );
}

export default App;
