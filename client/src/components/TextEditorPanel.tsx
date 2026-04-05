import React, { useEffect, useRef, useState } from "react";

interface TextEditorPanelProps {
  editorText: string;
  onEditorTextChange: (nextText: string) => void;
}

export function TextEditorPanel({ editorText, onEditorTextChange }: TextEditorPanelProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  const [formatState, setFormatState] = useState({ bold: false, italic: false, underline: false });
  const isApplyingRemoteRef = useRef(false);
  const inputDebounceRef = useRef<number | null>(null);

  const updateFormatState = () => {
    setFormatState({
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      underline: document.queryCommandState("underline"),
    });
  };

  const getSelectionOffset = (root: HTMLElement): { hasFocus: boolean; offset: number } => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !root.contains(selection.anchorNode)) {
      return { hasFocus: false, offset: 0 };
    }

    const range = selection.getRangeAt(0);
    const beforeRange = range.cloneRange();
    beforeRange.selectNodeContents(root);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    return { hasFocus: true, offset: beforeRange.toString().length };
  };

  const restoreSelectionOffset = (root: HTMLElement, offset: number): void => {
    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let traversed = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const length = node.nodeValue?.length ?? 0;
      if (traversed + length >= offset) {
        const nodeOffset = offset - traversed;
        const range = document.createRange();
        range.setStart(node, nodeOffset);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      traversed += length;
    }

    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    selection.removeAllRanges();
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
    };
  }, []);

  const handleInput = () => {
    updateFormatState();
    if (isApplyingRemoteRef.current) {
      return;
    }
    scheduleEditorTextFlush();
  };

  useEffect(() => {
    if (!editorRef.current) {
      return;
    }

    const nextText = editorText ?? "";
    if (editorRef.current.innerText === nextText) {
      return;
    }

    const { hasFocus, offset } = getSelectionOffset(editorRef.current);
    isApplyingRemoteRef.current = true;
    editorRef.current.textContent = nextText;
    isApplyingRemoteRef.current = false;

    if (hasFocus) {
      restoreSelectionOffset(editorRef.current, Math.min(offset, nextText.length));
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
        backgroundColor: "#fff",
        boxSizing: "border-box",
        borderRadius: isFullscreen ? 0 : undefined,
        margin: 0
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px", borderBottom: "1px solid #eee", paddingBottom: "12px" }}>
        <h2 style={{ margin: 0, fontSize: "1.1rem", whiteSpace: "nowrap" }}>Shared Text Editor</h2>
        
        <div style={{ display: "flex", gap: "24px", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {/* Tools Group */}
          <div style={{ display: "flex", gap: "4px", background: "#f1f5f9", padding: "4px", borderRadius: "8px" }}>
            <button 
              onClick={() => applyFormat("bold")} 
              style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", borderRadius: "6px", border: "none", background: formatState.bold ? "#fff" : "transparent", boxShadow: formatState.bold ? "0 1px 3px rgba(0,0,0,0.1)" : "none", color: "#000", cursor: "pointer", fontWeight: "bold", fontSize: "0.9rem" }}
              title="Bold"
            >
              B
            </button>
            <button 
              onClick={() => applyFormat("italic")} 
              style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", borderRadius: "6px", border: "none", background: formatState.italic ? "#fff" : "transparent", boxShadow: formatState.italic ? "0 1px 3px rgba(0,0,0,0.1)" : "none", color: "#000", cursor: "pointer", fontStyle: "italic", fontSize: "0.9rem" }}
              title="Italic"
            >
              I
            </button>
            <button 
              onClick={() => applyFormat("underline")} 
              style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", borderRadius: "6px", border: "none", background: formatState.underline ? "#fff" : "transparent", boxShadow: formatState.underline ? "0 1px 3px rgba(0,0,0,0.1)" : "none", color: "#000", cursor: "pointer", textDecoration: "underline", fontSize: "0.9rem" }}
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
      <div style={{ flex: 1, border: "1px solid #ccc", borderRadius: "8px", overflow: "hidden", background: "#f5f5f5", position: "relative", display: "flex", flexDirection: "column" }}>
        {isConfirmingClear && (
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(255,255,255,0.85)", zIndex: 10, display: "flex", justifyContent: "center", alignItems: "center" }}>
            <div style={{ background: "#fff", padding: "24px 32px", borderRadius: "12px", boxShadow: "0 8px 24px rgba(0,0,0,0.15)", border: "1px solid #eee", textAlign: "center" }}>
              <h3 style={{ margin: "0 0 16px 0", color: "#333" }}>This will delete all text. Are you sure?</h3>
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
                  style={{ background: "#ef4444", color: "#fff", border: "none", padding: "8px 24px", borderRadius: "6px", cursor: "pointer", fontWeight: "500" }}
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
          onKeyUp={updateFormatState}
          onMouseUp={updateFormatState}
          style={{
            flex: 1,
            padding: "16px",
            outline: "none",
            backgroundColor: "#fff",
            overflowY: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word"
          }}
        />
      </div>
    </div>
  );
}
