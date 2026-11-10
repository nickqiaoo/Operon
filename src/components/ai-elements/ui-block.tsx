import { Component, Fragment, useMemo, type CSSProperties, type ReactNode } from "react";
import {
  ArrowDownIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  CircleIcon,
  CloudIcon,
  CodeIcon,
  CpuIcon,
  DatabaseIcon,
  FileTextIcon,
  GitBranchIcon,
  GlobeIcon,
  LayoutPanelTopIcon,
  LockIcon,
  MessageSquareIcon,
  MinusIcon,
  PackageIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  ShieldIcon,
  TerminalIcon,
  UserIcon,
  WorkflowIcon,
  XCircleIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import type { CustomRenderer, CustomRendererProps } from "streamdown";
import { formatUiNumber, validateUi, type UiElement, type UiIconName } from "@/lib/ui-block/catalog";
import { layoutFlow, type FlowLayoutNode } from "@/lib/ui-block/flow-layout";
import { parseUi } from "@/lib/ui-block/parse";
import { cn } from "@/lib/utils";

/**
 * A ```ui block in a reply: small charts and flows that appear part by part as
 * the text streams. Nothing the model wrote runs. It is parsed into plain data
 * and drawn with the components below, so no iframe is needed.
 *
 * Fixed sizes throughout: what is already on screen must not shift when the
 * next piece arrives.
 */

const SURFACE = "rounded-xl border border-border/50 dark:border-border/35";

const SourceFallback = ({ source }: { source: string }) => (
  <pre className={cn(SURFACE, "my-2 overflow-x-auto p-3 font-mono text-xs text-muted-foreground")}>{source}</pre>
);

class UiBlockBoundary extends Component<{ source: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previous: { source: string }) {
    if (this.state.failed && previous.source !== this.props.source) this.setState({ failed: false });
  }

  render() {
    return this.state.failed ? <SourceFallback source={this.props.source} /> : this.props.children;
  }
}

type ElementOf<T extends UiElement["type"]> = Extract<UiElement, { type: T }>;

function Metric({ element }: { element: ElementOf<"metric"> }) {
  const { label, value, hint } = element.props;
  return (
    <div className={cn(SURFACE, "min-w-0 p-3")}>
      <div className="truncate text-xs text-muted-foreground" title={label}>{label}</div>
      <div className="mt-1 truncate text-lg font-semibold tabular-nums" title={value}>{value}</div>
      {hint && <div className="mt-0.5 truncate text-xs text-muted-foreground" title={hint}>{hint}</div>}
    </div>
  );
}

const BlockTitle = ({ title }: { title?: string }) =>
  title ? <div className="mb-3 truncate text-sm font-semibold" title={title}>{title}</div> : null;

function BarChart({ element }: { element: ElementOf<"bar-chart"> }) {
  const { title, unit = "" } = element.props;
  const bars = element.children.filter((child): child is ElementOf<"bar"> => child.type === "bar");
  // A missing max is the model's slip: bars then rescale as taller ones arrive.
  const max = element.props.max ?? Math.max(1, ...bars.map((bar) => bar.props.value));
  // A word needs a space ("85 orders"); a symbol or short unit does not ("42ms").
  const suffix = unit.length > 2 ? ` ${unit}` : unit;
  // One row per bar, in fixed columns: a new bar only adds a line below, and a
  // chart of three fills the width just as one of twenty does.
  return (
    <div className={cn(SURFACE, "p-4")}>
      <BlockTitle title={title} />
      <div className="flex flex-col gap-2">
        {bars.map((bar) => (
          <div key={bar.key} className="flex items-center gap-3">
            <div className="line-clamp-2 w-28 flex-none text-xs break-words text-muted-foreground" title={bar.props.label}>
              {bar.props.label}
            </div>
            <div className="h-5 min-w-0 flex-1 overflow-hidden rounded bg-muted/40">
              <div className="h-full rounded bg-chart-1" style={{ width: `${Math.min(bar.props.value / max, 1) * 100}%` }} />
            </div>
            <div className="w-20 flex-none truncate text-right text-xs tabular-nums text-muted-foreground">
              {formatUiNumber(bar.props.value)}{suffix}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const NODE_WIDTH = 148;
const NODE_HEIGHT = 40;
const COLUMN_GAP = 24;
const LAYER_GAP = 32;

// Layers run downward, the way the reply grows: a long flow stays in view as it
// is written instead of being drawn past the right edge.
const nodeTop = (layer: number) => layer * (NODE_HEIGHT + LAYER_GAP);

function Flow({ element }: { element: ElementOf<"flow"> }) {
  const layout = layoutFlow(element.children);
  const width = Math.max(0, layout.rows * (NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP);
  const height = Math.max(0, layout.layers * (NODE_HEIGHT + LAYER_GAP) - LAYER_GAP);
  // Each layer is centered on the box's midline, and the box on the card's. A
  // wider layer below therefore moves nothing above it; only a node's own
  // siblings shift it, when one arrives beside it.
  const nodeLeft = (node: FlowLayoutNode) =>
    width / 2 + (node.row - (layout.layerSizes[node.layer] - 1) / 2) * (NODE_WIDTH + COLUMN_GAP) - NODE_WIDTH / 2;
  return (
    <div className={cn(SURFACE, "p-4")}>
      <BlockTitle title={element.props.title} />
      <div className="overflow-x-auto">
        <div className="relative mx-auto" style={{ width, height }}>
          <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden>
            {layout.edges.map(({ from, to }) => {
              const x1 = nodeLeft(from) + NODE_WIDTH / 2;
              const y1 = nodeTop(from.layer) + NODE_HEIGHT;
              const x2 = nodeLeft(to) + NODE_WIDTH / 2;
              const y2 = nodeTop(to.layer) - 2;
              const bend = Math.max(12, Math.abs(y2 - y1) / 2);
              return (
                <path
                  key={`${from.key}-${to.key}`}
                  className="fill-none stroke-muted-foreground"
                  strokeWidth={1.25}
                  d={`M${x1} ${y1}C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}M${x2 - 4} ${y2 - 6}L${x2} ${y2}L${x2 + 4} ${y2 - 6}`}
                />
              );
            })}
          </svg>
          {layout.nodes.map((node) => (
            <div
              key={node.key}
              className="absolute flex items-center justify-center rounded-lg border border-border/60 bg-background px-2 text-xs font-medium dark:border-border/35"
              style={{ left: nodeLeft(node), top: nodeTop(node.layer), width: NODE_WIDTH, height: NODE_HEIGHT }}
            >
              <span className="truncate" title={node.label}>{node.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const MAX_COLUMNS = 4;

function childrenOfType<T extends UiElement["type"]>(element: UiElement, type: T): ElementOf<T>[] {
  return element.children.filter((child): child is ElementOf<T> => child.type === type);
}

/**
 * Equal columns across the full width. `columns` is stated up front so the first
 * item already has its final width; without it the count so far is the best
 * guess, and items narrow as more arrive.
 */
function ColumnGrid({
  columns,
  count,
  narrowColumns,
  children,
}: {
  columns?: number;
  count: number;
  narrowColumns: number;
  children: ReactNode;
}) {
  const resolved = columns ?? Math.min(Math.max(count, 1), MAX_COLUMNS);
  return (
    <div
      className="grid grid-cols-[repeat(var(--ui-cols),minmax(0,1fr))] gap-3 @max-md:grid-cols-[repeat(var(--ui-cols-narrow),minmax(0,1fr))]"
      style={{ "--ui-cols": resolved, "--ui-cols-narrow": Math.min(resolved, narrowColumns) } as CSSProperties}
    >
      {children}
    </div>
  );
}

const Row = ({ element }: { element: ElementOf<"row"> }) => (
  <ColumnGrid columns={element.props.columns} count={element.children.length} narrowColumns={2}>
    {element.children.map(renderElement)}
  </ColumnGrid>
);

const STAGE_ICONS: Record<UiIconName, LucideIcon> = {
  cloud: CloudIcon,
  code: CodeIcon,
  cpu: CpuIcon,
  database: DatabaseIcon,
  file: FileTextIcon,
  git: GitBranchIcon,
  globe: GlobeIcon,
  layout: LayoutPanelTopIcon,
  lock: LockIcon,
  message: MessageSquareIcon,
  package: PackageIcon,
  search: SearchIcon,
  server: ServerIcon,
  shield: ShieldIcon,
  terminal: TerminalIcon,
  user: UserIcon,
  workflow: WorkflowIcon,
  zap: ZapIcon,
};

function Stage({ element }: { element: ElementOf<"stage"> }) {
  const { title, desc, tags, icon } = element.props;
  const Icon = icon && STAGE_ICONS[icon];
  return (
    <div className="flex min-w-0 flex-col items-center gap-1 text-center">
      {Icon && <Icon className="mb-1 h-4 w-4 text-muted-foreground" aria-hidden />}
      <div className="text-sm font-semibold break-words">{title}</div>
      {desc && <div className="text-xs break-words text-muted-foreground">{desc}</div>}
      {tags && tags.length > 0 && (
        <div className="mt-1 flex flex-wrap justify-center gap-1.5">
          {tags.map((tag, index) => (
            <span key={index} className="rounded-full bg-muted px-2 py-0.5 text-xs">{tag}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function StageGroup({ element }: { element: ElementOf<"group"> }) {
  const { title, columns, note } = element.props;
  const stages = childrenOfType(element, "stage");
  return (
    <div className="w-full rounded-lg border border-border/40 p-4 dark:border-border/35">
      {title && <div className="mb-3 text-center text-sm font-semibold break-words">{title}</div>}
      <ColumnGrid columns={columns} count={stages.length} narrowColumns={1}>
        {stages.map((stage) => <Stage key={stage.key} element={stage} />)}
      </ColumnGrid>
      {note && <div className="mt-3 text-center text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}

function Stages({ element }: { element: ElementOf<"stages"> }) {
  return (
    <div className={cn(SURFACE, "p-4")}>
      <BlockTitle title={element.props.title} />
      <div className="flex flex-col items-center gap-2">
        {element.children.map((child, index) => (
          <Fragment key={child.key}>
            {index > 0 && <ArrowDownIcon className="h-4 w-4 flex-none text-muted-foreground" aria-hidden />}
            {child.type === "stage" && <Stage element={child} />}
            {child.type === "group" && <StageGroup element={child} />}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function CompareOption({ element }: { element: ElementOf<"option"> }) {
  const { title, summary, badge } = element.props;
  return (
    <div className={cn(SURFACE, "min-w-0 p-3")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 text-sm font-semibold break-words">{title}</div>
        {badge && <span className="flex-none rounded bg-status-ok/10 px-1.5 py-0.5 text-xs text-status-ok">{badge}</span>}
      </div>
      {summary && <div className="mt-1 text-xs break-words text-muted-foreground">{summary}</div>}
      {element.children.length > 0 && (
        <ul className="mt-2 flex list-none flex-col gap-1.5 p-0">
          {element.children.map((child) =>
            child.type === "pro" || child.type === "con" ? (
              <li key={child.key} className="m-0 flex gap-1.5 text-xs break-words">
                {child.type === "pro"
                  ? <PlusIcon className="mt-px h-3.5 w-3.5 flex-none text-status-ok" aria-hidden />
                  : <MinusIcon className="mt-px h-3.5 w-3.5 flex-none text-status-error" aria-hidden />}
                <span className="min-w-0">{child.props.text}</span>
              </li>
            ) : null,
          )}
        </ul>
      )}
    </div>
  );
}

function Compare({ element }: { element: ElementOf<"compare"> }) {
  const options = childrenOfType(element, "option");
  return (
    <div>
      <BlockTitle title={element.props.title} />
      <ColumnGrid columns={element.props.columns} count={options.length} narrowColumns={1}>
        {options.map((option) => <CompareOption key={option.key} element={option} />)}
      </ColumnGrid>
    </div>
  );
}

const STEP_MARKERS: Record<NonNullable<ElementOf<"step">["props"]["status"]>, { icon: LucideIcon; className: string }> = {
  done: { icon: CheckCircle2Icon, className: "text-status-ok" },
  active: { icon: CircleDotIcon, className: "text-status-info" },
  pending: { icon: CircleIcon, className: "text-muted-foreground" },
  failed: { icon: XCircleIcon, className: "text-status-error" },
};

function Timeline({ element }: { element: ElementOf<"timeline"> }) {
  const steps = childrenOfType(element, "step");
  return (
    <div className={cn(SURFACE, "p-4")}>
      <BlockTitle title={element.props.title} />
      <div className="flex flex-col">
        {steps.map((step, index) => {
          const { icon: Marker, className } = STEP_MARKERS[step.props.status ?? "pending"];
          return (
            <div key={step.key} className="relative flex gap-3 pb-4 last:pb-0">
              {index < steps.length - 1 && <div className="absolute top-5 bottom-0 left-[7px] w-px bg-border/60" />}
              <Marker className={cn("mt-0.5 h-4 w-4 flex-none", className)} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0 text-sm font-medium break-words">{step.props.title}</div>
                  {step.props.time && <div className="flex-none text-xs tabular-nums text-muted-foreground">{step.props.time}</div>}
                </div>
                {step.props.desc && <div className="mt-0.5 text-xs break-words text-muted-foreground">{step.props.desc}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** With more points than this, only every nth x label is drawn. */
const MAX_X_LABELS = 8;
const MAX_POINT_VALUES = 12;

function LineChart({ element }: { element: ElementOf<"line-chart"> }) {
  const { title, unit = "" } = element.props;
  const points = childrenOfType(element, "point");
  const values = points.map((point) => point.props.value);
  // A missing bound or count is the model's slip: the line then rescales as points arrive.
  const min = element.props.min ?? Math.min(0, ...values);
  const stated = element.props.max ?? Math.max(...values, min + 1);
  const max = stated > min ? stated : min + 1;
  const slots = Math.max(element.props.points ?? points.length, points.length, 2);
  const labelEvery = Math.ceil(slots / MAX_X_LABELS);
  const showValues = slots <= MAX_POINT_VALUES;
  const suffix = unit.length > 2 ? ` ${unit}` : unit;

  const xOf = (index: number) => (index / (slots - 1)) * 100;
  const yOf = (value: number) => (1 - (Math.min(Math.max(value, min), max) - min) / (max - min)) * 100;

  return (
    <div className={cn(SURFACE, "p-4")}>
      <BlockTitle title={title} />
      <div className="mx-6 pt-5">
        <div className="relative h-36">
          {[0, 50, 100].map((top) => (
            <div key={top} className="absolute inset-x-0 h-px bg-border/40" style={{ top: `${top}%` }} />
          ))}
          <svg className="absolute inset-0 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <polyline
              className="fill-none stroke-chart-1"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              points={points.map((point, index) => `${xOf(index)},${yOf(point.props.value)}`).join(" ")}
            />
          </svg>
          {points.map((point, index) => (
            <div
              key={point.key}
              className="absolute"
              style={{ left: `${xOf(index)}%`, top: `${yOf(point.props.value)}%` }}
              title={`${point.props.label}: ${formatUiNumber(point.props.value)}${suffix}`}
            >
              <div className="absolute -top-1 -left-1 size-2 rounded-full bg-chart-1" />
              {(showValues || index === points.length - 1) && (
                <div className="absolute bottom-1.5 left-0 -translate-x-1/2 text-xs whitespace-nowrap tabular-nums text-muted-foreground">
                  {formatUiNumber(point.props.value)}{suffix}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="relative mt-1 h-4">
          {points.map((point, index) =>
            index % labelEvery === 0 ? (
              <div
                key={point.key}
                className="absolute max-w-20 -translate-x-1/2 truncate text-xs text-muted-foreground"
                style={{ left: `${xOf(index)}%` }}
                title={point.props.label}
              >
                {point.props.label}
              </div>
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}

function renderElement(element: UiElement): ReactNode {
  switch (element.type) {
    case "stack":
      return <div key={element.key} className="flex flex-col gap-3">{element.children.map(renderElement)}</div>;
    case "row":
      return <Row key={element.key} element={element} />;
    case "metric":
      return <Metric key={element.key} element={element} />;
    case "bar-chart":
      return <BarChart key={element.key} element={element} />;
    case "flow":
      return <Flow key={element.key} element={element} />;
    case "stages":
      return <Stages key={element.key} element={element} />;
    case "compare":
      return <Compare key={element.key} element={element} />;
    case "timeline":
      return <Timeline key={element.key} element={element} />;
    case "line-chart":
      return <LineChart key={element.key} element={element} />;
    default:
      // The remaining tags are drawn by their parents.
      return null;
  }
}

export function UiBlock({ code }: CustomRendererProps) {
  const { elements, diagnostics, pending } = useMemo(() => {
    const parsed = parseUi(code);
    return { ...validateUi(parsed.nodes), pending: parsed.pending };
  }, [code]);

  if (elements.length === 0) return pending || !code.trim() ? null : <SourceFallback source={code} />;
  return (
    <UiBlockBoundary source={code}>
      <div className="@container my-2 flex w-full flex-col gap-3" data-ui-block data-ui-dropped={diagnostics.length}>
        {elements.map(renderElement)}
      </div>
    </UiBlockBoundary>
  );
}

export const UI_BLOCK_RENDERERS: CustomRenderer[] = [{ language: "ui", component: UiBlock }];
