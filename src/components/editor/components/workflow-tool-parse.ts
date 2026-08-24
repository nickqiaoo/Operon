/**
 * Reading a workflow tool call: its script's `meta`, and its result envelope.
 *
 * Pure string/JSON work, kept out of the renderer because it is the part that can
 * actually be wrong — a brace-matching parser and a best-effort envelope unwrap
 * both deserve tests, and neither needs React to run.
 */

export interface WorkflowMeta {
  name?: string;
  description?: string;
  phases: { title: string; detail?: string }[];
}

/** Subset of the Workflow tool result we care about (best-effort). */
export interface WorkflowOutputLike {
  status?: string;
  taskId?: string;
  runId?: string;
  summary?: string;
  scriptPath?: string;
  transcriptDir?: string;
  error?: string;
  warning?: string;
}


// ---------------------------------------------------------------------------
// Meta extraction — parse `export const meta = {...}` without eval.
// The meta block is constrained to a pure literal, so brace-matching + a
// shallow field scan is enough for a display skeleton.
// ---------------------------------------------------------------------------

/** Slice a balanced `open`/`close` region starting at `openIdx`, skipping string contents. */
export function sliceBalanced(src: string, openIdx: number, open: string, close: string): string | null {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    const prev = src[i - 1];
    if (inStr) {
      if (ch === inStr && prev !== '\\') inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return null;
}

/** Read the string value that follows a `key:` match. */
function readStringField(text: string, keyRe: RegExp): string | undefined {
  const m = keyRe.exec(text);
  if (!m) return undefined;
  const rest = text.slice(m.index + m[0].length);
  const v = /^\s*(['"`])([\s\S]*?)\1/.exec(rest);
  return v ? v[2] : undefined;
}

export function parseWorkflowMeta(script: string): WorkflowMeta {
  const empty: WorkflowMeta = { phases: [] };
  if (!script) return empty;

  const kw = script.search(/export\s+const\s+meta\s*=/);
  if (kw < 0) return empty;
  const braceIdx = script.indexOf('{', kw);
  if (braceIdx < 0) return empty;
  const metaText = sliceBalanced(script, braceIdx, '{', '}');
  if (!metaText) return empty;

  const name = readStringField(metaText, /\bname\s*:/);
  const description = readStringField(metaText, /\bdescription\s*:/);

  const phases: { title: string; detail?: string }[] = [];
  const phasesKw = metaText.search(/\bphases\s*:/);
  if (phasesKw >= 0) {
    const arrIdx = metaText.indexOf('[', phasesKw);
    if (arrIdx >= 0) {
      const arrText = sliceBalanced(metaText, arrIdx, '[', ']');
      if (arrText) {
        // phase entries are flat `{ title, detail, model }` — no nested braces
        for (const objMatch of arrText.matchAll(/\{[^{}]*\}/g)) {
          const obj = objMatch[0];
          const title = readStringField(obj, /\btitle\s*:/);
          if (!title) continue;
          const detail = readStringField(obj, /\bdetail\s*:/);
          phases.push(detail ? { title, detail } : { title });
        }
      }
    }
  }

  return { name, description, phases };
}

// ---------------------------------------------------------------------------
// Output coercion — the tool result shape varies; pull fields best-effort.
// ---------------------------------------------------------------------------

export function coerceWorkflowOutput(output: unknown): WorkflowOutputLike | undefined {
  if (!output) return undefined;
  let obj: unknown = output;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return undefined;
    }
  }
  if (obj && typeof obj === 'object') {
    // unwrap common AI-SDK tool output envelopes
    const rec = obj as Record<string, unknown>;
    if (rec.value && typeof rec.value === 'object') obj = rec.value;
    else if (rec.output && typeof rec.output === 'object') obj = rec.output;
  }
  if (!obj || typeof obj !== 'object') return undefined;
  const r = obj as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const result: WorkflowOutputLike = {
    status: str(r.status),
    taskId: str(r.taskId),
    runId: str(r.runId),
    summary: str(r.summary),
    scriptPath: str(r.scriptPath),
    transcriptDir: str(r.transcriptDir),
    error: str(r.error),
    warning: str(r.warning),
  };
  const hasAny = Object.values(result).some((v) => v !== undefined);
  return hasAny ? result : undefined;
}

