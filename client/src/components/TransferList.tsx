import type { FileTransferSummary } from "../types/fileTransfer";

interface TransferListProps {
  transfers: FileTransferSummary[];
  onCancelTransfer: (transferId: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function TransferList({ transfers, onCancelTransfer }: TransferListProps): JSX.Element {
  return (
    <section className="card transfer-list">
      <div className="panel-header">
        <h2>Transfers</h2>
      </div>

      {transfers.length === 0 ? <p className="empty">No active transfers</p> : null}

      <div className="transfer-grid">
        {transfers.map((transfer) => {
          const percent = Math.round(transfer.progress * 100);
          return (
            <article key={transfer.transferId} className={`transfer-card ${transfer.status}`}>
              <header>
                <div>
                  <strong>{transfer.manifest.fileName}</strong>
                  <p className="meta">{transfer.direction}</p>
                </div>
                <span className={`status-badge ${transfer.status}`}>{transfer.status}</span>
              </header>

              <div className="transfer-meter">
                <div className="transfer-meter-track">
                  <div className="transfer-meter-fill" style={{ width: `${percent}%` }} />
                </div>
                <div className="transfer-meter-meta">
                  <span>{percent}%</span>
                  <span>
                    {formatBytes(transfer.transferredBytes)} / {formatBytes(transfer.manifest.fileSize)}
                  </span>
                </div>
              </div>

              <dl className="transfer-stats">
                <div>
                  <dt>Speed</dt>
                  <dd>{formatSpeed(transfer.speedBytesPerSecond)}</dd>
                </div>
                <div>
                  <dt>Pieces</dt>
                  <dd>
                    {transfer.completedPieces}/{transfer.manifest.pieceCount}
                  </dd>
                </div>
                <div>
                  <dt>Integrity</dt>
                  <dd>{transfer.integrityStatus}</dd>
                </div>
                <div>
                  <dt>State</dt>
                  <dd>{transfer.message ?? transfer.status}</dd>
                </div>
              </dl>

              <div className="transfer-actions">
                <button type="button" className="ghost" onClick={() => onCancelTransfer(transfer.transferId)} disabled={transfer.status === "completed"}>
                  Cancel
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
