import type { FileTransferViewState } from "../types/fileTransfer";

interface FileSharePanelProps {
  viewState: FileTransferViewState;
  onShareFile: () => void;
  onRequestDownload: (torrentId: string, senderPeerId: string) => void;
  onRejectAnnouncement: (torrentId: string, senderPeerId: string) => void;
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

export function FileSharePanel({
  viewState,
  onShareFile,
  onRequestDownload,
  onRejectAnnouncement,
  shareDisabled,
  currentPeerId,
}: FileSharePanelProps): JSX.Element {
  const offersBySender = new Map<string, typeof viewState.incomingAnnouncements>();
  for (const announcement of viewState.incomingAnnouncements) {
    const existing = offersBySender.get(announcement.senderPeerId);
    if (!existing) {
      offersBySender.set(announcement.senderPeerId, [announcement]);
      continue;
    }
    existing.push(announcement);
  }

  const rejectedBySender = new Map<string, typeof viewState.rejectedAnnouncements>();
  for (const announcement of viewState.rejectedAnnouncements) {
    const existing = rejectedBySender.get(announcement.senderPeerId);
    if (!existing) {
      rejectedBySender.set(announcement.senderPeerId, [announcement]);
      continue;
    }
    existing.push(announcement);
  }

  const offerGroups = Array.from(offersBySender.entries()).map(([senderPeerId, announcements]) => ({
    senderPeerId,
    senderDisplayName: announcements[0]?.senderDisplayName ?? senderPeerId,
    announcements,
  }));

  const rejectedGroups = Array.from(rejectedBySender.entries()).map(([senderPeerId, announcements]) => ({
    senderPeerId,
    senderDisplayName: announcements[0]?.senderDisplayName ?? senderPeerId,
    announcements,
  }));

  const swarmById = new Map(viewState.activeSwarms.map((swarm) => [swarm.torrentId, swarm]));

  const renderSummary = (torrentId: string): JSX.Element | null => {
    const swarm = swarmById.get(torrentId);
    if (!swarm) {
      return null;
    }

    const percent = Math.round(swarm.progress * 100);
    return (
      <div className="transfer-meter">
        <div className="transfer-meter-track">
          <div className="transfer-meter-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="transfer-meter-meta">
          <span>{percent}%</span>
          <span>{formatBytes(swarm.downloadedBytes)} / {formatBytes(swarm.manifest.fileSize)}</span>
        </div>
        <div className="transfer-meter-meta">
          <span>{swarm.localRole}</span>
          <span>{swarm.peerCount} peer(s)</span>
          <span>{swarm.localAvailabilityPercent}% local</span>
        </div>
        <div className="transfer-meter-meta">
          <span>status: {swarm.status}</span>
          {swarm.integrityStatus === "verified" && swarm.status === "completed" ? <span>download verified</span> : null}
        </div>
        {swarm.message ? <p className="meta">{swarm.message}</p> : null}
      </div>
    );
  };

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
          <details className="file-section-collapsible" open>
            <summary>Offers</summary>
            {offerGroups.length === 0 ? <p className="empty">No pending offers.</p> : null}
            <div className="shared-catalog">
              {offerGroups.map((group) => (
                <details key={`offer-${group.senderPeerId}`} className="sender-group" open>
                  <summary>
                    <span>{group.senderDisplayName}</span>
                    <span className="meta">{group.announcements.length} offer(s)</span>
                  </summary>
                  <div className="sender-files">
                    {group.announcements.map((announcement) => (
                      <article key={`offer-${announcement.torrentId}`} className="offer-card compact">
                        <header>
                          <div>
                            <strong>{announcement.manifest.fileName}</strong>
                            <p className="meta">{formatBytes(announcement.manifest.fileSize)} • {announcement.manifest.pieceCount} pieces</p>
                          </div>
                          <span className="status-badge offered">offer</span>
                        </header>
                        <p className="meta">torrent: {announcement.torrentId.slice(0, 12)}...</p>
                        <div className="offer-actions">
                          <button type="button" onClick={() => onRequestDownload(announcement.torrentId, announcement.senderPeerId)} disabled={shareDisabled}>
                            Download
                          </button>
                          <button type="button" className="ghost" onClick={() => onRejectAnnouncement(announcement.torrentId, announcement.senderPeerId)}>
                            Reject offer
                          </button>
                        </div>
                        {renderSummary(announcement.torrentId)}
                      </article>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </details>

          <details className="file-section-collapsible" open>
            <summary>Accepted</summary>
            {viewState.acceptedSwarmsBySender.length === 0 ? <p className="empty">No accepted files yet.</p> : null}
            <div className="shared-catalog">
              {viewState.acceptedSwarmsBySender.map((senderGroup) => (
                <details key={`accepted-${senderGroup.senderPeerId}`} className="sender-group" open>
                  <summary>
                    <span>{senderGroup.senderDisplayName}</span>
                    <span className="meta">{senderGroup.swarms.length} accepted</span>
                  </summary>
                  <div className="sender-files">
                    {senderGroup.swarms.map((swarm) => (
                      <article key={`accepted-${swarm.torrentId}`} className="offer-card compact">
                        <header>
                          <div>
                            <strong>{swarm.manifest.fileName}</strong>
                            <p className="meta">{formatBytes(swarm.manifest.fileSize)} • {swarm.manifest.pieceCount} pieces</p>
                          </div>
                          <span className={`status-badge ${swarm.status}`}>{swarm.status}</span>
                        </header>
                        <p className="meta">torrent: {swarm.torrentId.slice(0, 12)}...</p>
                        <div className="offer-actions">
                          <button
                            type="button"
                            onClick={() => onRequestDownload(swarm.torrentId, senderGroup.senderPeerId)}
                            disabled={swarm.manifest.initialSeederPeerId === currentPeerId || shareDisabled}
                          >
                            Re-download
                          </button>
                          <button type="button" className="ghost" onClick={() => onRejectAnnouncement(swarm.torrentId, senderGroup.senderPeerId)}>
                            Exit swarm
                          </button>
                        </div>
                        {renderSummary(swarm.torrentId)}
                      </article>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </details>

          <details className="file-section-collapsible" open>
            <summary>Rejected</summary>
            {rejectedGroups.length === 0 ? <p className="empty">No rejected offers.</p> : null}
            <div className="shared-catalog">
              {rejectedGroups.map((group) => (
                <details key={`rejected-${group.senderPeerId}`} className="sender-group" open>
                  <summary>
                    <span>{group.senderDisplayName}</span>
                    <span className="meta">{group.announcements.length} rejected</span>
                  </summary>
                  <div className="sender-files">
                    {group.announcements.map((announcement) => (
                      <article key={`rejected-${announcement.torrentId}`} className="offer-card compact">
                        <header>
                          <div>
                            <strong>{announcement.manifest.fileName}</strong>
                            <p className="meta">{formatBytes(announcement.manifest.fileSize)} • {announcement.manifest.pieceCount} pieces</p>
                          </div>
                          <span className="status-badge rejected">rejected</span>
                        </header>
                        <p className="meta">torrent: {announcement.torrentId.slice(0, 12)}...</p>
                        <div className="offer-actions">
                          <button type="button" onClick={() => onRequestDownload(announcement.torrentId, announcement.senderPeerId)} disabled={shareDisabled}>
                            Download
                          </button>
                        </div>
                        {renderSummary(announcement.torrentId)}
                      </article>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </details>
        </div>
      </section>
    </section>
  );
}
