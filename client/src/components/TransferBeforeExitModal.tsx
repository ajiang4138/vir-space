import "./TransferBeforeExitModal.css";

interface TransferBeforeExitModalProps {
  canTransfer: boolean;
  onTransfer: () => void;
  onEndRoom: () => void;
  onCancel: () => void;
}

export function TransferBeforeExitModal({
  canTransfer,
  onTransfer,
  onEndRoom,
  onCancel,
}: TransferBeforeExitModalProps): JSX.Element {
  return (
    <div className="transfer-before-exit-modal-overlay" role="presentation" onClick={onCancel}>
      <div
        className="transfer-before-exit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="transfer-before-exit-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="transfer-before-exit-modal-content">
          <h2 id="transfer-before-exit-title" className="transfer-before-exit-modal-title">
            Leave as Host?
          </h2>
          <p className="transfer-before-exit-modal-message">
            Do you want to transfer ownership before ending the room?
          </p>
          {!canTransfer ? (
            <p className="transfer-before-exit-modal-note">
              No eligible participant is available for transfer right now.
            </p>
          ) : null}
        </div>
        <div className="transfer-before-exit-modal-footer">
          <button type="button" className="transfer-before-exit-modal-button ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="transfer-before-exit-modal-button"
            onClick={onTransfer}
            disabled={!canTransfer}
          >
            Transfer Ownership
          </button>
          <button type="button" className="transfer-before-exit-modal-button danger" onClick={onEndRoom}>
            End Room
          </button>
        </div>
      </div>
    </div>
  );
}
