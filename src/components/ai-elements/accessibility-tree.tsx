"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { countAxNodes, type AxNode, type AxSnapshot } from "@shared/tool-rendering/accessibilityTree";

/** Nodes at or below this depth start expanded; deeper containers stay folded. */
const DEFAULT_OPEN_DEPTH = 2;

export type AccessibilityTreeOutputProps = {
  snapshot: AxSnapshot;
  className?: string;
};

/**
 * Renders a Computer Use accessibility snapshot as a collapsible tree.
 *
 * The element index is the payload here — it is what the next tool call passes
 * as `element_index` — so it gets its own fixed, tabular column rather than
 * being buried mid-line.
 */
export const AccessibilityTreeOutput = ({ snapshot, className }: AccessibilityTreeOutputProps) => {
  // Remounting via `key` resets every row's local open state in one go.
  const [expansion, setExpansion] = useState<{ version: number; openAll: boolean | null }>({
    version: 0,
    openAll: null,
  });

  const setAll = (openAll: boolean) =>
    setExpansion((prev) => ({ version: prev.version + 1, openAll }));

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {snapshot.header.map((line) => (
          <span key={line} className="font-mono text-[11px] text-muted-foreground">
            {line}
          </span>
        ))}
        <span className="text-[11px] text-muted-foreground/70">{snapshot.nodeCount} nodes</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setAll(true)}
          >
            Expand all
          </button>
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setAll(false)}
          >
            Collapse all
          </button>
        </div>
      </div>

      {/* No max-height here: ToolOutput already wraps this in a bounded
          ScrollArea, and nesting a second scroller inside it traps the wheel. */}
      <div
        key={expansion.version}
        className="rounded-lg border border-border/40 bg-muted/30 p-1.5"
      >
        {snapshot.roots.map((node) => (
          <AxRow key={node.index} node={node} depth={0} openAll={expansion.openAll} />
        ))}
      </div>
    </div>
  );
};

const AxRow = ({
  node,
  depth,
  openAll,
}: {
  node: AxNode;
  depth: number;
  openAll: boolean | null;
}) => {
  const hasChildren = node.children.length > 0;
  const [open, setOpen] = useState(openAll ?? depth < DEFAULT_OPEN_DEPTH);

  return (
    <div>
      <div
        className={cn(
          "flex items-start gap-1.5 rounded px-1 py-0.5 text-xs",
          hasChildren && "cursor-pointer hover:bg-muted/60",
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={hasChildren ? () => setOpen((v) => !v) : undefined}
      >
        {hasChildren ? (
          <ChevronRightIcon
            className={cn(
              "mt-[3px] size-3 shrink-0 text-muted-foreground/60 transition-transform",
              open && "rotate-90",
            )}
          />
        ) : (
          <span className="size-3 shrink-0" />
        )}

        <span className="shrink-0 font-mono tabular-nums text-muted-foreground/70">
          {node.index}
        </span>
        <span className="shrink-0 font-mono text-muted-foreground">{node.role}</span>
        {node.label && <span className="min-w-0 break-words">{node.label}</span>}
        {hasChildren && !open && (
          <span className="ml-auto shrink-0 pl-2 text-[10px] text-muted-foreground/60">
            {countAxNodes(node) - 1}
          </span>
        )}
      </div>

      {hasChildren && open && (
        <div>
          {node.children.map((child) => (
            <AxRow key={child.index} node={child} depth={depth + 1} openAll={openAll} />
          ))}
        </div>
      )}
    </div>
  );
};
