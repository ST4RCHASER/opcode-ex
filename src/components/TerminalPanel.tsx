import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { X, GripHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

interface TerminalPanelProps {
  projectPath: string;
  isOpen: boolean;
  onClose: () => void;
  height: number;
  onHeightChange: (h: number) => void;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  projectPath,
  isOpen,
  onClose,
  height,
  onHeightChange,
}) => {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const unlistenExitRef = useRef<(() => void) | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!isOpen || !termRef.current) return;

    const terminalId = crypto.randomUUID();
    terminalIdRef.current = terminalId;

    // Create xterm instance
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'MesloLGS NF', 'Hack Nerd Font', 'FiraCode Nerd Font', 'JetBrainsMono Nerd Font', 'MesloLGS Nerd Font Mono', Menlo, Monaco, 'Courier New', monospace",
      letterSpacing: 0,
      lineHeight: 1.1,
      theme: {
        background: "#1a1a2e",
        foreground: "#e0e0e0",
        cursor: "#a78bfa",
        selectionBackground: "#a78bfa40",
        black: "#1a1a2e",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#fbbf24",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e0e0e0",
        brightBlack: "#4a4a6a",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde68a",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#ffffff",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(termRef.current);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Fit after a frame
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    // Auto-fit on container resize (debounced to avoid redraw loops)
    let resizeTimer: ReturnType<typeof setTimeout>;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try { fitAddon.fit(); } catch (_) {}
      }, 100);
    });
    if (termRef.current) resizeObserver.observe(termRef.current);

    // Set up event listeners
    let outputUnlisten: (() => void) | null = null;
    let exitUnlisten: (() => void) | null = null;

    const setup = async () => {
      // Listen for PTY output — decode base64 to Uint8Array for proper UTF-8
      outputUnlisten = await listen(`terminal-output:${terminalId}`, (event: any) => {
        try {
          const binary = atob(event.payload as string);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          term.write(bytes);
        } catch (e) {
          console.error("Failed to decode terminal output:", e);
        }
      });
      unlistenRef.current = outputUnlisten;

      // Listen for PTY exit
      exitUnlisten = await listen(`terminal-exit:${terminalId}`, () => {
        term.write("\r\n\x1b[90m[Terminal session ended]\x1b[0m\r\n");
      });
      unlistenExitRef.current = exitUnlisten;

      // Send keystrokes to PTY
      term.onData((data) => {
        invoke("terminal_write", {
          terminalId,
          data: btoa(data),
        }).catch((e) => console.error("terminal_write error:", e));
      });

      // Send resize events
      term.onResize(({ cols, rows }) => {
        invoke("terminal_resize", { terminalId, cols, rows }).catch((e) =>
          console.error("terminal_resize error:", e)
        );
      });

      // Spawn the PTY
      try {
        await invoke("terminal_spawn", {
          terminalId,
          cwd: projectPath || ".",
        });
        // Initial fit after spawn
        setTimeout(() => fitAddon.fit(), 100);
      } catch (e) {
        term.write(`\x1b[31mFailed to start terminal: ${e}\x1b[0m\r\n`);
      }
    };

    setup();

    return () => {
      clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      if (terminalIdRef.current) {
        invoke("terminal_kill", { terminalId: terminalIdRef.current }).catch(() => {});
      }
      unlistenRef.current?.();
      unlistenExitRef.current?.();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      terminalIdRef.current = null;
    };
  }, [isOpen, projectPath]);

  // Refit on height change
  useEffect(() => {
    if (fitAddonRef.current && isOpen) {
      setTimeout(() => fitAddonRef.current?.fit(), 50);
    }
  }, [height, isOpen]);

  // Drag resize handler
  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const startY = e.clientY;
    const startHeight = height;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = startY - moveEvent.clientY;
      const newHeight = Math.min(Math.max(startHeight + delta, 120), window.innerHeight * 0.6);
      onHeightChange(newHeight);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      // Refit after resize
      setTimeout(() => fitAddonRef.current?.fit(), 50);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  if (!isOpen) return null;

  // Calculate terminal area height (total - drag handle - header - prompt bar)
  const headerHeight = 36; // drag handle (6px) + header (~30px)
  const promptBarHeight = 80; // floating prompt input below the terminal

  return (
    <div
      className="flex flex-col bg-[#1a1a2e] border-t border-border"
      style={{ height: `${height}px` }}
    >
      {/* Drag handle */}
      <div
        className={cn(
          "h-1.5 flex-shrink-0 cursor-row-resize flex items-center justify-center hover:bg-primary/20 transition-colors",
          isDragging && "bg-primary/30"
        )}
        onMouseDown={handleDragStart}
      >
        <GripHorizontal className="h-3 w-3 text-muted-foreground/50" />
      </div>

      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-3 py-1 bg-[#1a1a2e] border-b border-border/30">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Terminal
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              if (terminalIdRef.current) {
                invoke("terminal_kill", { terminalId: terminalIdRef.current }).catch(() => {});
              }
              onClose();
            }}
            className="p-1 rounded hover:bg-muted/30 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal container — explicit height so xterm can calculate rows/cols */}
      <div
        ref={termRef}
        style={{ height: `${height - headerHeight - promptBarHeight}px`, padding: '2px 4px' }}
      />
    </div>
  );
};
