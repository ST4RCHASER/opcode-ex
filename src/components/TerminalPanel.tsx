import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  X,
  Plus,
  GripHorizontal,
  Columns2,
  PanelRight,
  TerminalSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TerminalInstance } from "./TerminalInstance";
import { invoke } from "@tauri-apps/api/core";

// --- Types ---

interface TerminalPane {
  id: string;
  terminalId: string;
  name: string;
}

interface TerminalGroup {
  id: string;
  panes: TerminalPane[];
  splitSizes: number[]; // percentages, same length as panes, sums to ~100
}

interface TerminalPanelProps {
  projectPath: string;
  isOpen: boolean;
  onClose: () => void;
  height: number;
  onHeightChange: (h: number) => void;
}

// --- Helpers ---

function createPane(): TerminalPane {
  return {
    id: crypto.randomUUID(),
    terminalId: crypto.randomUUID(),
    name: "zsh",
  };
}

function createGroup(): TerminalGroup {
  const pane = createPane();
  return {
    id: crypto.randomUUID(),
    panes: [pane],
    splitSizes: [100],
  };
}

// --- Component ---

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  projectPath,
  isOpen,
  onClose,
  height,
  onHeightChange,
}) => {
  const [groups, setGroups] = useState<TerminalGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState("");
  const [activePaneId, setActivePaneId] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const initializedRef = useRef(false);

  // Lazy-initialize first terminal when panel first opens
  useEffect(() => {
    if (isOpen && !initializedRef.current) {
      initializedRef.current = true;
      const group = createGroup();
      setGroups([group]);
      setActiveGroupId(group.id);
      setActivePaneId(group.panes[0].id);
    }
  }, [isOpen]);

  // Keep active IDs valid when groups change
  useEffect(() => {
    if (groups.length === 0) return;
    const active = groups.find((g) => g.id === activeGroupId);
    if (!active) {
      const last = groups[groups.length - 1];
      setActiveGroupId(last.id);
      setActivePaneId(last.panes[0].id);
    } else if (!active.panes.find((p) => p.id === activePaneId)) {
      setActivePaneId(active.panes[0].id);
    }
  }, [groups, activeGroupId, activePaneId]);

  // === Actions ===

  const addTerminal = useCallback(() => {
    const group = createGroup();
    setGroups((prev) => [...prev, group]);
    setActiveGroupId(group.id);
    setActivePaneId(group.panes[0].id);
  }, []);

  const splitTerminal = useCallback(() => {
    if (!activeGroupId) return;
    const newPane = createPane();
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== activeGroupId) return g;
        const newPanes = [...g.panes, newPane];
        const size = 100 / newPanes.length;
        return { ...g, panes: newPanes, splitSizes: newPanes.map(() => size) };
      })
    );
    setActivePaneId(newPane.id);
  }, [activeGroupId]);

  const closeGroup = useCallback(
    (groupId: string) => {
      setGroups((prev) => {
        const group = prev.find((g) => g.id === groupId);
        group?.panes.forEach((p) => {
          invoke("terminal_kill", { terminalId: p.terminalId }).catch(() => {});
        });
        const next = prev.filter((g) => g.id !== groupId);
        if (next.length === 0) {
          initializedRef.current = false;
          setTimeout(onClose, 0);
        }
        return next;
      });
    },
    [onClose]
  );

  const closePane = useCallback(
    (groupId: string, paneId: string) => {
      setGroups((prev) =>
        prev.flatMap((g) => {
          if (g.id !== groupId) return [g];
          const pane = g.panes.find((p) => p.id === paneId);
          if (pane) {
            invoke("terminal_kill", { terminalId: pane.terminalId }).catch(() => {});
          }
          const newPanes = g.panes.filter((p) => p.id !== paneId);
          if (newPanes.length === 0) {
            if (prev.length === 1) {
              initializedRef.current = false;
              setTimeout(onClose, 0);
            }
            return [];
          }
          const size = 100 / newPanes.length;
          return [{ ...g, panes: newPanes, splitSizes: newPanes.map(() => size) }];
        })
      );
    },
    [onClose]
  );

  const handleTitleChange = useCallback((paneId: string, title: string) => {
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        panes: g.panes.map((p) => (p.id === paneId ? { ...p, name: title } : p)),
      }))
    );
  }, []);

  const activatePane = useCallback((groupId: string, paneId: string) => {
    setActiveGroupId(groupId);
    setActivePaneId(paneId);
  }, []);

  // === Panel height drag ===

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const startY = e.clientY;
    const startHeight = height;

    const onMove = (me: MouseEvent) => {
      const delta = startY - me.clientY;
      onHeightChange(Math.min(Math.max(startHeight + delta, 150), window.innerHeight * 0.6));
    };
    const onUp = () => {
      setIsDragging(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // === Split divider drag ===

  const handleSplitDrag = (e: React.MouseEvent, groupId: string, dividerIndex: number) => {
    e.preventDefault();
    const container = (e.currentTarget as HTMLElement).parentElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const startX = e.clientX;
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    const startSizes = [...group.splitSizes];
    const pairTotal = startSizes[dividerIndex] + startSizes[dividerIndex + 1];

    const onMove = (me: MouseEvent) => {
      const deltaPercent = ((me.clientX - startX) / rect.width) * 100;
      const newSizes = [...startSizes];
      const left = Math.max(15, Math.min(pairTotal - 15, startSizes[dividerIndex] + deltaPercent));
      newSizes[dividerIndex] = left;
      newSizes[dividerIndex + 1] = pairTotal - left;
      setGroups((prev) =>
        prev.map((g) => (g.id === groupId ? { ...g, splitSizes: newSizes } : g))
      );
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // === Render ===

  if (groups.length === 0) return null;

  const dragHandleH = 6;
  const tabBarH = 33;
  const promptBarH = 85;
  const contentH = height - dragHandleH - tabBarH - promptBarH;

  return (
    <div
      className="flex flex-col bg-[#1a1a2e] border-t border-border"
      style={{ height: `${height}px`, display: isOpen ? undefined : "none" }}
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

      {/* Tab bar */}
      <div className="flex-shrink-0 flex items-center h-[33px] bg-[#1a1a2e] border-b border-border/30 px-2 gap-1">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mr-2 flex-shrink-0">
          Terminal
        </span>

        {/* Tabs */}
        <div className="flex items-center gap-0.5 overflow-x-auto min-w-0 flex-1 scrollbar-none">
          {groups.map((g) => {
            const isActive = g.id === activeGroupId;
            const label =
              g.panes.length > 1
                ? g.panes.map((p) => p.name).join(" | ")
                : g.panes[0]?.name || "Terminal";
            return (
              <button
                key={g.id}
                onClick={() => activatePane(g.id, g.panes[0].id)}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded-sm text-xs whitespace-nowrap transition-colors group max-w-[180px]",
                  isActive
                    ? "bg-[#2a2a4a] text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-[#222244]"
                )}
              >
                <span className="truncate">{label}</span>
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    closeGroup(g.id);
                  }}
                  className="p-0.5 rounded hover:bg-muted/40 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                >
                  <X className="h-3 w-3" />
                </span>
              </button>
            );
          })}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-0.5 flex-shrink-0 ml-1">
          <button
            onClick={addTerminal}
            className="p-1 rounded hover:bg-muted/30 text-muted-foreground hover:text-foreground transition-colors"
            title="New Terminal"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={splitTerminal}
            className="p-1 rounded hover:bg-muted/30 text-muted-foreground hover:text-foreground transition-colors"
            title="Split Terminal"
          >
            <Columns2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className={cn(
              "p-1 rounded hover:bg-muted/30 text-muted-foreground hover:text-foreground transition-colors",
              sidebarOpen && "bg-muted/30 text-foreground"
            )}
            title="Toggle Terminal List"
          >
            <PanelRight className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-muted/30 text-muted-foreground hover:text-foreground transition-colors"
            title="Hide Panel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Content area: terminal panes + optional sidebar */}
      <div className="flex" style={{ height: `${contentH}px` }}>
        {/* Terminal panes — render ALL groups, display only the active one */}
        <div className="flex-1 min-w-0 relative">
          {groups.map((group) => (
            <div
              key={group.id}
              className="absolute inset-0 flex"
              style={{ display: group.id === activeGroupId ? "flex" : "none" }}
            >
              {group.panes.map((pane, idx) => (
                <React.Fragment key={pane.id}>
                  {idx > 0 && (
                    <div
                      className="w-1 flex-shrink-0 cursor-col-resize bg-border/20 hover:bg-primary/40 transition-colors"
                      onMouseDown={(e) => handleSplitDrag(e, group.id, idx - 1)}
                    />
                  )}
                  <div
                    className="h-full min-w-0 overflow-hidden"
                    style={{ flex: group.splitSizes[idx] }}
                    onClick={() => setActivePaneId(pane.id)}
                  >
                    <TerminalInstance
                      terminalId={pane.terminalId}
                      projectPath={projectPath}
                      isVisible={isOpen && group.id === activeGroupId}
                      onTitleChange={(title) => handleTitleChange(pane.id, title)}
                    />
                  </div>
                </React.Fragment>
              ))}
            </div>
          ))}
        </div>

        {/* Sidebar — list of all terminals */}
        {sidebarOpen && (
          <div className="w-44 flex-shrink-0 border-l border-border/30 bg-[#161628] overflow-y-auto">
            <div className="py-1">
              {groups.map((group) =>
                group.panes.map((pane, pIdx) => {
                  const isMulti = group.panes.length > 1;
                  const isLast = pIdx === group.panes.length - 1;
                  return (
                    <SidebarItem
                      key={pane.id}
                      name={pane.name}
                      isActive={pane.id === activePaneId}
                      connector={isMulti ? (isLast ? "\u2514" : "\u251C") : undefined}
                      onClick={() => activatePane(group.id, pane.id)}
                      onClose={() =>
                        isMulti
                          ? closePane(group.id, pane.id)
                          : closeGroup(group.id)
                      }
                    />
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// === Sidebar Item ===

interface SidebarItemProps {
  name: string;
  isActive: boolean;
  connector?: string;
  onClick: () => void;
  onClose: () => void;
}

const SidebarItem: React.FC<SidebarItemProps> = ({
  name,
  isActive,
  connector,
  onClick,
  onClose,
}) => (
  <div
    onClick={onClick}
    className={cn(
      "flex items-center gap-1.5 px-2 py-0.5 text-xs cursor-pointer group transition-colors",
      isActive
        ? "bg-[#2a2a4a] text-foreground"
        : "text-muted-foreground hover:text-foreground hover:bg-[#1e1e38]"
    )}
  >
    {connector && (
      <span className="text-muted-foreground/40 font-mono text-[10px] w-3 flex-shrink-0">
        {connector}
      </span>
    )}
    <TerminalSquare className="h-3 w-3 flex-shrink-0 opacity-70" />
    <span className="truncate flex-1">{name}</span>
    <span
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      className="p-0.5 rounded hover:bg-muted/40 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
    >
      <X className="h-2.5 w-2.5" />
    </span>
  </div>
);
