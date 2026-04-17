import { FormEvent, useEffect, useRef, useState } from "react";
import type { DiscoveredRoomSummary } from "../types";
import { DiscoverRoomsPanel } from "./DiscoverRoomsPanel";

type SetupStep = "create" | "join";
type JoinSetupTab = "manual" | "discovery";
type RelayDiscoveryPhase = "idle" | "scanning" | "found" | "not-found" | "error";

interface JoinFormProps {
  step: SetupStep;
  joinTab: JoinSetupTab;
  userIdDraft: string;
  currentUserId: string;
  discoveredRooms: DiscoveredRoomSummary[];
  relayConnected: boolean;
  relayDiscoveryPhase: RelayDiscoveryPhase;
  relayDiscoveryHost: string | null;
  roomActionDisabled: boolean;
  createRoomInProgress: boolean;
  createRoomProgress: number;
  defaultBootstrapUrl: string;
  onUserIdDraftChange: (next: string) => void;
  onSubmitUserId: () => void;
  onChooseCreate: () => void;
  onChooseJoin: () => void;
  onChooseManualJoinTab: () => void;
  onChooseDiscoveryJoinTab: () => void;
  onCreateRoom: (payload: { roomId: string; bootstrapUrl: string; roomPassword: string }) => void;
  onJoinRoom: (payload: { roomId: string; bootstrapUrl: string; roomPassword: string }) => void;
}

function generateRoomId(): string {
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `room-${randomPart}`;
}

const minimumRoomPasswordLength = 4;

function isIpv4Address(value: string): boolean {
  return /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(value.trim());
}

function extractHostIp(defaultBootstrapUrl: string): string {
  if (!defaultBootstrapUrl) {
    return "";
  }

  try {
    const hostname = new URL(defaultBootstrapUrl).hostname;
    return isIpv4Address(hostname) ? hostname : "";
  } catch {
    const hostname = defaultBootstrapUrl.replace(/^ws:\/\//, "").replace(/:\d+$/, "").trim();
    return isIpv4Address(hostname) ? hostname : "";
  }
}

function buildBootstrapUrl(hostIp: string): string {
  return `ws://${hostIp.trim()}:8787`;
}

export function JoinForm({
  step,
  joinTab,
  userIdDraft,
  currentUserId,
  discoveredRooms,
  relayConnected,
  relayDiscoveryPhase,
  relayDiscoveryHost,
  roomActionDisabled,
  createRoomInProgress,
  createRoomProgress,
  defaultBootstrapUrl,
  onUserIdDraftChange,
  onSubmitUserId,
  onChooseCreate,
  onChooseJoin,
  onChooseManualJoinTab,
  onChooseDiscoveryJoinTab,
  onCreateRoom,
  onJoinRoom,
}: JoinFormProps): JSX.Element {
  const defaultHostIp = extractHostIp(defaultBootstrapUrl);
  const hasSavedUserId = Boolean(currentUserId.trim());
  const [createRoomId, setCreateRoomId] = useState(generateRoomId());
  const [createHostIp, setCreateHostIp] = useState(defaultHostIp);
  const [createRoomPassword, setCreateRoomPassword] = useState("");
  const [joinRoomId, setJoinRoomId] = useState("");
  const [joinHostIp, setJoinHostIp] = useState(defaultHostIp);
  const [joinRoomPassword, setJoinRoomPassword] = useState("");
  const [isUsernameEditing, setIsUsernameEditing] = useState(() => !hasSavedUserId);
  const [showInitialUsernamePlaceholder, setShowInitialUsernamePlaceholder] = useState(() => !hasSavedUserId);
  const usernameInputRef = useRef<HTMLInputElement | null>(null);
  const createPasswordInputRef = useRef<HTMLInputElement | null>(null);
  const joinPasswordInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setCreateHostIp(defaultHostIp);
    setJoinHostIp(defaultHostIp);
  }, [defaultBootstrapUrl]);

  useEffect(() => {
    if (!hasSavedUserId) {
      setIsUsernameEditing(true);
      setShowInitialUsernamePlaceholder(true);
    }
  }, [hasSavedUserId]);

  const validateUsernameFirst = (): boolean => {
    // While editing, require the username input to be explicitly saved before room actions proceed.
    if (!isUsernameEditing && currentUserId.trim()) {
      if (usernameInputRef.current) {
        usernameInputRef.current.setCustomValidity("");
      }

      return true;
    }

    const usernameInput = usernameInputRef.current;
    if (!usernameInput) {
      setIsUsernameEditing(true);
      setShowInitialUsernamePlaceholder(true);
      return false;
    }

    if (!userIdDraft.trim()) {
      usernameInput.setCustomValidity("Please fill out this field.");
      usernameInput.focus();
      usernameInput.reportValidity();
      return false;
    }

    // Do not leave a persistent custom validity error here, otherwise Save can be blocked.
    usernameInput.setCustomValidity("Please save your username first.");
    usernameInput.focus();
    usernameInput.reportValidity();
    usernameInput.setCustomValidity("");
    return false;
  };

  const submitCreate = (event: FormEvent): void => {
    event.preventDefault();
    if (!validateUsernameFirst()) {
      return;
    }

    const createPasswordInput = createPasswordInputRef.current;
    if (!createPasswordInput) {
      return;
    }

    if (!createRoomPassword.trim()) {
      createPasswordInput.setCustomValidity("Please fill out this field.");
      createPasswordInput.focus();
      createPasswordInput.reportValidity();
      return;
    }

    createPasswordInput.setCustomValidity("");

    onCreateRoom({
      roomId: createRoomId.trim(),
      bootstrapUrl: buildBootstrapUrl(createHostIp),
      roomPassword: createRoomPassword.trim(),
    });
  };

  const submitJoin = (event: FormEvent): void => {
    event.preventDefault();
    if (!validateUsernameFirst()) {
      return;
    }

    const joinPasswordInput = joinPasswordInputRef.current;
    if (!joinPasswordInput) {
      return;
    }

    if (!joinRoomPassword.trim()) {
      joinPasswordInput.setCustomValidity("Please fill out this field.");
      joinPasswordInput.focus();
      joinPasswordInput.reportValidity();
      return;
    }

    joinPasswordInput.setCustomValidity("");

    onJoinRoom({
      roomId: joinRoomId.trim(),
      bootstrapUrl: buildBootstrapUrl(joinHostIp),
      roomPassword: joinRoomPassword.trim(),
    });
  };

  const useDiscoveredRoom = (room: DiscoveredRoomSummary): void => {
    if (!validateUsernameFirst()) {
      return;
    }

    setJoinRoomId(room.roomId);
    setJoinHostIp(room.hostIp);
  };

  const isCreateStep = step === "create";
  const isJoinStep = step === "join";
  const isManualJoinTab = joinTab === "manual";
  const isDiscoveryJoinTab = joinTab === "discovery";

  const submitUserId = (event: FormEvent): void => {
    event.preventDefault();
    if (!userIdDraft.trim()) {
      onSubmitUserId();
      return;
    }

    onSubmitUserId();
    setShowInitialUsernamePlaceholder(false);
    setIsUsernameEditing(false);
    usernameInputRef.current?.setCustomValidity("");
  };

  const beginUsernameEdit = (): void => {
    onUserIdDraftChange(currentUserId);
    setIsUsernameEditing(true);
    if (hasSavedUserId) {
      setShowInitialUsernamePlaceholder(false);
    }
  };

  const usernameDisplay = hasSavedUserId ? currentUserId : "####";
  const usernamePlaceholder = showInitialUsernamePlaceholder ? "Please input a username." : "";

  const renderUsernameControl = (): JSX.Element => {
    if (isUsernameEditing) {
      return (
        <form className="setup-username-form" onSubmit={submitUserId}>
          <label className="setup-username-label">
            <span className="setup-username-label-text">Username:</span>
            <input
              ref={usernameInputRef}
              value={userIdDraft}
              onChange={(event) => {
                usernameInputRef.current?.setCustomValidity("");
                onUserIdDraftChange(event.target.value);
              }}
              placeholder={usernamePlaceholder}
              required
              disabled={roomActionDisabled}
              autoComplete="off"
              autoFocus
            />
          </label>
          <button type="submit" className="setup-username-save" disabled={roomActionDisabled}>
            Save
          </button>
        </form>
      );
    }

    return (
      <button
        type="button"
        className="setup-username-display"
        onClick={beginUsernameEdit}
        disabled={roomActionDisabled}
      >
        <span className="setup-username-caption">Username:</span>
        <span className="setup-username-value">{usernameDisplay}</span>
      </button>
    );
  };

  const renderSetupTabs = (): JSX.Element => (
    <div className="setup-tabs" role="tablist" aria-label="Room setup mode">
      <button
        type="button"
        role="tab"
        aria-selected={isCreateStep}
        className={`setup-tab${isCreateStep ? " active" : ""}`}
        disabled={roomActionDisabled}
        onClick={onChooseCreate}
      >
        Create Room
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={isJoinStep}
        className={`setup-tab${isJoinStep ? " active" : ""}`}
        disabled={roomActionDisabled}
        onClick={onChooseJoin}
      >
        Join Room
      </button>
    </div>
  );

  return (
    <section className="card form room-launcher setup-screen">
      {renderSetupTabs()}
      <section className="setup-room-body">
        <div className="setup-room-pane">
          {isCreateStep ? (
            <>
              <div className="setup-copy">
                <p>Before creating a room, provide:</p>
                <ul>
                  <li>Host IPv4 Address: host device LAN IP only (for example, 192.168.1.42).</li>
                  <li>Room ID: a unique room name to share with participants.</li>
                  <li>Room Password: at least 4 characters.</li>
                </ul>
              </div>
              <form className="subform" onSubmit={submitCreate} noValidate>
                <label>
                  Host IPv4 Address
                  <input
                    value={createHostIp}
                    onChange={(event) => setCreateHostIp(event.target.value)}
                    placeholder="192.168.1.42"
                    required
                    disabled={roomActionDisabled}
                  />
                </label>

                <label>
                  Room ID
                  <div className="inline-row">
                    <input
                      value={createRoomId}
                      onChange={(event) => setCreateRoomId(event.target.value)}
                      placeholder="room-1"
                      required
                      disabled={roomActionDisabled}
                    />
                    <button
                      type="button"
                      className="ghost"
                      disabled={roomActionDisabled}
                      onClick={() => setCreateRoomId(generateRoomId())}
                    >
                      Randomize
                    </button>
                  </div>
                </label>

                <label>
                  Room Password
                  <input
                    ref={createPasswordInputRef}
                    type="password"
                    value={createRoomPassword}
                    onChange={(event) => {
                      createPasswordInputRef.current?.setCustomValidity("");
                      setCreateRoomPassword(event.target.value);
                    }}
                    placeholder="Set a room password"
                    minLength={minimumRoomPasswordLength}
                    required
                    disabled={roomActionDisabled}
                  />
                </label>

                <button
                  type="submit"
                  className={`create-room-button${createRoomInProgress ? " loading" : ""}`}
                  disabled={roomActionDisabled || createRoomInProgress}
                  aria-busy={createRoomInProgress}
                >
                  <span className="create-room-button-label">{createRoomInProgress ? "Creating Room..." : "Create Room"}</span>
                  {createRoomInProgress ? (
                    <span
                      className="create-room-progress"
                      role="progressbar"
                      aria-label="Room creation progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(createRoomProgress)}
                    >
                      <span className="create-room-progress-bar" style={{ width: `${Math.max(0, Math.min(100, createRoomProgress))}%` }} />
                    </span>
                  ) : null}
                </button>
              </form>
            </>
          ) : (
            <section className="join-room-layout">
              <div className="join-mode-tabs" role="tablist" aria-label="Join mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={isManualJoinTab}
                  className={`join-mode-tab${isManualJoinTab ? " active" : ""}`}
                  onClick={onChooseManualJoinTab}
                  disabled={roomActionDisabled}
                >
                  Manual
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isDiscoveryJoinTab}
                  className={`join-mode-tab${isDiscoveryJoinTab ? " active" : ""}`}
                  onClick={onChooseDiscoveryJoinTab}
                  disabled={roomActionDisabled}
                >
                  Discovery
                </button>
              </div>

              {isDiscoveryJoinTab ? (
                <div className="join-mode-panel" role="tabpanel">
                  <DiscoverRoomsPanel
                    rooms={discoveredRooms}
                    relayConnected={relayConnected}
                    relayDiscoveryPhase={relayDiscoveryPhase}
                    relayDiscoveryHost={relayDiscoveryHost}
                    disabled={roomActionDisabled || isUsernameEditing || !currentUserId.trim()}
                    onUseRoom={useDiscoveredRoom}
                  />
                </div>
              ) : null}

              {isManualJoinTab ? (
                <form className="subform join-manual-form join-mode-panel" onSubmit={submitJoin} noValidate role="tabpanel">
                  <h3>Manual Join</h3>

                  <label>
                    Bootstrap Signal IPv4 Address
                    <input
                      value={joinHostIp}
                      onChange={(event) => setJoinHostIp(event.target.value)}
                      placeholder="192.168.1.42"
                      inputMode="decimal"
                      pattern="^(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}$"
                      required
                      disabled={roomActionDisabled}
                    />
                  </label>

                  <label>
                    Room ID
                    <input
                      value={joinRoomId}
                      onChange={(event) => setJoinRoomId(event.target.value)}
                      placeholder="room-1"
                      required
                      disabled={roomActionDisabled}
                    />
                  </label>

                  <label>
                    Room Password
                    <input
                      ref={joinPasswordInputRef}
                      type="password"
                      value={joinRoomPassword}
                      onChange={(event) => {
                        joinPasswordInputRef.current?.setCustomValidity("");
                        setJoinRoomPassword(event.target.value);
                      }}
                      placeholder="Enter room password"
                      minLength={minimumRoomPasswordLength}
                      required
                      disabled={roomActionDisabled}
                    />
                  </label>

                  <button type="submit" disabled={roomActionDisabled}>
                    Join Room
                  </button>
                </form>
              ) : null}
            </section>
          )}
        </div>
      </section>
      <section className="setup-username-block" aria-label="Username settings">
        {renderUsernameControl()}
      </section>
    </section>
  );
}