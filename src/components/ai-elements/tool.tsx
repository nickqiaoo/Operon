"use client";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
  AlertCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Fragment, isValidElement } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CodeBlock } from "./code-block";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { classifyToolInput, type ToolInputView } from "@shared/tool-rendering/toolInput";
import { parseAccessibilitySnapshot } from "@shared/tool-rendering/accessibilityTree";
import { AccessibilityTreeOutput } from "./accessibility-tree";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    data-testid="tool-invocation"
    className={cn("group not-prose mb-2 w-full rounded-xl border border-border/40", className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
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

export const getStatusBadge = (status: ToolPart["state"]) => {
  const labels: Record<ToolPart["state"], string> = {
    "input-streaming": "Pending",
    "input-available": "Running",
    "approval-requested": "Awaiting Approval",
    "approval-responded": "Responded",
    "output-available": "Completed",
    "output-error": "Error",
    "output-denied": "Denied",
  };

  const icons: Record<ToolPart["state"], ReactNode> = {
    "input-streaming": <CircleIcon className="size-4" />,
    "input-available": <ClockIcon className="size-4 animate-pulse" />,
    "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
    "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
    "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
    "output-error": <XCircleIcon className="size-4 text-red-600" />,
    "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  };

  return (
    <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
      {icons[status]}
      {labels[status]}
    </Badge>
  );
};

export const ToolHeader = ({
  className,
  title,
  description,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const normalizeToolName = (name: string) => {
    const withoutPrefix = name.startsWith("tool-") ? name.slice(5) : name;
    return withoutPrefix.replace(/`/g, "").trim();
  };
  const rawName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");
  const derivedName = normalizeToolName(rawName);

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between gap-4 p-3",
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2">
        <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
        {/* Truncates last, like CompactToolCall's: the description absorbs the
            shrinkage so a short name stays whole. `max-w` still caps the case
            where a provider passes an entire shell command as the tool name,
            which unshrinkable would overflow the window. */}
        <span
          data-testid="tool-name"
          className={cn(
            "truncate font-medium text-sm",
            description ? "shrink-0 max-w-[60%]" : "min-w-0"
          )}
        >
          {title ?? derivedName}
        </span>
        {description && (
          <code className="min-w-0 truncate text-xs text-muted-foreground font-mono">
            {description}
          </code>
        )}
        <div className="shrink-0">{getStatusBadge(state)}</div>
      </div>
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  // The <h4> is kept even when a caller hides it via `[&_h4]:hidden`.
  <div className={cn("space-y-2 overflow-hidden p-4", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
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
      <div className="rounded-xl bg-muted/50">
        <CodeBlock code={view.value} language={view.language} />
      </div>
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
              <dd className="col-span-2 min-w-0 overflow-hidden rounded-lg bg-muted/50">
                <CodeBlock code={field.value} language={field.language ?? "markdown"} />
              </dd>
            </Fragment>
          ) : (
            <Fragment key={field.key}>
              <dt className="font-mono text-muted-foreground">{field.key}</dt>
              <dd className="min-w-0 break-words font-mono">{field.value}</dd>
            </Fragment>
          ),
        )}
      </dl>
    );
  }

  // C — nested structures stay JSON.
  return (
    <div className="rounded-xl bg-muted/50">
      <CodeBlock code={JSON.stringify(view.value, null, 2)} language="json" />
    </div>
  );
};

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
  return <CodeBlock code={text} language="markdown" />;
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

  const blocks = normalizeToolOutputBlocks(output);
  let Output = blocks == null
    ? <div>{output as ReactNode}</div>
    : (
      <div className="space-y-3 p-2">
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
          return <CodeBlock code={JSON.stringify(block.value, null, 2)} key={index} language="json" />;
        })}
      </div>
    );

  if (blocks == null && typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (blocks == null && typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  }

  return (
    <div className={cn("space-y-2 p-4", className)} {...props}>
      {errorText ? (
        <Alert variant="destructive">
          <AlertCircleIcon className="size-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            {errorText}
            {output ? <div className="mt-2 text-foreground/90">{Output}</div> : null}
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Result
          </h4>
          <ScrollArea
            className={cn(
              "max-h-80 overflow-hidden rounded-xl bg-muted/50 text-xs text-foreground",
              "[&>[data-slot=scroll-area-viewport]]:max-h-80",
              "[&>[data-slot=scroll-area-viewport]>div]:!block",
              "[&>[data-slot=scroll-area-viewport]>div]:!w-full",
              "[&>[data-slot=scroll-area-viewport]>div]:min-w-0",
              "[&_table]:w-full"
            )}
          >
            <div className="w-full min-w-0">{Output}</div>
          </ScrollArea>
        </>
      )}
    </div>
  );
};
