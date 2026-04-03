import { ParticipantRole } from "../types";

interface RoomInfoProps {
  roomId: string;
  yourName: string;
  yourRole: ParticipantRole;
  hostDisplayName: string;
  bootstrapUrl: string;
  signalingStatus: string;
  webRtcStatus: string;
  roomStatus: string;
  inRoom: boolean;
  onLeaveRoom: () => void;
  onEndRoom: () => void;
}

export function RoomInfo({
  roomId,
  yourName,
  yourRole,
  hostDisplayName,
  bootstrapUrl,
  signalingStatus,
  webRtcStatus,
  roomStatus,
  inRoom,
  onLeaveRoom,
  onEndRoom,
}: RoomInfoProps): JSX.Element {
  return (
    <section className="card room-info">
      <h2>Room Info</h2>
      {!inRoom ? <p className="empty">Not in a room</p> : null}

      {inRoom ? (
        <>
          <dl>
            <div>
              <dt>Room ID</dt>
              <dd>{roomId}</dd>
            </div>
            <div>
              <dt>Your Name</dt>
              <dd>{yourName}</dd>
            </div>
            <div>
              <dt>Your Role</dt>
              <dd>{yourRole}</dd>
            </div>
            <div>
              <dt>Host</dt>
              <dd>{hostDisplayName}</dd>
            </div>
            <div>
              <dt>Bootstrap URL</dt>
              <dd>{bootstrapUrl}</dd>
            </div>
            <div>
              <dt>Room Status</dt>
              <dd>{roomStatus}</dd>
            </div>
            <div>
              <dt>Signaling</dt>
              <dd>{signalingStatus}</dd>
            </div>
            <div>
              <dt>WebRTC</dt>
              <dd>{webRtcStatus}</dd>
            </div>
          </dl>

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
        </>
      ) : null}
    </section>
  );
}