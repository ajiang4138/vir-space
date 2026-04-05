import React, { useRef, useEffect, useState } from "react";

interface TextEditorPanelProps {
  roomId: string;
  onSendUpdate: (data: string, displayName: string) => void;
  displayName: string;
  editorHtml?: string;
}

export function TextEditorPanel({ roomId, onSendUpdate, displayName, editorHtml }: TextEditorPanelProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  const [formatState, setFormatState] = useState({ bold: false, italic: false, underline: false });
  const isUpdatingRef = useRef(false);

  const updateFormatState = () => {
    setFormatState({
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      underline: document.queryCommandState("underline"),
    });
  };

  const pendingHtmlRef = useRef<string | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      if (pendingHtmlRef.current !== null && !isUpdatingRef.current) {
        onSendUpdate(JSON.stringify({ action: "update", html: pendingHtmlRef.current }), displayName);
        pendingHtmlRef.current = null;
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [roomId, onSendUpdate, displayName]);

  // Send update to peers
  const handleInput = () => {
    updateFormatState();
    if (isUpdatingRef.current) return;
    if (editorRef.current) {
      pendingHtmlRef.current = editorRef.current.innerHTML;
    }
  };

  useEffect(() => {
    const handleEditorUpdateEvent = (event: Event) => {
      const customEvent = event as CustomEvent;
      const message = customEvent.detail;
      if (message && message.type === "editor-update" && editorRef.current) {
        try {
          const parsedData = JSON.parse(message.data);
          if (parsedData.action === "update") {
            if (editorRef.current.innerHTML !== parsedData.html) {
              isUpdatingRef.current = true;
              
              // Try to save simple selection state
              const sel = window.getSelection();
              let savedOffset = 0;
              let hasFocus = false;
              try {
                if (sel && sel.rangeCount > 0 && editorRef.current.contains(sel.anchorNode)) {
                  hasFocus = true;
                  // Very basic preservation: length of text before selection
                  const range = sel.getRangeAt(0);
                  const preSelectionRange = range.cloneRange();
                  preSelectionRange.selectNodeContents(editorRef.current);
                  preSelectionRange.setEnd(range.startContainer, range.startOffset);
                  savedOffset = preSelectionRange.toString().length;
                }
              } catch (e) {
                console.error("Failed to save selection:", e);
                hasFocus = false;
              }

              try {
                editorRef.current.innerHTML = parsedData.html;
              } catch (e) {
                console.error("Failed to update HTML:", e);
              }
              
              // Try to restore selection state
              if (hasFocus && sel) {
                try {
                  // Find node and offset
                  const walker = document.createTreeWalker(editorRef.current, NodeFilter.SHOW_TEXT, null);
                  let currentOffset = 0;
                  let foundNode = null;
                  let nodeOffset = 0;

                  while (walker.nextNode()) {
                    const node = walker.currentNode;
                    const length = node.nodeValue?.length || 0;
                    if (currentOffset + length >= savedOffset) {
                      foundNode = node;
                      nodeOffset = savedOffset - currentOffset;
                      break;
                    }
                    currentOffset += length;
                  }

                  if (foundNode) {
                    const newRange = document.createRange();
                    newRange.setStart(foundNode, nodeOffset);
                    newRange.setEnd(foundNode, nodeOffset);
                    sel.removeAllRanges();
                    sel.addRange(newRange);
                  }
                } catch (e) {
                  console.error("Failed to restore selection:", e);
                }
              }

              isUpdatingRef.current = false;
            }
          }
        } catch (error) {
          console.error("Failed to parse editor update:", error);
          isUpdatingRef.current = false;
        }
      }
    };

    document.addEventListener("editor-update", handleEditorUpdateEvent);
    return () => {
      document.removeEventListener("editor-update", handleEditorUpdateEvent);
    };
  }, []);

  useEffect(() => {
    if (!editorRef.current) {
      return;
    }

    const nextHtml = editorHtml ?? "";
    if (editorRef.current.innerHTML === nextHtml) {
      return;
    }

    isUpdatingRef.current = true;
    editorRef.current.innerHTML = nextHtml;
    isUpdatingRef.current = false;
  }, [editorHtml]);

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
      editorRef.current.innerHTML = "";
      handleInput(); // Re-use handleInput to send update
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
