import "./UserKickedModal.css";

interface UserKickedModalProps {
  onClose: () => void;
}

export function UserKickedModal({ onClose }: UserKickedModalProps): JSX.Element {
  return (
    <div className="user-kicked-modal-overlay">
      <div className="user-kicked-modal">
        <div className="user-kicked-modal-content">
          <div className="user-kicked-modal-icon">
            <svg viewBox="0 0 24 24" width="48" height="48" aria-hidden="true" focusable="false">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
              <line x1="8" y1="8" x2="16" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <line x1="16" y1="8" x2="8" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <h2 className="user-kicked-modal-title">Kicked from Room</h2>
          <p className="user-kicked-modal-message">You have been removed from the room by the host.</p>
        </div>
        <div className="user-kicked-modal-footer">
          <button type="button" className="user-kicked-modal-button" onClick={onClose}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
