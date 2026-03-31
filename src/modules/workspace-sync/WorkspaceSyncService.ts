import type { WorkspaceState } from '../../models/types';

export interface WorkspaceSyncService {
  getState(roomId: string): Promise<WorkspaceState | null>;
  updateState(state: WorkspaceState): Promise<void>;
  subscribe(roomId: string, onState: (state: WorkspaceState) => void): () => void;
}

export class PlaceholderWorkspaceSyncService implements WorkspaceSyncService {
  async getState(_roomId: string): Promise<WorkspaceState | null> {
    void _roomId;
    return null;
  }

  async updateState(_state: WorkspaceState): Promise<void> {
    void _state;
    return;
  }

  subscribe(_roomId: string, _onState: (state: WorkspaceState) => void): () => void {
    void _roomId;
    void _onState;
    return () => undefined;
  }
}
