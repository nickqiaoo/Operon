/**
 * `blocked` is a live session that cannot produce frames — today only a missing
 * Screen Recording grant (`reason: "screen-recording"`). The host uses it to
 * explain an empty PiP instead of rendering nothing at all.
 */
export type ComputerUsePresentationEventType =
  | "active"
  | "presentation"
  | "blocked"
  | "ended";

export interface ComputerUsePresentationEvent {
  type: ComputerUsePresentationEventType;
  sessionID?: string;
  turnID?: string;
  hostSessionID?: string;
  app?: string;
  bundleIdentifier?: string;
  displayName?: string;
  contextID?: number;
  width?: number;
  height?: number;
  reason?: string;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function decodeComputerUsePresentationEvent(
  line: string,
): ComputerUsePresentationEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const type = record.type;
  if (
    type !== "active"
    && type !== "presentation"
    && type !== "blocked"
    && type !== "ended"
  ) {
    return undefined;
  }

  return {
    type,
    sessionID: optionalString(record, "sessionID"),
    turnID: optionalString(record, "turnID"),
    hostSessionID: optionalString(record, "hostSessionID"),
    app: optionalString(record, "app"),
    bundleIdentifier: optionalString(record, "bundleIdentifier"),
    displayName: optionalString(record, "displayName"),
    contextID: optionalPositiveInteger(record, "contextID"),
    width: optionalPositiveInteger(record, "width"),
    height: optionalPositiveInteger(record, "height"),
    reason: optionalString(record, "reason"),
  };
}
