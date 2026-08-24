const LEGACY_RUNTIME_CACHES = ["operon-assets"]

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all(LEGACY_RUNTIME_CACHES.map((cacheName) => caches.delete(cacheName))),
  )
})
