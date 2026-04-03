import type { FileTransferViewState } from "../types/fileTransfer";

interface FileSharePanelProps {
  viewState: FileTransferViewState;
  onShareFile: () => void;
  onAcceptOffer: (transferId: string) => void;
  onDeclineOffer: (transferId: string) => void;
  onRequestDownload: (fileId: string, senderPeerId: string) => void;
  onDownloadAcceptedOffer: (transferId: string) => void;
  shareDisabled?: boolean;
  currentPeerId?: string;
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

function formatHistoryTime(timestamp: number | null): string {
  if (!timestamp) {
    return "Never";
  }

  return new Date(timestamp).toLocaleString();
}

export function FileSharePanel({
  viewState,
  onShareFile,
  onAcceptOffer,
  onDeclineOffer,
  onRequestDownload,
  onDownloadAcceptedOffer,
  shareDisabled,
  currentPeerId,
}: FileSharePanelProps): JSX.Element {
  const incomingBySender = new Map<string, { senderPeerId: string; senderDisplayName: string; offers: typeof viewState.incomingOffers }>();
  for (const offer of viewState.incomingOffers) {
    const key = offer.manifest.senderPeerId;
    const existing = incomingBySender.get(key);
    if (!existing) {
      incomingBySender.set(key, {
        senderPeerId: key,
        senderDisplayName: offer.senderDisplayName,
        offers: [offer],
      });
      continue;
    }

    existing.offers.push(offer);
  }

  const incomingSenderGroups = Array.from(incomingBySender.values()).sort((left, right) =>
    left.senderDisplayName.localeCompare(right.senderDisplayName),
  );

  return (
    <section className="card file-share-panel">
      <div className="panel-header">
        <h2>File Sharing</h2>
        <button type="button" onClick={onShareFile} className="ghost share-button" disabled={shareDisabled}>
          Share File
        </button>
      </div>

      <details className="file-section-collapsible">
        <summary>Shared Files</summary>
        {viewState.sharedFilesBySender.length === 0 ? <p className="empty">No shared files yet</p> : null}

        <div className="shared-catalog">
          {viewState.sharedFilesBySender.map((senderGroup) => (
            <details key={senderGroup.senderPeerId} className="sender-group">
              <summary>
                <span>{senderGroup.senderDisplayName}</span>
                <span className="meta">{senderGroup.files.length} file(s)</span>
              </summary>

              <div className="sender-files">
                {senderGroup.files.filter((file) => file.hasAcceptedOffer).map((file) => (
                  <article key={`${file.senderPeerId}-${file.fileId}`} className="offer-card compact">
                    <header>
                      <strong>{file.fileName}</strong>
                      <span>{formatBytes(file.fileSize)}</span>
                    </header>
                    <p className="meta">
                      {file.pieceCount} pieces x {formatBytes(file.pieceSize)}
                    </p>
                    {file.downloadedCount > 0 ? (
                      <div className="download-history-row">
                        <span className="download-history-badge">Already downloaded x{file.downloadedCount}</span>
                        <span className="meta">Last: {formatHistoryTime(file.lastDownloadedAt)}</span>
                      </div>
                    ) : null}
                    <div className="offer-actions">
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => onRequestDownload(file.fileId, file.senderPeerId)}
                        disabled={file.senderPeerId === currentPeerId || shareDisabled}
                      >
                        Download
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </details>
          ))}
        </div>
      </details>

      <details className="file-section-collapsible">
        <summary>Incoming Offers By Sender</summary>
        {incomingSenderGroups.length === 0 ? <p className="empty">No incoming file offers</p> : null}

        <div className="shared-catalog">
          {incomingSenderGroups.map((group) => (
            <details key={group.senderPeerId} className="sender-group">
              <summary>
                <span>{group.senderDisplayName}</span>
                <span className="meta">{group.offers.length} offer(s)</span>
              </summary>

              <div className="sender-files">
                {group.offers.map((offer) => (
                  <article key={offer.transferId} className="offer-card compact">
                    <header>
                      <strong>{offer.manifest.fileName}</strong>
                      <span>{offer.status}</span>
                    </header>
                    <p className="meta">
                      {formatBytes(offer.manifest.fileSize)} • {offer.manifest.pieceCount} pieces
                    </p>
                    <div className="offer-actions">
                      <button type="button" onClick={() => onAcceptOffer(offer.transferId)} disabled={offer.status !== "offered"}>
                        Accept
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => onDeclineOffer(offer.transferId)}
                        disabled={offer.status !== "offered"}
                      >
                        Decline
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => onRequestDownload(offer.manifest.fileId, offer.manifest.senderPeerId)}
                        disabled={offer.manifest.senderPeerId === currentPeerId || shareDisabled || offer.status !== "accepted"}
                      >
                        Request Again
                      </button>
                      {offer.status === "accepted" ? (
                        <button
                          type="button"
                          onClick={() => onDownloadAcceptedOffer(offer.transferId)}
                          disabled={shareDisabled}
                        >
                          Download
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </details>
          ))}
        </div>
      </details>
    </section>
  );
}
