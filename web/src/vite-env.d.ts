/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL of the SaaS web app (the dist-web build of the main app). Set per deploy. */
  readonly VITE_APP_URL?: string
}

interface Window {
  gtag?: (...args: unknown[]) => void
}

interface NavigatorUAData {
  platform: string
  getHighEntropyValues: (
    hints: string[],
  ) => Promise<{
    architecture?: string
    platform?: string
  }>
}

interface Navigator {
  userAgentData?: NavigatorUAData
}

declare module '@doc/*.md?raw' {
  const content: string
  export default content
}

declare module '*.md?raw' {
  const content: string
  export default content
}

declare module '*.PNG' {
  const src: string
  export default src
}
