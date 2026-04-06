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

  const transferById = new Map(viewState.activeTransfers.map((transfer) => [transfer.transferId, transfer]));

  return (
    <section className="file-sharing-workspace">
      <section className="card file-share-panel file-share-editor-like">
        <div className="file-share-toolbar">
          <h2>File Sharing</h2>
          <div className="file-share-toolbar-actions">
            <button type="button" onClick={onShareFile} className="ghost share-button" disabled={shareDisabled}>
              Share File
            </button>
          </div>
        </div>

        <div className="file-share-body-shell">
          {incomingSenderGroups.length === 0 ? <p className="empty">No incoming file offers yet.</p> : null}

          <div className="shared-catalog">
            {incomingSenderGroups.map((group) => (
              <details key={group.senderPeerId} className="sender-group" open>
                <summary>
                  <span>{group.senderDisplayName}</span>
                  <span className="meta">{group.offers.length} offer(s)</span>
                </summary>

                <div className="sender-files">
                  {group.offers.map((offer) => {
                    const transfer = transferById.get(offer.transferId);
                    const percent = transfer ? Math.round(transfer.progress * 100) : 0;
                    const isRejected = offer.status === "declined";
                    const isOffered = offer.status === "offered";
                    const isAccepted = offer.status === "accepted";
                    const showProgress = isAccepted && transfer;

                    return (
                      <article key={offer.transferId} className="offer-card compact">
                        <header>
                          <div>
                            <strong>{offer.manifest.fileName}</strong>
                            <p className="meta">
                              {formatBytes(offer.manifest.fileSize)} • {offer.manifest.pieceCount} pieces
                            </p>
                          </div>
                          {isRejected ? <span className="offer-status-rejected">rejected</span> : <span className="status-badge offered">offer</span>}
                        </header>

                        <div className="offer-actions">
                          <button type="button" onClick={() => onAcceptOffer(offer.transferId)} disabled={!isOffered}>
                            Accept
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => onDeclineOffer(offer.transferId)}
                            disabled={!isOffered}
                          >
                            Decline
                          </button>
                          {isAccepted ? (
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => onDownloadAcceptedOffer(offer.transferId)}
                              disabled={shareDisabled || transfer?.status === "transferring"}
                            >
                              Download
                            </button>
                          ) : null}
                        </div>

                        {showProgress ? (
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
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </details>
            ))}
          </div>

          {viewState.sharedFilesBySender.length > 0 ? (
            <details className="file-section-collapsible" open>
              <summary>Previously Shared Files</summary>
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
                          <p className="meta">infoHash: {file.infoHash.slice(0, 12)}...</p>
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
          ) : null}
        </div>
      </section>
    </section>
  );
}
