"use client";

import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockHighlightedContent,
} from "@/components/ui/code-block";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  type TraceStatus,
  TraceTitle,
} from "@/components/ui/trace";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ComponentProps, ReactNode } from "react";
import { Fragment, isValidElement } from "react";
import { classifyToolInput, type ToolInputView } from "@shared/tool-rendering/toolInput";
import { parseAccessibilitySnapshot } from "@shared/tool-rendering/accessibilityTree";
import { AccessibilityTreeOutput } from "./accessibility-tree";

/**
 * Tool, rebuilt on shadcn/ui Trace (https://ui.shadcn.com/docs/ai-elements/radix/tool):
 * a call is one line — icon, name, argument summary — that opens onto its input
 * and output. State reads from the line itself: the name shimmers while the call
 * runs and turns red when it fails, instead of a status icon or badge.
 */

export type ToolPart = ToolUIPart | DynamicToolUIPart;

/** The Trace status a tool state reads as. Approvals sit outside the line. */
export function toolTraceStatus(state: ToolPart["state"]): TraceStatus | undefined {
  switch (state) {
    case "input-streaming":
    case "input-available":
      return "running";
    case "output-error":
      return "error";
    default:
      return undefined;
  }
}

export type ToolProps = Omit<ComponentProps<typeof TraceCollapsible>, "open" | "onOpenChange"> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const Tool = ({ className, open, onOpenChange, ...props }: ToolProps) => {
  const collapsible = open === undefined
    ? <TraceCollapsible data-testid="tool-invocation" className={cn("not-prose", className)} {...props} />
    : (
      <TraceCollapsible
        data-testid="tool-invocation"
        className={cn("not-prose", className)}
        open={open}
        onOpenChange={onOpenChange ?? (() => {})}
        {...props}
      />
    );
  return <Trace>{collapsible}</Trace>;
};

const splitPath = (value: string): [string, string] | null => {
  if (/\s/.test(value)) return null;
  const trimmed = value.length > 1 ? value.replace(/\/+$/, "") : value;
  const slash = trimmed.lastIndexOf("/");
  // Needs a non-empty directory AND basename to be worth splitting.
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return [trimmed.slice(0, slash), trimmed.slice(slash)];
};

/**
 * The argument summary beside a tool name, as the line's TraceDescription. A
 * lone path truncates in the middle — the directory gives way and the basename
 * stays — because the basename is what tells two reads apart;
 * `/Volumes/data/pro…/operon-agents`.
 */
export const ToolDescription = ({ value, className }: { value: string; className?: string }) => {
  const parts = splitPath(value);
  const base = "min-w-0 shrink font-mono text-xs";
  if (!parts) {
    return (
      <TraceDescription title={value} className={cn(base, "truncate", className)}>
        {value}
      </TraceDescription>
    );
  }
  return (
    <TraceDescription title={value} className={cn(base, "flex", className)}>
      <span className="min-w-0 truncate">{parts[0]}</span>
      <span className="max-w-[70%] shrink-0 truncate">{parts[1]}</span>
    </TraceDescription>
  );
};

/** One tool line: what both the collapsible header and a bare (no detail) row render. */
export const ToolLine = ({
  name,
  icon,
  description,
  status,
  trailing,
  className,
}: {
  name: ReactNode;
  icon?: ReactNode;
  description?: string;
  status?: TraceStatus;
  /** After the description, e.g. "Denied". */
  trailing?: ReactNode;
  className?: string;
}) => (
  <TraceLine status={status} className={className}>
    {icon && <TraceIcon>{icon}</TraceIcon>}
    {/* The name identifies the row, so it truncates last: with a description
        beside it the name is unshrinkable and the description absorbs the
        squeeze; `max-w` still caps a provider that passes an entire shell
        command as the tool name, which would otherwise overflow the window. */}
    <TraceTitle
      data-testid="tool-name"
      className={description ? "max-w-[60%] shrink-0" : undefined}
    >
      {name}
    </TraceTitle>
    {description && <ToolDescription value={description} />}
    {trailing}
  </TraceLine>
);

export type ToolHeaderProps = {
  title?: string;
  /** Leading icon; omitted headers start straight with the name. */
  icon?: ReactNode;
  description?: string;
  className?: string;
} & (
    | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
    | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
  );

const normalizeToolName = (name: string) => {
  const withoutPrefix = name.startsWith("tool-") ? name.slice(5) : name;
  return withoutPrefix.replace(/`/g, "").trim();
};

export const ToolHeader = ({
  className,
  title,
  description,
  icon,
  type,
  state,
  toolName,
}: ToolHeaderProps) => {
  const rawName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <TraceCollapsibleTrigger className={className}>
      <ToolLine
        name={title ?? normalizeToolName(rawName)}
        icon={icon}
        description={description}
        status={toolTraceStatus(state)}
        trailing={state === "output-denied" ? <TraceDescription>Denied</TraceDescription> : undefined}
      />
    </TraceCollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof TraceCollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <TraceCollapsibleContent className={cn("space-y-2", className)} {...props} />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("min-w-0", className)} {...props}>
    <ToolInputBody view={classifyToolInput(input)} />
  </div>
);

/** Renders tool arguments by shape — see `classifyToolInput` for the tiers. */
const ToolInputBody = ({ view }: { view: ToolInputView }) => {
  if (view.kind === "empty") {
    return <p className="text-xs text-muted-foreground">No parameters.</p>;
  }

  // A — a lone text blob, rendered as text so its newlines survive.
  if (view.kind === "text") {
    return (
      <CodeBlock size="sm">
        <CodeBlockHighlightedContent code={view.value} language={view.language} wrap className="max-h-64" />
      </CodeBlock>
    );
  }

  // B — flat scalars as a key/value list.
  if (view.kind === "fields") {
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        {view.fields.map((field) =>
          field.multiline ? (
            <Fragment key={field.key}>
              <dt className="col-span-2 font-mono text-muted-foreground">{field.key}</dt>
              <dd className="col-span-2 min-w-0">
                <CodeBlock size="sm">
                  <CodeBlockHighlightedContent
                    code={field.value}
                    language={field.language ?? "markdown"}
                    wrap
                    className="max-h-64"
                  />
                </CodeBlock>
              </dd>
            </Fragment>
          ) : (
            <Fragment key={field.key}>
              <dt className="font-mono text-muted-foreground">{field.key}</dt>
              <dd className="min-w-0 break-words font-mono text-foreground/90">{field.value}</dd>
            </Fragment>
          ),
        )}
      </dl>
    );
  }

  // C — nested structures stay JSON.
  return <JsonBlock value={view.value} />;
};

const JsonBlock = ({ value }: { value: unknown }) => (
  <CodeBlock size="sm">
    <CodeBlockHighlightedContent code={JSON.stringify(value, null, 2)} language="json" className="max-h-64" />
  </CodeBlock>
);

const TextBlock = ({ text, variant }: { text: string; variant?: "destructive" }) => (
  <CodeBlock size="sm" variant={variant}>
    <CodeBlockContent wrap className="max-h-64">{text}</CodeBlockContent>
  </CodeBlock>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export type ToolOutputBlock =
  | { kind: "image"; src: string }
  | { kind: "text"; text: string }
  | { kind: "json"; value: unknown };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeImageSource(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^(?:data:image\/|https?:\/\/|blob:)/iu.test(value) ? value : undefined;
}

function contentBlock(value: unknown): ToolOutputBlock | undefined {
  const record = asRecord(value);
  if (record == null || typeof record.type !== "string") return undefined;
  if (record.type === "text" && typeof record.text === "string") {
    return { kind: "text", text: record.text };
  }
  if (
    record.type === "image"
    && typeof record.data === "string"
    && typeof record.mimeType === "string"
    && record.mimeType.startsWith("image/")
  ) {
    return {
      kind: "image",
      src: `data:${record.mimeType};base64,${record.data}`,
    };
  }
  if (record.type === "image") {
    const src = safeImageSource(record.url ?? record.image_url);
    return src == null ? undefined : { kind: "image", src };
  }
  if (record.type === "input_image") {
    const imageUrl = asRecord(record.image_url)?.url ?? record.image_url;
    const src = safeImageSource(imageUrl);
    return src == null ? undefined : { kind: "image", src };
  }
  if (
    record.type === "resource_link"
    && (
      (typeof record.mimeType === "string" && record.mimeType.startsWith("image/"))
      || record.name === "Emitted image"
    )
  ) {
    const src = safeImageSource(record.uri);
    return src == null ? undefined : { kind: "image", src };
  }
  return undefined;
}

/** Convert MCP/AI SDK image content into renderable blocks without printing base64 JSON. */
export function normalizeToolOutputBlocks(output: unknown): ToolOutputBlock[] | undefined {
  const record = asRecord(output);
  const rawContent = Array.isArray(output)
    ? output
    : Array.isArray(record?.content)
      ? record.content
      : undefined;
  const blocks =
    rawContent == null
      ? []
      : rawContent.map((item) => contentBlock(item) ?? { kind: "json" as const, value: item });
  const hasStructuredContent =
    rawContent != null && rawContent.some((item) => contentBlock(item) != null);

  // Providers that relay an MCP tool (grok over ACP) hand us `{ output, raw }`
  // rather than MCP's `content` array. Without this the envelope fell through to
  // JSON.stringify, which buried a snapshot/log payload in quoted escapes.
  let hasEnvelopeText = false;
  if (rawContent == null && typeof record?.output === "string" && record.output.trim() !== "") {
    blocks.push({ kind: "text", text: record.output });
    hasEnvelopeText = true;
  }

  const meta = asRecord(record?._meta);
  const surface = asRecord(meta?.["codex/toolSurface"]);
  const screenshot = asRecord(surface?.screenshot);
  const screenshotSrc = safeImageSource(screenshot?.url);
  if (screenshotSrc != null && !blocks.some((block) => block.kind === "image" && block.src === screenshotSrc)) {
    blocks.push({ kind: "image", src: screenshotSrc });
  }
  if (hasStructuredContent || screenshotSrc != null || hasEnvelopeText) return blocks;
  return undefined;
}

/**
 * Text output, upgraded to a collapsible tree when it is a Computer Use
 * accessibility snapshot. The parser returns undefined for anything else, so
 * ordinary text still renders as text.
 */
const ToolTextBlock = ({ text }: { text: string }) => {
  const snapshot = parseAccessibilitySnapshot(text);
  if (snapshot) return <AccessibilityTreeOutput snapshot={snapshot} />;
  return <TextBlock text={text} />;
};

const ToolOutputBody = ({ output }: { output: ToolPart["output"] }) => {
  const blocks = normalizeToolOutputBlocks(output);
  if (blocks != null) {
    return (
      <div className="space-y-2">
        {blocks.map((block, index) => {
          if (block.kind === "image") {
            return (
              <img
                alt="Tool output"
                className="h-auto max-w-full rounded-lg bg-muted object-contain"
                key={`${block.src.slice(0, 48)}-${index}`}
                src={block.src}
              />
            );
          }
          if (block.kind === "text") {
            return <ToolTextBlock key={index} text={block.text} />;
          }
          return <JsonBlock key={index} value={block.value} />;
        })}
      </div>
    );
  }
  if (isValidElement(output)) return output;
  // A bare string is a plain tool result (Read, Bash, …). Only MCP content
  // blocks above can carry a Computer Use snapshot; a numbered file listing
  // would otherwise parse as one.
  if (typeof output === "string") return <TextBlock text={output} />;
  if (typeof output === "object") return <JsonBlock value={output} />;
  return <TextBlock text={String(output)} />;
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  return (
    <div className={cn("min-w-0 space-y-2", className)} {...props}>
      {errorText && <TextBlock text={errorText} variant="destructive" />}
      {output ? <ToolOutputBody output={output} /> : null}
    </div>
  );
};
