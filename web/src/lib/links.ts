/**
 * The SaaS web app (the dist-web build of the main app), deployed separately.
 * Set VITE_APP_URL per deploy; the fallback is the production address.
 */
export const APP_URL: string = import.meta.env.VITE_APP_URL ?? 'https://app.operon.chatcode.top/'

export const IOS_APP_STORE_URL = 'https://apps.apple.com/us/app/operon-ai/id6797370866'

/**
 * Versioned filename on purpose: the URL changes with every release, so a CDN
 * or a browser that cached the previous build can never hand someone a stale
 * APK. Update this and drop the new file into `public/download/` together.
 */
export const ANDROID_APK_URL = '/download/operon-1.0.5.apk'

export const GITHUB_URL = 'https://github.com/Nickqiaoo/Operon'
export const DISCORD_URL = 'https://discord.gg/2BuvC6v3B'
export const X_URL = 'https://x.com/operon_ai'
