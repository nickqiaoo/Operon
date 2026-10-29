"use client";

import {
  Attachment as AttachmentRoot,
  AttachmentAction,
  AttachmentActions,
  AttachmentMedia,
} from "@/components/ui/attachment";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { ImageViewer } from "@/components/ai-elements/image-viewer";
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

/**
 * Attachment thumbnails, built on shadcn/ui Attachment
 * (https://ui.shadcn.com/docs/ai-elements/radix/attachment): each file is a
 * small vertical card whose media slot holds the image (opens the viewer), a
 * text excerpt, or the file-type icon, with the remove action in its corner.
 */

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
// Context
// ============================================================================

interface AttachmentContextValue {
  data: AttachmentData;
  mediaCategory: AttachmentMediaCategory;
  onRemove?: () => void;
}

const AttachmentContext = createContext<AttachmentContextValue | null>(null);

const useAttachmentContext = () => {
  const ctx = useContext(AttachmentContext);
  if (!ctx) {
    throw new Error("Attachment components must be used within <Attachment>");
  }
  return ctx;
};

// ============================================================================
// Attachments - Container
// ============================================================================

export type AttachmentsProps = HTMLAttributes<HTMLDivElement>;

/** Wraps onto more rows; sits at the end of the row (the person's side) by default. */
export const Attachments = ({ className, ...props }: AttachmentsProps) => (
  <div
    data-slot="attachments"
    className={cn("ml-auto flex w-fit flex-wrap items-start gap-2", className)}
    {...props}
  />
);

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
  const mediaCategory = getMediaCategory(data);

  const contextValue = useMemo<AttachmentContextValue>(
    () => ({ data, mediaCategory, onRemove }),
    [data, mediaCategory, onRemove]
  );

  return (
    <AttachmentContext.Provider value={contextValue}>
      <AttachmentRoot orientation="vertical" className={cn("w-24", className)} {...props}>
        {children}
      </AttachmentRoot>
    </AttachmentContext.Provider>
  );
};

// ============================================================================
// AttachmentPreview - Media preview
// ============================================================================

export type AttachmentPreviewProps = HTMLAttributes<HTMLDivElement> & {
  fallbackIcon?: ReactNode;
};

const ICONS: Record<AttachmentMediaCategory, typeof ImageIcon> = {
  image: ImageIcon,
  video: VideoIcon,
  audio: Music2Icon,
  source: GlobeIcon,
  document: FileTextIcon,
  unknown: PaperclipIcon,
};

export const AttachmentPreview = ({
  fallbackIcon,
  className,
}: AttachmentPreviewProps) => {
  const { data, mediaCategory } = useAttachmentContext();
  const [imageOpen, setImageOpen] = useState(false);
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

  if (mediaCategory === "image" && mediaSrc) {
    return (
      <AttachmentMedia variant="image" className={className}>
        <Dialog open={imageOpen} onOpenChange={setImageOpen}>
          <DialogTrigger asChild>
            <button
              aria-label={`Preview ${data.filename || "image"}`}
              className="size-full cursor-zoom-in"
              type="button"
            >
              <img
                alt={data.filename || "Image"}
                className="size-full object-cover"
                height={96}
                loading="lazy"
                src={mediaSrc}
                width={96}
              />
            </button>
          </DialogTrigger>
          {imageOpen && <ImageViewer src={mediaSrc} filename={data.filename} />}
        </Dialog>
      </AttachmentMedia>
    );
  }

  if (mediaCategory === "video" && data.type === "file" && mediaSrc) {
    return (
      <AttachmentMedia variant="image" className={className}>
        <video className="size-full object-cover" muted src={mediaSrc} />
      </AttachmentMedia>
    );
  }

  if (mediaCategory === "document" && textPreview) {
    return (
      <AttachmentMedia className={cn("items-start justify-start p-1.5", className)}>
        <div className="size-full overflow-hidden font-mono text-[10px] leading-tight break-words whitespace-pre-wrap text-muted-foreground">
          {textPreview}
        </div>
      </AttachmentMedia>
    );
  }

  const Icon = ICONS[mediaCategory];
  return (
    <AttachmentMedia className={cn("text-muted-foreground", className)}>
      {fallbackIcon ?? <Icon />}
    </AttachmentMedia>
  );
};

// ============================================================================
// AttachmentRemove - Remove button
// ============================================================================

export type AttachmentRemoveProps = ComponentProps<typeof AttachmentAction> & {
  label?: string;
};

export const AttachmentRemove = ({
  label = "Remove",
  className,
  children,
  ...props
}: AttachmentRemoveProps) => {
  const { onRemove } = useAttachmentContext();

  if (!onRemove) {
    return null;
  }

  return (
    <AttachmentActions className="top-2.5 right-2.5">
      <AttachmentAction
        aria-label={label}
        className={cn(
          "rounded-full bg-background/80 opacity-0 backdrop-blur-sm transition-opacity group-hover/attachment:opacity-100 focus-visible:opacity-100 hover:bg-background",
          className
        )}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        {...props}
      >
        {children ?? <XIcon />}
      </AttachmentAction>
    </AttachmentActions>
  );
};
