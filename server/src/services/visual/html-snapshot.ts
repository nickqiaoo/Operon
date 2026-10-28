// Renders a visual reply page to an image, for html_preview.
//
// The server has no browser of its own. In the desktop build it runs inside the
// Electron main process, which can render offscreen, so the host registers a
// snapshotter at startup (electron/html-snapshot.ts), the same shape as
// desktop-presence.ts. Headless nodes register none, and html_preview is not
// offered there: agents publish without a preview.

export interface HtmlSnapshotInput {
  /** The full document: stored HTML with theme and bridge injected. */
  html: string
  width: number
  /** Painted behind the page, which is transparent like it is in the chat. */
  backgroundColor: string
}

export interface HtmlSnapshot {
  jpeg: Buffer
  /** The page's own height at `width`, uncapped. */
  contentHeight: number
  /** Height of the image, which stops at a cap for very long pages. */
  capturedHeight: number
  console: Array<{ level: 'log' | 'info' | 'warning' | 'error'; text: string }>
}

export type HtmlSnapshotter = (input: HtmlSnapshotInput) => Promise<HtmlSnapshot>

let snapshotter: HtmlSnapshotter | null = null

export function setHtmlSnapshotter(next: HtmlSnapshotter | null): void {
  snapshotter = next
}

export function getHtmlSnapshotter(): HtmlSnapshotter | null {
  return snapshotter
}
