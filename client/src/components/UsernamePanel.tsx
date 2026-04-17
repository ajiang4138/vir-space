import { FormEvent } from "react";

interface UsernamePanelProps {
  usernameDraft: string;
  currentUsername: string;
  onUsernameDraftChange: (value: string) => void;
  onSaveUsername: () => void;
  onChangeUsername: () => void;
}

export function UsernamePanel({
  usernameDraft,
  currentUsername,
  onUsernameDraftChange,
  onSaveUsername,
  onChangeUsername,
}: UsernamePanelProps): JSX.Element {
  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    onSaveUsername();
  };

  if (currentUsername) {
    return (
      <div className="card username-panel">
        <div className="username-display">
          <span className="username-label">Username:</span>
          <span className="username-value">{currentUsername}</span>
          <button
            type="button"
            className="ghost"
            onClick={onChangeUsername}
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card username-panel">
      <form className="username-form" onSubmit={handleSubmit}>
        <label className="username-input-row">
          <span className="username-label">Username:</span>
          <input
            type="text"
            value={usernameDraft}
            onChange={(event) => onUsernameDraftChange(event.target.value)}
            placeholder="Enter username"
            required
            autoFocus
          />
          <button type="submit" disabled={!usernameDraft.trim()}>
            Save
          </button>
        </label>
      </form>
    </div>
  );
}
