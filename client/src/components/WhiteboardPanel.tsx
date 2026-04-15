import { useEffect, useRef, useState } from "react";
import { ReactSketchCanvas, ReactSketchCanvasRef } from "react-sketch-canvas";
import { THEME_DEFAULTS } from "../theme/themeDefaults";

interface WhiteboardPanelProps {
  roomId: string;
  onSendUpdate: (data: string, displayName: string) => void;
  displayName: string;
  whiteboardHistory?: Array<{ action: string; data: string; senderPeerId: string; senderDisplayName: string }>;
}

export function WhiteboardPanel({ roomId, onSendUpdate, displayName, whiteboardHistory }: WhiteboardPanelProps) {
  const canvasRef = useRef<ReactSketchCanvasRef>(null);
  const getThemeColor = (name: string, fallback: string): string => {
    if (typeof window === "undefined") {
      return fallback;
    }

    const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  };

  const [penColor, setPenColor] = useState(() => getThemeColor("--whiteboard-pen-default", THEME_DEFAULTS.whiteboardPen));
  const [highlighterColor, setHighlighterColor] = useState(() => getThemeColor("--whiteboard-highlighter-default", THEME_DEFAULTS.whiteboardHighlighter));
  const [strokeSizePreset, setStrokeSizePreset] = useState<"small" | "medium" | "large">("medium");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [tool, setTool] = useState<"pen" | "highlighter" | "eraser">("pen");
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);

  const activeColor = tool === "highlighter" ? highlighterColor : penColor;

  // Calculate actual thickness based on tool and size preset
  const getStrokeWidthForPreset = (t: string, preset: string) => {
    switch (t) {
      case "pen":
        return preset === "small" ? 2 : preset === "medium" ? 4 : 8;
      case "highlighter":
        return preset === "small" ? 14 : preset === "medium" ? 22 : 32;
      case "eraser":
        return preset === "small" ? 20 : preset === "medium" ? 40 : 60;
      default:
        return 4;
    }
  };

  const getVisualDotSize = (t: string, preset: string) => {
    if (t === "pen") return preset === "small" ? 4 : preset === "medium" ? 8 : 14;
    if (t === "highlighter") return preset === "small" ? 12 : preset === "medium" ? 18 : 26;
    if (t === "eraser") return preset === "small" ? 16 : preset === "medium" ? 24 : 32;
    return 10;
  };

  const getStrokeWidth = () => getStrokeWidthForPreset(tool, strokeSizePreset);

  // Update canvas erase mode when tool changes
  useEffect(() => {
    canvasRef.current?.eraseMode(tool === "eraser");
  }, [tool]);

  const isUpdatingRef = useRef(false);

  const lastReceivedPathRef = useRef<string | null>(null);

  const handleStroke = (path: any) => {
    if (isUpdatingRef.current) return;
    const pathString = JSON.stringify(path);
    if (lastReceivedPathRef.current === pathString) return; // Prevent loop
    onSendUpdate(JSON.stringify({ action: "stroke", path }), displayName);
  };

  useEffect(() => {
    const handleWhiteboardUpdate = async (event: Event) => {
      const customEvent = event as CustomEvent;
      const message = customEvent.detail;
      if (message && message.type === "whiteboard-update" && canvasRef.current) {
        try {
          const parsedData = JSON.parse(message.data);
          if (parsedData.action === "stroke") {
            isUpdatingRef.current = true;
            lastReceivedPathRef.current = JSON.stringify(parsedData.path);
            try {
              await canvasRef.current.loadPaths([parsedData.path]);
            } catch (err) {
              console.error("Failed to load stroke", err);
            } finally {
              isUpdatingRef.current = false;
            }
          } else if (parsedData.action === "paths") {
            isUpdatingRef.current = true;
            lastReceivedPathRef.current = JSON.stringify(parsedData.paths);
            try {
              await canvasRef.current.loadPaths(parsedData.paths);
            } catch (err) {
              console.error("Failed to load paths", err);
            } finally {
              isUpdatingRef.current = false;
            }
          } else if (parsedData.action === "clear") {
            isUpdatingRef.current = true;
            try {
              canvasRef.current.clearCanvas();
              lastReceivedPathRef.current = null;
            } finally {
              isUpdatingRef.current = false;
            }
          }
        } catch (error) {
          console.error("Failed to parse whiteboard update:", error);
          isUpdatingRef.current = false;
        }
      }
    };

    document.addEventListener("whiteboard-update", handleWhiteboardUpdate);
    return () => {
      document.removeEventListener("whiteboard-update", handleWhiteboardUpdate);
    };
  }, []);

  // Replay whiteboard history when component mounts or history changes
  useEffect(() => {
    if (!whiteboardHistory || whiteboardHistory.length === 0 || !canvasRef.current) {
      return;
    }

    const replayHistory = async () => {
      isUpdatingRef.current = true;
      try {
        for (const update of whiteboardHistory) {
          const parsedData = JSON.parse(update.data);
          if (parsedData.action === "stroke") {
            try {
              await canvasRef.current?.loadPaths([parsedData.path]);
              lastReceivedPathRef.current = JSON.stringify(parsedData.path);
            } catch (err) {
              console.error("Failed to replay stroke", err);
            }
          } else if (parsedData.action === "paths") {
            try {
              await canvasRef.current?.loadPaths(parsedData.paths);
              lastReceivedPathRef.current = JSON.stringify(parsedData.paths);
            } catch (err) {
              console.error("Failed to replay paths", err);
            }
          } else if (parsedData.action === "clear") {
            try {
              canvasRef.current?.clearCanvas();
              lastReceivedPathRef.current = null;
            } catch (err) {
              console.error("Failed to replay clear", err);
            }
          }
        }
      } finally {
        isUpdatingRef.current = false;
      }
    };

    void replayHistory();
  }, [whiteboardHistory]);

  const handleClear = () => {
    setIsConfirmingClear(true);
  };

  const confirmClear = () => {
    canvasRef.current?.clearCanvas();
    onSendUpdate(JSON.stringify({ action: "clear" }), displayName);
    setIsConfirmingClear(false);
  };

  const cancelClear = () => {
    setIsConfirmingClear(false);
  };

  const handleDownload = async () => {
    const dataUrl = await canvasRef.current?.exportImage("png");
    if (dataUrl) {
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = "whiteboard.png";
      link.click();
    }
  };

  const toggleFullscreen = () => {
    setIsFullscreen((prev) => !prev);
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
        backgroundColor: "var(--ui-surface-strong)",
        boxSizing: "border-box",
        borderRadius: isFullscreen ? 0 : undefined,
        margin: 0
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px", borderBottom: "1px solid var(--ui-border-soft)", paddingBottom: "12px" }}>
        <h2 style={{ margin: 0, fontSize: "1.1rem", whiteSpace: "nowrap" }}>Shared Whiteboard</h2>
        
        <div style={{ display: "flex", gap: "24px", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {/* Tools Group */}
          <div style={{ display: "flex", gap: "4px", background: "var(--ui-bg-muted)", padding: "4px", borderRadius: "8px" }}>
            <button 
              onClick={() => setTool("pen")} 
              style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", borderRadius: "6px", border: "none", background: tool === "pen" ? "var(--ui-info-bg-strong)" : "transparent", boxShadow: tool === "pen" ? "var(--ui-shadow-pressable)" : "none", color: "var(--ui-text-primary)", cursor: "pointer", fontWeight: tool === "pen" ? "bold" : "500", fontSize: "0.9rem" }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>
              Pen
            </button>
            <button 
              onClick={() => setTool("highlighter")} 
              style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", borderRadius: "6px", border: "none", background: tool === "highlighter" ? "var(--ui-info-bg-strong)" : "transparent", boxShadow: tool === "highlighter" ? "var(--ui-shadow-pressable)" : "none", color: "var(--ui-text-primary)", cursor: "pointer", fontWeight: tool === "highlighter" ? "bold" : "500", fontSize: "0.9rem" }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l-6 6v3h9l3-3"/><path d="M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>
              Highlighter
            </button>
            <button 
              onClick={() => setTool("eraser")} 
              style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", borderRadius: "6px", border: "none", background: tool === "eraser" ? "var(--ui-info-bg-strong)" : "transparent", boxShadow: tool === "eraser" ? "var(--ui-shadow-pressable)" : "none", color: "var(--ui-text-primary)", cursor: "pointer", fontWeight: tool === "eraser" ? "bold" : "500", fontSize: "0.9rem" }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20H7L2 15l8-8 8 8-3 3"/></svg>
              Eraser
            </button>
          </div>

          {/* Properties Group */}
          <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "0.9rem", color: "var(--ui-text-primary)", fontWeight: "500" }}>Color:</span>
              <input 
                type="color" 
                title="Color"
                value={activeColor} 
                onChange={(e) => tool === "highlighter" ? setHighlighterColor(e.target.value) : setPenColor(e.target.value)} 
                disabled={tool === "eraser"}
                style={{ width: "24px", height: "24px", cursor: tool === "eraser" ? "not-allowed" : "pointer", padding: 0, border: "1px solid var(--ui-border-soft)", borderRadius: "4px", opacity: tool === "eraser" ? 0.3 : 1 }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "0.9rem", color: "var(--ui-text-primary)", fontWeight: "500" }}>Size:</span>
              <div style={{ display: "flex", background: "var(--ui-bg-muted)", padding: "4px", borderRadius: "8px", gap: "4px", alignItems: "center", height: "40px" }}>
                {(["small", "medium", "large"] as const).map(preset => {
                  const visualSize = getVisualDotSize(tool, preset);
                  return (
                    <button
                      key={preset}
                      onClick={() => setStrokeSizePreset(preset)}
                      style={{ width: "36px", height: "36px", borderRadius: "4px", border: "none", background: strokeSizePreset === preset ? "var(--ui-info-bg-strong)" : "transparent", boxShadow: strokeSizePreset === preset ? "var(--ui-shadow-pressable)" : "none", display: "flex", justifyContent: "center", alignItems: "center", cursor: "pointer" }}
                      title={preset.charAt(0).toUpperCase() + preset.slice(1)}
                    >
                      <div style={{ width: `${visualSize}px`, height: `${visualSize}px`, backgroundColor: tool === "eraser" ? "var(--whiteboard-eraser-preview)" : activeColor, borderRadius: "50%", opacity: 1 }}></div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Actions Group */}
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={handleClear} className="action-button default" title="Clear Canvas" style={{ fontWeight: "600" }}>
              Trash
            </button>
            <button onClick={handleDownload} className="action-button primary" title="Download Image" style={{ fontWeight: "600" }}>
              Save
            </button>
            <button onClick={toggleFullscreen} className="action-button secondary" title="Toggle Fullscreen" style={{ fontWeight: "600" }}>
              {isFullscreen ? "Exit Full" : "Full"}
            </button>
          </div>
        </div>
      </div>
      <div style={{ flex: 1, border: "1px solid var(--ui-border-soft)", borderRadius: "8px", overflow: "hidden", background: "var(--ui-surface-panel)", position: "relative" }}>
        {isConfirmingClear && (
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: "var(--ui-overlay-soft)", zIndex: 10, display: "flex", justifyContent: "center", alignItems: "center" }}>
            <div style={{ background: "var(--ui-surface-strong)", padding: "24px 32px", borderRadius: "12px", boxShadow: "var(--ui-shadow-panel)", border: "1px solid var(--ui-border-panel)", textAlign: "center" }}>
              <h3 style={{ margin: "0 0 16px 0", color: "var(--ui-text-primary)" }}>This will delete everything. Are you sure?</h3>
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
        <ReactSketchCanvas
          ref={canvasRef}
          style={{ border: "none", borderRadius: 0, width: "100%", height: "100%" }}
          strokeWidth={tool === "eraser" ? 4 : getStrokeWidth()}
          eraserWidth={getStrokeWidth()}
          strokeColor={tool === "highlighter" ? activeColor + "80" : activeColor}
          width="100%"
          height="100%"
          onStroke={handleStroke}
        />
      </div>
    </div>
  );
}