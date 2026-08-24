"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import { isAttachmentUrl, resolveAttachmentUrl } from "@/lib/attachments";
import { getBaseUrl, getBaseUrlSync } from "@/lib/api-client";
import { useAuthedObjectUrl } from "@/hooks/useAuthedObjectUrl";
import type { FileUIPart, SourceDocumentUIPart } from "ai";
import {
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  Music2Icon,
  PaperclipIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

// ============================================================================
// Types
// ============================================================================

export type AttachmentData =
  | (FileUIPart & { id: string; content?: string })
  | (SourceDocumentUIPart & { id: string });

export type AttachmentMediaCategory =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "source"
  | "unknown";

export type AttachmentVariant = "grid" | "inline" | "list";

// ============================================================================
// Utility Functions
// ============================================================================

export const getMediaCategory = (
  data: AttachmentData
): AttachmentMediaCategory => {
  if (data.type === "source-document") {
    return "source";
  }

  const mediaType = data.mediaType ?? "";

  if (mediaType.startsWith("image/")) {
    return "image";
  }
  if (mediaType.startsWith("video/")) {
    return "video";
  }
  if (mediaType.startsWith("audio/")) {
    return "audio";
  }
  if (mediaType.startsWith("application/") || mediaType.startsWith("text/")) {
    return "document";
  }

  return "unknown";
};

export const getAttachmentLabel = (data: AttachmentData): string => {
  if (data.type === "source-document") {
    return data.title || data.filename || "Source";
  }

  const category = getMediaCategory(data);
  return data.filename || (category === "image" ? "Image" : "Attachment");
};

const getImageAttachmentSrc = (data: AttachmentData): string | null => {
  if (data.type !== "file" || !data.url || !data.mediaType?.startsWith("image/")) {
    return null;
  }

  // Stored attachment: a node-relative path that needs the current base URL.
  // Null while the base URL is still being resolved — the preview falls back to
  // its icon for that one frame rather than requesting a broken src.
  if (isAttachmentUrl(data.url)) {
    return resolveAttachmentUrl(data.url);
  }

  if (
    data.url.startsWith("data:") ||
    data.url.startsWith("blob:") ||
    data.url.startsWith("http://") ||
    data.url.startsWith("https://") ||
    data.url.startsWith("file://")
  ) {
    return data.url;
  }

  return `data:${data.mediaType};base64,${data.url}`;
};

// ============================================================================
// Contexts
// ============================================================================

interface AttachmentsContextValue {
  variant: AttachmentVariant;
}

const AttachmentsContext = createContext<AttachmentsContextValue | null>(null);

interface AttachmentContextValue {
  data: AttachmentData;
  mediaCategory: AttachmentMediaCategory;
  onRemove?: () => void;
  variant: AttachmentVariant;
}

const AttachmentContext = createContext<AttachmentContextValue | null>(null);

// ============================================================================
// Hooks
// ============================================================================

export const useAttachmentsContext = () =>
  useContext(AttachmentsContext) ?? { variant: "grid" as const };

export const useAttachmentContext = () => {
  const ctx = useContext(AttachmentContext);
  if (!ctx) {
    throw new Error("Attachment components must be used within <Attachment>");
  }
  return ctx;
};

// ============================================================================
// Attachments - Container
// ============================================================================

export type AttachmentsProps = HTMLAttributes<HTMLDivElement> & {
  variant?: AttachmentVariant;
};

export const Attachments = ({
  variant = "grid",
  className,
  children,
  ...props
}: AttachmentsProps) => {
  const contextValue = useMemo(() => ({ variant }), [variant]);

  return (
    <AttachmentsContext.Provider value={contextValue}>
      <div
        className={cn(
          "flex items-start",
          variant === "list" ? "flex-col gap-2" : "flex-wrap gap-2",
          variant === "grid" && "ml-auto w-fit",
          className
        )}
        {...props}
      >
        {children}
      </div>
    </AttachmentsContext.Provider>
  );
};

// ============================================================================
// Attachment - Item
// ============================================================================

export type AttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: AttachmentData;
  onRemove?: () => void;
};

export const Attachment = ({
  data,
  onRemove,
  className,
  children,
  ...props
}: AttachmentProps) => {
  const { variant } = useAttachmentsContext();
  const mediaCategory = getMediaCategory(data);

  const contextValue = useMemo<AttachmentContextValue>(
    () => ({ data, mediaCategory, onRemove, variant }),
    [data, mediaCategory, onRemove, variant]
  );

  return (
    <AttachmentContext.Provider value={contextValue}>
      <div
        className={cn(
          "group relative",
          variant === "grid" && "size-24 overflow-hidden rounded-lg",
          variant === "inline" && [
            "flex h-8 cursor-pointer select-none items-center gap-1.5",
            "rounded-md border border-border/60 px-1.5",
            "font-medium text-sm transition-all",
            "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
          ],
          variant === "list" && [
            "flex w-full items-center gap-3 rounded-lg border p-3",
            "hover:bg-accent/50",
          ],
          className
        )}
        {...props}
      >
        {children}
      </div>
    </AttachmentContext.Provider>
  );
};

// ============================================================================
// AttachmentPreview - Media preview
// ============================================================================

export type AttachmentPreviewProps = HTMLAttributes<HTMLDivElement> & {
  fallbackIcon?: ReactNode;
};

export const AttachmentPreview = ({
  fallbackIcon,
  className,
}: AttachmentPreviewProps) => {
  const { data, mediaCategory, variant } = useAttachmentContext();
  const [textPreview, setTextPreview] = useState<string | null>(null);
  // Re-render once the base URL lands, so a stored attachment rendered before
  // the desktop port was known still gets its src.
  const [baseUrlReady, setBaseUrlReady] = useState(() => getBaseUrlSync() !== null);
  const resolvedImageSrc = getImageAttachmentSrc(data);
  // On web a stored attachment is served through the broker, which requires a
  // bearer header that an <img src> cannot carry (it never touches the patched
  // window.fetch, so the request arrives unauthenticated and gets a 401). Those
  // are downloaded and handed to the <img> as a blob: URL instead. Desktop talks
  // to localhost and keeps using the URL directly — its api token rides the
  // query string (resolveAttachmentUrl), which an <img src> can carry.
  const brokerMediaSrc =
    __APP_TARGET__ === "web" && data.type === "file" && isAttachmentUrl(data.url)
      ? resolvedImageSrc
      : null;
  const objectUrl = useAuthedObjectUrl(brokerMediaSrc);
  const mediaSrc = brokerMediaSrc ? objectUrl : resolvedImageSrc;

  useEffect(() => {
    if (baseUrlReady) return;
    let active = true;
    void getBaseUrl()
      .then(() => {
        if (active) setBaseUrlReady(true);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [baseUrlReady]);

  useEffect(() => {
    if (mediaCategory === "document" && data.type === "file") {
      if (typeof data.content === "string") {
        setTextPreview(data.content.slice(0, 200));
      } else if (
        data.url &&
        data.mediaType?.startsWith("text/") &&
        !data.url.startsWith("file:")
      ) {
        fetch(data.url)
          .then((res) => res.text())
          .then((text) => setTextPreview(text.slice(0, 200))) // Limit preview length
          .catch(() => setTextPreview(null));
      }
    }
  }, [data, mediaCategory]);

  const iconSize = variant === "inline" ? "size-3" : "size-4";

  const renderImage = (
    url: string,
    filename: string | undefined,
    isGrid: boolean
  ) =>
    isGrid ? (
      <img
        alt={filename || "Image"}
        className="size-full object-cover"
        height={96}
        loading="lazy"
        src={url}
        width={96}
      />
    ) : (
      <img
        alt={filename || "Image"}
        className="size-full rounded object-cover"
        height={20}
        loading="lazy"
        src={url}
        width={20}
      />
    );

  const renderIcon = (Icon: typeof ImageIcon) => (
    <Icon className={cn(iconSize, "text-muted-foreground")} />
  );

  const renderContent = () => {
    if (mediaCategory === "image" && mediaSrc) {
      return renderImage(mediaSrc, data.filename, variant === "grid");
    }

    if (mediaCategory === "video" && data.type === "file" && mediaSrc) {
      return <video className="size-full object-cover" muted src={mediaSrc} />;
    }

    // Text preview for grid variant
    if (mediaCategory === "document" && textPreview && variant === "grid") {
      return (
        <div className="size-full bg-muted p-2 text-[10px] text-muted-foreground overflow-hidden break-words whitespace-pre-wrap leading-tight font-mono">
          {textPreview}
        </div>
      );
    }

    const iconMap: Record<AttachmentMediaCategory, typeof ImageIcon> = {
      image: ImageIcon,
      video: VideoIcon,
      audio: Music2Icon,
      source: GlobeIcon,
      document: FileTextIcon,
      unknown: PaperclipIcon,
    };

    const Icon = iconMap[mediaCategory];
    return fallbackIcon ?? renderIcon(Icon);
  };

  return (
    mediaCategory === "image" && mediaSrc ? (
      <Dialog>
        <DialogTrigger asChild>
          <button
            className={cn(
              "flex shrink-0 cursor-zoom-in items-center justify-center overflow-hidden transition-transform hover:scale-[1.02]",
              variant === "grid" && "size-full bg-muted",
              variant === "inline" && "size-5 rounded bg-background",
              variant === "list" && "size-12 rounded bg-muted",
              className
            )}
            type="button"
          >
            {renderContent()}
          </button>
        </DialogTrigger>
        <DialogContent
          className="max-w-[min(92vw,1100px)] border-0 bg-transparent p-0 shadow-none"
          overlayClassName="bg-black/72 backdrop-blur-sm"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">
            {data.filename || "Image preview"}
          </DialogTitle>
          <div className="flex items-center justify-center p-2 sm:p-4">
            <img
              alt={data.filename || "Image preview"}
              className="max-h-[88vh] w-auto max-w-full rounded-2xl object-contain"
              src={mediaSrc}
            />
          </div>
        </DialogContent>
      </Dialog>
    ) : (
      <div
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden",
          variant === "grid" && "size-full bg-muted",
          variant === "inline" && "size-5 rounded bg-background",
          variant === "list" && "size-12 rounded bg-muted",
          className
        )}
      >
        {renderContent()}
      </div>
    )
  );
};

// ============================================================================
// AttachmentInfo - Name and type display
// ============================================================================

export type AttachmentInfoProps = HTMLAttributes<HTMLDivElement> & {
  showMediaType?: boolean;
};

export const AttachmentInfo = ({
  showMediaType = false,
  className,
  ...props
}: AttachmentInfoProps) => {
  const { data, variant } = useAttachmentContext();
  const label = getAttachmentLabel(data);

  if (variant === "grid") {
    return null;
  }

  return (
    <div className={cn("min-w-0 flex-1", className)} {...props}>
      <span className="block truncate">{label}</span>
      {showMediaType && data.mediaType && (
        <span className="block truncate text-muted-foreground text-xs">
          {data.mediaType}
        </span>
      )}
    </div>
  );
};

// ============================================================================
// AttachmentRemove - Remove button
// ============================================================================

export type AttachmentRemoveProps = ComponentProps<typeof Button> & {
  label?: string;
};

export const AttachmentRemove = ({
  label = "Remove",
  className,
  children,
  ...props
}: AttachmentRemoveProps) => {
  const { onRemove, variant } = useAttachmentContext();

  if (!onRemove) {
    return null;
  }

  return (
    <Button
      aria-label={label}
      className={cn(
        variant === "grid" && [
          "absolute top-2 right-2 size-6 rounded-full p-0",
          "bg-background/80 backdrop-blur-sm",
          "opacity-0 transition-opacity group-hover:opacity-100",
          "hover:bg-background",
          "[&>svg]:size-3",
        ],
        variant === "inline" && [
          "size-5 rounded p-0",
          "opacity-0 transition-opacity group-hover:opacity-100",
          "[&>svg]:size-2.5",
        ],
        variant === "list" && ["size-8 shrink-0 rounded p-0", "[&>svg]:size-4"],
        className
      )}
      onClick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <XIcon />}
      <span className="sr-only">{label}</span>
    </Button>
  );
};

// ============================================================================
// AttachmentHoverCard - Hover preview
// ============================================================================

export type AttachmentHoverCardProps = ComponentProps<typeof HoverCard>;

export const AttachmentHoverCard = ({
  openDelay = 0,
  closeDelay = 0,
  ...props
}: AttachmentHoverCardProps) => (
  <HoverCard closeDelay={closeDelay} openDelay={openDelay} {...props} />
);

export type AttachmentHoverCardTriggerProps = ComponentProps<
  typeof HoverCardTrigger
>;

export const AttachmentHoverCardTrigger = (
  props: AttachmentHoverCardTriggerProps
) => <HoverCardTrigger {...props} />;

export type AttachmentHoverCardContentProps = ComponentProps<
  typeof HoverCardContent
>;

export const AttachmentHoverCardContent = ({
  align = "start",
  className,
  ...props
}: AttachmentHoverCardContentProps) => (
  <HoverCardContent
    align={align}
    className={cn("w-auto p-2", className)}
    {...props}
  />
);

// ============================================================================
// AttachmentEmpty - Empty state
// ============================================================================

export type AttachmentEmptyProps = HTMLAttributes<HTMLDivElement>;

export const AttachmentEmpty = ({
  className,
  children,
  ...props
}: AttachmentEmptyProps) => (
  <div
    className={cn(
      "flex items-center justify-center p-4 text-muted-foreground text-sm",
      className
    )}
    {...props}
  >
    {children ?? "No attachments"}
  </div>
);
