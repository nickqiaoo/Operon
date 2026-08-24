"use client";

import { InputGroup } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
import { persistBlobUrl } from "@/lib/attachments";
import type { FileUIPart, SourceDocumentUIPart } from "ai";
import { nanoid } from "nanoid";
import {
  type ChangeEventHandler,
  type FormEvent,
  type FormEventHandler,
  type HTMLAttributes,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type AttachmentInput,
  type AttachmentsContext,
  LocalAttachmentsContext,
  LocalReferencedSourcesContext,
  PromptInputSubmittingContext,
  type ReferencedSourcesContext,
  useOptionalPromptInputController,
} from "./prompt-input-context";

// Re-export everything from sub-modules for backwards compatibility
export * from "./prompt-input-context";
export * from "./prompt-input-parts";

// ============================================================================
// Helpers
// ============================================================================

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml", ".html", ".css",
  ".js", ".ts", ".jsx", ".tsx", ".py", ".java", ".go", ".rs", ".c", ".cpp",
  ".h", ".sh", ".sql", ".log", ".env", ".toml", ".ini", ".cfg",
]);

function isTextFile(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  if (file.type === "application/json" || file.type === "application/xml") return true;
  const ext = file.name.includes(".") ? "." + file.name.split(".").pop()!.toLowerCase() : "";
  return TEXT_EXTENSIONS.has(ext);
}

// ============================================================================
// PromptInput
// ============================================================================

export interface PromptInputMessage {
  text: string;
  files: (FileUIPart & { content?: string; asText?: boolean })[];
}

export type PromptInputProps = Omit<
  HTMLAttributes<HTMLFormElement>,
  "onSubmit" | "onError"
> & {
  accept?: string;
  multiple?: boolean;
  globalDrop?: boolean;
  syncHiddenInput?: boolean;
  maxFiles?: number;
  maxFileSize?: number;
  onError?: (err: {
    code: "max_files" | "max_file_size" | "accept";
    message: string;
  }) => void;
  onSubmit: (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>
  ) => void | Promise<void>;
};

export const PromptInput = ({
  className,
  accept,
  multiple,
  globalDrop,
  syncHiddenInput,
  maxFiles,
  maxFileSize,
  onError,
  onSubmit,
  children,
  ...props
}: PromptInputProps) => {
  const controller = useOptionalPromptInputController();
  const usingProvider = !!controller;

  const inputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  const [items, setItems] = useState<(FileUIPart & { id: string })[]>([]);
  const files = usingProvider ? controller.attachments.files : items;

  const [referencedSources, setReferencedSources] = useState<
    (SourceDocumentUIPart & { id: string })[]
  >([]);

  const filesRef = useRef(files);
  filesRef.current = files;

  const [submitting, setSubmitting] = useState(false);
  // Ref as well as state: two clicks in the same frame both read the stale
  // `false` from state, so the guard has to be synchronous.
  const submittingRef = useRef(false);

  const openFileDialogLocal = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const matchesAccept = useCallback(
    (f: File) => {
      if (!accept || accept.trim() === "") return true;
      const patterns = accept.split(",").map((s) => s.trim()).filter(Boolean);
      return patterns.some((pattern) => {
        if (pattern.startsWith(".")) return f.name.toLowerCase().endsWith(pattern.toLowerCase());
        if (pattern.endsWith("/*")) return f.type.startsWith(pattern.slice(0, -1));
        return f.type === pattern;
      });
    },
    [accept]
  );

  const validateFiles = useCallback(
    (incoming: Array<File | AttachmentInput>, currentCount: number) => {
      const filesOnly = incoming.filter((f): f is File => f instanceof File);
      const others = incoming.filter((f) => !(f instanceof File));

      const acceptedFiles = filesOnly.filter((f) => matchesAccept(f));
      if (filesOnly.length && acceptedFiles.length === 0) {
        onError?.({ code: "accept", message: "No files match the accepted types." });
        return null;
      }

      const withinSize = (f: File) => maxFileSize ? f.size <= maxFileSize : true;
      const sizedFiles = acceptedFiles.filter(withinSize);
      if (acceptedFiles.length > 0 && sizedFiles.length === 0) {
        onError?.({ code: "max_file_size", message: "All files exceed the maximum size." });
        return null;
      }

      const allValid = [...sizedFiles, ...others];
      const capped = typeof maxFiles === "number"
        ? allValid.slice(0, Math.max(0, maxFiles - currentCount))
        : allValid;

      if (typeof maxFiles === "number" && allValid.length > capped.length) {
        onError?.({ code: "max_files", message: "Too many files. Some were not added." });
      }

      return capped;
    },
    [matchesAccept, maxFileSize, maxFiles, onError]
  );

  const readTextContent = useCallback((file: File): Promise<string | undefined> => {
    if (!isTextFile(file)) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(undefined);
      reader.readAsText(file);
    });
  }, []);

  const processFiles = useCallback(
    async (capped: Array<File | AttachmentInput>): Promise<AttachmentInput[]> =>
      Promise.all(
        capped.map(async (file): Promise<AttachmentInput> => {
          if (file instanceof File) {
            const content = await readTextContent(file);
            return {
              url: URL.createObjectURL(file),
              name: file.name,
              type: file.type || (content != null ? "text/plain" : "application/octet-stream"),
              ...(content != null ? { content, asText: true } : {}),
            };
          }
          return file;
        })
      ),
    [readTextContent]
  );

  const addLocal = useCallback(
    async (files: AttachmentInput[] | FileList) => {
      const capped = validateFiles(Array.from(files), items.length);
      if (!capped || capped.length === 0) return;

      const processed = await processFiles(capped);
      setItems((prev) =>
        prev.concat(
          processed.map((file) =>
            file instanceof File
              ? { id: nanoid(), type: "file" as const, url: URL.createObjectURL(file), mediaType: file.type, filename: file.name }
              : { id: file.id || nanoid(), type: "file" as const, url: file.url, mediaType: file.type, filename: file.name, content: file.content, asText: file.asText }
          )
        )
      );
    },
    [validateFiles, processFiles, items.length]
  );

  const removeLocal = useCallback(
    (id: string) =>
      setItems((prev) => {
        const found = prev.find((file) => file.id === id);
        if (found?.url) URL.revokeObjectURL(found.url);
        return prev.filter((file) => file.id !== id);
      }),
    []
  );

  const addWithProviderValidation = useCallback(
    async (files: AttachmentInput[] | FileList) => {
      const currentCount = controller?.attachments.files.length ?? 0;
      const capped = validateFiles(Array.from(files), currentCount);
      if (!capped || capped.length === 0) return;

      const processed = await processFiles(capped);
      controller?.attachments.add(processed);
    },
    [validateFiles, processFiles, controller]
  );

  const clearAttachments = useCallback(
    () =>
      usingProvider
        ? controller?.attachments.clear()
        : setItems((prev) => {
            for (const file of prev) {
              if (file.url) URL.revokeObjectURL(file.url);
            }
            return [];
          }),
    [usingProvider, controller]
  );

  const clearReferencedSources = useCallback(() => setReferencedSources([]), []);

  const add = usingProvider ? addWithProviderValidation : addLocal;
  const remove = usingProvider ? controller.attachments.remove : removeLocal;
  const openFileDialog = usingProvider
    ? controller.attachments.openFileDialog
    : openFileDialogLocal;

  const clear = useCallback(() => {
    clearAttachments();
    clearReferencedSources();
  }, [clearAttachments, clearReferencedSources]);

  useEffect(() => {
    if (!usingProvider) return;
    controller.__registerFileInput(inputRef, () => inputRef.current?.click());
  }, [usingProvider, controller]);

  useEffect(() => {
    if (syncHiddenInput && inputRef.current && files.length === 0) {
      inputRef.current.value = "";
    }
  }, [files, syncHiddenInput]);

  // Drag-drop handlers
  useEffect(() => {
    const target = globalDrop ? document : formRef.current;
    if (!target) return;

    const onDragOver = (e: Event) => {
      const de = e as DragEvent;
      if (de.dataTransfer?.types?.includes("Files")) de.preventDefault();
    };
    const onDrop = (e: Event) => {
      const de = e as DragEvent;
      if (de.dataTransfer?.types?.includes("Files")) de.preventDefault();
      if (de.dataTransfer?.files && de.dataTransfer.files.length > 0) {
        add(de.dataTransfer.files);
      }
    };
    target.addEventListener("dragover", onDragOver);
    target.addEventListener("drop", onDrop);
    return () => {
      target.removeEventListener("dragover", onDragOver);
      target.removeEventListener("drop", onDrop);
    };
  }, [add, globalDrop]);

  useEffect(
    () => () => {
      if (!usingProvider) {
        for (const f of filesRef.current) {
          if (f.url) URL.revokeObjectURL(f.url);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [usingProvider]
  );

  const handleChange: ChangeEventHandler<HTMLInputElement> = (event) => {
    if (event.currentTarget.files) add(event.currentTarget.files);
    event.currentTarget.value = "";
  };


  const attachmentsCtx = useMemo<AttachmentsContext>(
    () => ({
      files: files.map((item) => ({ ...item, id: item.id })),
      add,
      remove,
      clear: clearAttachments,
      openFileDialog,
      fileInputRef: inputRef,
    }),
    [files, add, remove, clearAttachments, openFileDialog]
  );

  const refsCtx = useMemo<ReferencedSourcesContext>(
    () => ({
      sources: referencedSources,
      add: (incoming: SourceDocumentUIPart[] | SourceDocumentUIPart) => {
        const array = Array.isArray(incoming) ? incoming : [incoming];
        setReferencedSources((prev) =>
          prev.concat(array.map((s) => ({ ...s, id: nanoid() })))
        );
      },
      remove: (id: string) => {
        setReferencedSources((prev) => prev.filter((s) => s.id !== id));
      },
      clear: clearReferencedSources,
    }),
    [referencedSources, clearReferencedSources]
  );

  const handleSubmit: FormEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();

    // Uploading attachments is async and can take seconds, during which the
    // composer still looks idle. Without this guard a second click starts a
    // whole second submit and the message goes out twice.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const finish = () => {
      submittingRef.current = false;
      setSubmitting(false);
    };

    const form = event.currentTarget;
    const text = usingProvider
      ? controller.textInput.value
      : (() => {
          const formData = new FormData(form);
          return (formData.get("message") as string) || "";
        })();

    if (!usingProvider) form.reset();

    Promise.all(
      files.map(async ({ id, ...item }) => {
        if (item.url?.startsWith("blob:")) {
          const persisted = await persistBlobUrl(item.url, {
            filename: item.filename,
            mediaType: item.mediaType,
          });
          return { ...item, url: persisted ?? item.url };
        }
        return item;
      })
    )
      .then((convertedFiles: PromptInputMessage["files"]) => {
        try {
          const result = onSubmit({ text, files: convertedFiles }, event);
          if (result instanceof Promise) {
            result
              .then(() => {
                clear();
                if (usingProvider) controller.textInput.clear();
              })
              .catch(() => {})
              .finally(finish);
          } else {
            clear();
            if (usingProvider) controller.textInput.clear();
            finish();
          }
        } catch {
          // Don't clear on error
          finish();
        }
      })
      .catch(finish);
  };

  const inner = (
    <>
      <input
        accept={accept}
        aria-label="Upload files"
        // Visually hidden rather than `display: none`: Safari has historically
        // refused to open the picker for a file input it never renders.
        className="sr-only"
        multiple={multiple}
        onChange={handleChange}
        ref={inputRef}
        title="Upload files"
        type="file"
      />
      <form
        className={cn("w-full", className)}
        onSubmit={handleSubmit}
        ref={formRef}
        {...props}
      >
        <InputGroup className="overflow-hidden">{children}</InputGroup>
      </form>
    </>
  );

  return (
    <LocalAttachmentsContext.Provider value={attachmentsCtx}>
      <LocalReferencedSourcesContext.Provider value={refsCtx}>
        <PromptInputSubmittingContext.Provider value={submitting}>
          {inner}
        </PromptInputSubmittingContext.Provider>
      </LocalReferencedSourcesContext.Provider>
    </LocalAttachmentsContext.Provider>
  );
};
