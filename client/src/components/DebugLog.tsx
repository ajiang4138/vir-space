interface DebugLogProps {
  events: string[];
  isWindowOpen?: boolean;
  onToggleWindow?: () => void;
}

export function DebugLog({ isWindowOpen, onToggleWindow }: DebugLogProps): JSX.Element | null {
  if (!onToggleWindow) return null;

  return (
    <section className="menu-section debug-log-section">
      <button 
        type="button" 
        onClick={onToggleWindow}
        style={{ width: "100%" }}
      >
        {isWindowOpen ? "Hide Debug Panel" : "Show Debug Panel"}
      </button>
    </section>
  );
}
