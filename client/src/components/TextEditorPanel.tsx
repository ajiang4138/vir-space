import React, { useEffect, useMemo, useRef, useState } from "react";

interface TextEditorPanelProps {
  editorText: string;
  onEditorTextChange: (nextText: string) => void;
  onCursorChange: (offset: number | null) => void;
  remoteCursors: Array<{
    peerId: string;
    displayName: string;
    cursorOffset: number;
    updatedAt: number;
  }>;
}

interface SelectionSnapshot {
  hasFocus: boolean;
  anchorOffset: number;
  focusOffset: number;
}

export function TextEditorPanel({
  editorText,
  onEditorTextChange,
  onCursorChange,
  remoteCursors,
}: TextEditorPanelProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  const [formatState, setFormatState] = useState({ bold: false, italic: false, underline: false });
  const isApplyingRemoteRef = useRef(false);
  const inputDebounceRef = useRef<number | null>(null);
  const cursorDebounceRef = useRef<number | null>(null);
  const lastSentCursorOffsetRef = useRef<number | null>(null);

  const updateFormatState = () => {
    setFormatState({
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      underline: document.queryCommandState("underline"),
    });
  };

  const computeDiffRange = (
    previousText: string,
    nextText: string,
  ): { prefixLength: number; previousReplaceEnd: number; nextReplaceEnd: number } => {
    let prefixLength = 0;

    while (
      prefixLength < previousText.length &&
      prefixLength < nextText.length &&
      previousText.charCodeAt(prefixLength) === nextText.charCodeAt(prefixLength)
    ) {
      prefixLength += 1;
    }

    let suffixLength = 0;
    const maxSuffixLength = Math.min(previousText.length - prefixLength, nextText.length - prefixLength);

    while (
      suffixLength < maxSuffixLength &&
      previousText.charCodeAt(previousText.length - 1 - suffixLength) === nextText.charCodeAt(nextText.length - 1 - suffixLength)
    ) {
      suffixLength += 1;
    }

    return {
      prefixLength,
      previousReplaceEnd: previousText.length - suffixLength,
      nextReplaceEnd: nextText.length - suffixLength,
    };
  };

  const mapOffsetThroughTextChange = (previousText: string, nextText: string, previousOffset: number): number => {
    const clampedOffset = Math.max(0, Math.min(previousOffset, previousText.length));
    const { prefixLength, previousReplaceEnd, nextReplaceEnd } = computeDiffRange(previousText, nextText);

    if (clampedOffset <= prefixLength) {
      return clampedOffset;
    }

    if (clampedOffset >= previousReplaceEnd) {
      const delta = nextReplaceEnd - previousReplaceEnd;
      return Math.max(0, Math.min(clampedOffset + delta, nextText.length));
    }

    return nextReplaceEnd;
  };

  const getNodeOffset = (root: HTMLElement, container: Node, nodeOffset: number): number => {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(container, nodeOffset);
    return range.toString().length;
  };

  const findNodeAtOffset = (root: HTMLElement, offset: number): { node: Node; offset: number } => {
    const normalizedOffset = Math.max(0, offset);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let traversed = 0;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const length = node.nodeValue?.length ?? 0;
      if (traversed + length >= normalizedOffset) {
        return {
          node,
          offset: normalizedOffset - traversed,
        };
      }
      traversed += length;
    }

    return {
      node: root,
      offset: root.childNodes.length,
    };
  };

  const getSelectionSnapshot = (root: HTMLElement): SelectionSnapshot => {
    const selection = window.getSelection();
    if (
      !selection ||
      selection.rangeCount === 0 ||
      !selection.anchorNode ||
      !selection.focusNode ||
      !root.contains(selection.anchorNode) ||
      !root.contains(selection.focusNode)
    ) {
      return { hasFocus: false, anchorOffset: 0, focusOffset: 0 };
    }

    return {
      hasFocus: true,
      anchorOffset: getNodeOffset(root, selection.anchorNode, selection.anchorOffset),
      focusOffset: getNodeOffset(root, selection.focusNode, selection.focusOffset),
    };
  };

  const restoreSelectionSnapshot = (root: HTMLElement, snapshot: SelectionSnapshot): void => {
    const selection = window.getSelection();
    if (!selection || !snapshot.hasFocus) {
      return;
    }

    const anchor = findNodeAtOffset(root, snapshot.anchorOffset);
    const focus = findNodeAtOffset(root, snapshot.focusOffset);
    selection.removeAllRanges();

    if (typeof selection.setBaseAndExtent === "function") {
      selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
      return;
    }

    const range = document.createRange();
    range.setStart(anchor.node, anchor.offset);
    range.setEnd(focus.node, focus.offset);
    selection.addRange(range);
  };

  const flushEditorText = (): void => {
    const nextText = editorRef.current?.innerText ?? "";
    onEditorTextChange(nextText);
  };

  const scheduleEditorTextFlush = (): void => {
    if (inputDebounceRef.current !== null) {
      window.clearTimeout(inputDebounceRef.current);
    }

    inputDebounceRef.current = window.setTimeout(() => {
      inputDebounceRef.current = null;
      flushEditorText();
    }, 75);
  };

  useEffect(() => {
    return () => {
      if (inputDebounceRef.current !== null) {
        window.clearTimeout(inputDebounceRef.current);
      }

      if (cursorDebounceRef.current !== null) {
        window.clearTimeout(cursorDebounceRef.current);
      }
    };
  }, []);

  const getCaretOffset = (root: HTMLElement): number | null => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.focusNode || !root.contains(selection.focusNode)) {
      return null;
    }

    return getNodeOffset(root, selection.focusNode, selection.focusOffset);
  };

  const sendCursorChange = (offset: number | null): void => {
    if (lastSentCursorOffsetRef.current === offset) {
      return;
    }

    lastSentCursorOffsetRef.current = offset;
    onCursorChange(offset);
  };

  const scheduleCursorUpdate = (): void => {
    if (cursorDebounceRef.current !== null) {
      window.clearTimeout(cursorDebounceRef.current);
    }

    cursorDebounceRef.current = window.setTimeout(() => {
      cursorDebounceRef.current = null;
      sendCursorChange(editorRef.current ? getCaretOffset(editorRef.current) : null);
    }, 60);
  };

  const handleInput = () => {
    updateFormatState();
    if (isApplyingRemoteRef.current) {
      return;
    }
    scheduleEditorTextFlush();
    scheduleCursorUpdate();
  };

  useEffect(() => {
    if (!editorRef.current) {
      return;
    }

    const nextText = editorText ?? "";
    const previousText = editorRef.current.innerText;
    if (previousText === nextText) {
      return;
    }

    const previousSelection = getSelectionSnapshot(editorRef.current);
    isApplyingRemoteRef.current = true;
    editorRef.current.textContent = nextText;
    isApplyingRemoteRef.current = false;

    if (previousSelection.hasFocus) {
      restoreSelectionSnapshot(editorRef.current, {
        hasFocus: true,
        anchorOffset: mapOffsetThroughTextChange(previousText, nextText, previousSelection.anchorOffset),
        focusOffset: mapOffsetThroughTextChange(previousText, nextText, previousSelection.focusOffset),
      });

      scheduleCursorUpdate();
    }
  }, [editorText]);

  const toggleFullscreen = () => {
    setIsFullscreen((prev) => !prev);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      document.execCommand("insertText", false, "\t");
    } else if (e.key === "Enter") {
      // let default take over
    }
  };

  const handleKeyUp = (): void => {
    updateFormatState();
    scheduleCursorUpdate();
  };

  const handleMouseUp = (): void => {
    updateFormatState();
    scheduleCursorUpdate();
  };

  const handleEditorFocus = (): void => {
    scheduleCursorUpdate();
  };

  const handleEditorBlur = (): void => {
    if (cursorDebounceRef.current !== null) {
      window.clearTimeout(cursorDebounceRef.current);
      cursorDebounceRef.current = null;
    }

    sendCursorChange(null);
  };

  const applyFormat = (command: string) => {
    document.execCommand(command, false, undefined);
    editorRef.current?.focus();
    updateFormatState();
    handleInput();
  };

  const handleClear = () => {
    setIsConfirmingClear(true);
  };

  const confirmClear = () => {
    if (editorRef.current) {
      editorRef.current.textContent = "";
      if (inputDebounceRef.current !== null) {
        window.clearTimeout(inputDebounceRef.current);
        inputDebounceRef.current = null;
      }
      onEditorTextChange("");
    }
    setIsConfirmingClear(false);
  };

  const cancelClear = () => {
    setIsConfirmingClear(false);
  };

  const handleDownload = () => {
    if (editorRef.current) {
      const text = editorRef.current.innerText || "";
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "shared-notes.txt";
      link.click();
      URL.revokeObjectURL(url);
    }
  };

  const remoteCursorSummary = useMemo(() => {
    const text = editorText ?? "";

    const offsetToLineColumn = (offset: number): { line: number; column: number } => {
      const clampedOffset = Math.max(0, Math.min(offset, text.length));
      let line = 1;
      let column = 1;

      for (let index = 0; index < clampedOffset; index += 1) {
        if (text.charCodeAt(index) === 10) {
          line += 1;
          column = 1;
        } else {
          column += 1;
        }
      }

      return { line, column };
    };

    return remoteCursors
      .slice()
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
      .map((cursor) => ({
        ...cursor,
        ...offsetToLineColumn(cursor.cursorOffset),
      }));
  }, [editorText, remoteCursors]);

  return (
    <div 
      className="card" 
      style={{ 
        display: "flex", 
        flexDirection: "column", 
        gap: "16px", 
        height: isFullscreen ? "100vh" : "100%", 
        width: isFullscreen ? "100vw" : "100%",
        padding: "16px",
        position: isFullscreen ? "fixed" : "static",
        top: isFullscreen ? 0 : "auto",
        left: isFullscreen ? 0 : "auto",
        zIndex: isFullscreen ? 9999 : "auto",
        backgroundColor: "var(--ui-surface-strong)",
        boxSizing: "border-box",
        borderRadius: isFullscreen ? 0 : undefined,
        margin: 0
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px", borderBottom: "1px solid var(--ui-border-soft)", paddingBottom: "12px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <h2 style={{ margin: 0, fontSize: "1.1rem", whiteSpace: "nowrap" }}>Shared Text Editor</h2>
          {remoteCursorSummary.length > 0 ? (
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {remoteCursorSummary.map((cursor) => (
                <span
                  key={cursor.peerId}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    fontSize: "0.78rem",
                    padding: "4px 8px",
                    borderRadius: "999px",
                    background: "var(--ui-info-bg)",
                    color: "var(--scheme-brand-1100)",
                    border: "1px solid var(--ui-border-strong)",
                  }}
                  title={`Cursor at line ${cursor.line}, column ${cursor.column}`}
                >
                  <span style={{ width: "7px", height: "7px", borderRadius: "999px", background: "var(--scheme-brand-700)" }} />
                  {cursor.displayName}: L{cursor.line}, C{cursor.column}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        
        <div style={{ display: "flex", gap: "24px", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {/* Tools Group */}
          <div style={{ display: "flex", gap: "4px", background: "var(--ui-bg-muted)", padding: "4px", borderRadius: "8px" }}>
            <button 
              onClick={() => applyFormat("bold")} 
              style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", borderRadius: "6px", border: "none", background: formatState.bold ? "var(--ui-info-bg-strong)" : "transparent", boxShadow: formatState.bold ? "var(--ui-shadow-pressable)" : "none", color: "var(--ui-text-primary)", cursor: "pointer", fontWeight: "bold", fontSize: "0.9rem" }}
              title="Bold"
            >
              B
            </button>
            <button 
              onClick={() => applyFormat("italic")} 
              style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", borderRadius: "6px", border: "none", background: formatState.italic ? "var(--ui-info-bg-strong)" : "transparent", boxShadow: formatState.italic ? "var(--ui-shadow-pressable)" : "none", color: "var(--ui-text-primary)", cursor: "pointer", fontStyle: "italic", fontSize: "0.9rem" }}
              title="Italic"
            >
              I
            </button>
            <button 
              onClick={() => applyFormat("underline")} 
              style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", borderRadius: "6px", border: "none", background: formatState.underline ? "var(--ui-info-bg-strong)" : "transparent", boxShadow: formatState.underline ? "var(--ui-shadow-pressable)" : "none", color: "var(--ui-text-primary)", cursor: "pointer", textDecoration: "underline", fontSize: "0.9rem" }}
              title="Underline"
            >
              U
            </button>
          </div>

          {/* Actions Group */}
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={handleClear} className="action-button default" title="Clear Editor" style={{ fontWeight: "600" }}>
              Trash
            </button>
            <button onClick={handleDownload} className="action-button primary" title="Download Text" style={{ fontWeight: "600" }}>
              Save
            </button>
            <button onClick={toggleFullscreen} className="action-button secondary" title="Toggle Fullscreen" style={{ fontWeight: "600" }}>
              {isFullscreen ? "Exit Full" : "Full"}
            </button>
          </div>
        </div>
      </div>
      <div style={{ flex: 1, border: "1px solid var(--ui-border-soft)", borderRadius: "8px", overflow: "hidden", background: "var(--ui-surface-panel)", position: "relative", display: "flex", flexDirection: "column" }}>
        {isConfirmingClear && (
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: "var(--ui-overlay-soft)", zIndex: 10, display: "flex", justifyContent: "center", alignItems: "center" }}>
            <div style={{ background: "var(--ui-surface-strong)", padding: "24px 32px", borderRadius: "12px", boxShadow: "var(--ui-shadow-panel)", border: "1px solid var(--ui-border-panel)", textAlign: "center" }}>
              <h3 style={{ margin: "0 0 16px 0", color: "var(--ui-text-primary)" }}>This will delete all text. Are you sure?</h3>
              <div style={{ display: "flex", gap: "12px", justifyContent: "center" }}>
                <button 
                  onClick={cancelClear} 
                  className="action-button default"
                  style={{ fontWeight: "bold", padding: "8px 24px" }}
                >
                  Cancel
                </button>
                <button 
                  onClick={confirmClear} 
                  style={{ background: "var(--ui-danger-gradient)", color: "var(--ui-text-inverse)", border: "none", padding: "8px 24px", borderRadius: "6px", cursor: "pointer", fontWeight: "500" }}
                >
                  Trash Anyway
                </button>
              </div>
            </div>
          </div>
        )}
        <div
          ref={editorRef}
          contentEditable
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onMouseUp={handleMouseUp}
          onFocus={handleEditorFocus}
          onBlur={handleEditorBlur}
          style={{
            flex: 1,
            padding: "16px",
            outline: "none",
            backgroundColor: "var(--ui-surface-strong)",
            color: "var(--ui-text-primary)",
            overflowY: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word"
          }}
        />
      </div>
    </div>
  );
}
