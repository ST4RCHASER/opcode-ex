import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface TerminalInstanceProps {
  terminalId: string;
  projectPath: string;
  isVisible: boolean;
  onTitleChange?: (title: string) => void;
}

export const TerminalInstance: React.FC<TerminalInstanceProps> = ({
  terminalId,
  projectPath,
  isVisible,
  onTitleChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const callbacksRef = useRef({ onTitleChange });
  callbacksRef.current = { onTitleChange };

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        "'MesloLGS NF', 'Hack Nerd Font', 'FiraCode Nerd Font', 'JetBrainsMono Nerd Font', 'MesloLGS Nerd Font Mono', Menlo, Monaco, 'Courier New', monospace",
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
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch { /* container may not be visible yet */ }
    });

    // Auto-fit on container resize (debounced)
    let resizeTimer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try { fitAddon.fit(); } catch { /* ignore */ }
      }, 100);
    });
    if (containerRef.current) observer.observe(containerRef.current);

    term.onTitleChange((t) => callbacksRef.current.onTitleChange?.(t));

    let outputUn: (() => void) | null = null;
    let exitUn: (() => void) | null = null;

    (async () => {
      // Listen for PTY output - decode base64 to Uint8Array for proper UTF-8
      outputUn = await listen(`terminal-output:${terminalId}`, (ev: any) => {
        try {
          const bin = atob(ev.payload as string);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          term.write(bytes);
        } catch { /* ignore decode errors */ }
      });

      exitUn = await listen(`terminal-exit:${terminalId}`, () => {
        term.write("\r\n\x1b[90m[Terminal session ended]\x1b[0m\r\n");
      });

      // Send keystrokes to PTY
      term.onData((data) => {
        invoke("terminal_write", { terminalId, data: btoa(data) }).catch(() => {});
      });

      // Send resize events to PTY
      term.onResize(({ cols, rows }) => {
        invoke("terminal_resize", { terminalId, cols, rows }).catch(() => {});
      });

      // Spawn the PTY process
      try {
        await invoke("terminal_spawn", { terminalId, cwd: projectPath || "." });
        setTimeout(() => { try { fitAddon.fit(); } catch { /* ignore */ } }, 100);
      } catch (e) {
        term.write(`\x1b[31mFailed to start terminal: ${e}\x1b[0m\r\n`);
      }
    })();

    return () => {
      clearTimeout(resizeTimer);
      observer.disconnect();
      invoke("terminal_kill", { terminalId }).catch(() => {});
      outputUn?.();
      exitUn?.();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [terminalId, projectPath]);

  // Refit and focus when this terminal becomes visible
  useEffect(() => {
    if (isVisible) {
      setTimeout(() => {
        try { fitAddonRef.current?.fit(); } catch { /* ignore */ }
        termRef.current?.focus();
      }, 50);
    }
  }, [isVisible]);

  return (
    <div ref={containerRef} className="h-full w-full" style={{ padding: "2px 4px" }} />
  );
};
