import "./RoomEndedModal.css";

interface RoomEndedModalProps {
  reason: "host-ended" | "host-disconnected";
  onClose: () => void;
}

export function RoomEndedModal({ reason, onClose }: RoomEndedModalProps): JSX.Element {
  const message =
    reason === "host-ended"
      ? "The host has ended the room."
      : "The host has disconnected from the room.";

  return (
    <div className="room-ended-modal-overlay">
      <div className="room-ended-modal">
        <div className="room-ended-modal-content">
          <div className="room-ended-modal-icon">
            <svg viewBox="0 0 24 24" width="48" height="48" aria-hidden="true" focusable="false">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
              <line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <h2 className="room-ended-modal-title">Room Ended</h2>
          <p className="room-ended-modal-message">{message}</p>
        </div>
        <div className="room-ended-modal-footer">
          <button type="button" className="room-ended-modal-button" onClick={onClose}>
            Return to Home
          </button>
        </div>
      </div>
    </div>
  );
}
