/**
 * Keep agent-facing tool errors concise while preserving stable native error codes.
 *
 * Errors can cross a vm and child-process boundary, so use structural checks instead
 * of `instanceof Error`.
 */
export function formatNodeReplError(error: unknown): string {
  const record =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; message?: unknown })
      : undefined;
  const message =
    typeof record?.message === "string" && record.message.length > 0
      ? record.message
      : String(error);
  const code =
    typeof record?.code === "number" && Number.isFinite(record.code)
      ? record.code
      : undefined;

  return code === undefined ? message : `[${code}] ${message}`;
}
