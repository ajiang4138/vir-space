import { ParticipantRole } from "../types";

interface RoomInfoProps {
  roomId: string;
  yourRole: ParticipantRole;
  hostDisplayName: string;
  bootstrapUrl: string;
  inRoom: boolean;
  compact?: boolean;
  showTitle?: boolean;
  showActions?: boolean;
  onLeaveRoom: () => void;
  onEndRoom: () => void;
}

export function RoomInfo({
  roomId,
  yourRole,
  hostDisplayName,
  bootstrapUrl,
  inRoom,
  compact = false,
  showTitle = true,
  showActions = true,
  onLeaveRoom,
  onEndRoom,
}: RoomInfoProps): JSX.Element {
  const roomInfoClassName = compact ? "room-info compact" : "card room-info";
  const hostIpv4 = (() => {
    try {
      return new URL(bootstrapUrl).hostname;
    } catch {
      return bootstrapUrl.replace(/^ws:\/\//, "").replace(/:\d+$/, "").trim();
    }
  })();

  return (
    <section className={roomInfoClassName}>
      {showTitle ? <h2>Room Info</h2> : null}
      {!inRoom ? <p className="empty">Not in a room</p> : null}

      {inRoom ? (
        <>
          <dl>
            <div>
              <dt>Host</dt>
              <dd>{hostDisplayName}</dd>
            </div>
            <div>
              <dt>Room ID</dt>
              <dd>{roomId}</dd>
            </div>
            <div>
              <dt>Host IPv4</dt>
              <dd>{hostIpv4 || "-"}</dd>
            </div>
          </dl>

          {showActions ? (
            <div className="room-actions">
              {yourRole === "host" ? (
                <button type="button" className="danger" onClick={onEndRoom}>
                  End Room
                </button>
              ) : (
                <button type="button" onClick={onLeaveRoom}>
                  Leave Room
                </button>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}