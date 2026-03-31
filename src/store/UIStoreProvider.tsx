import { ReactNode } from 'react';
import { UIStoreContext, useUIStoreImpl } from './useUIStore';

export interface UIStoreProviderProps {
  children: ReactNode;
}

export function UIStoreProvider({ children }: UIStoreProviderProps) {
  const store = useUIStoreImpl();
  return (
    <UIStoreContext.Provider value={store}>{children}</UIStoreContext.Provider>
  );
}
