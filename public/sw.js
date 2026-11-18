// Caches the analysis engine (Pyodide and the Python packages it installs) so it
// is downloaded once and starts quickly on every later visit. Only those package
// hosts are handled here; the app's own files are left to the browser.
const CACHE = "ncl-engine-v1";
const IMMUTABLE = [/^https:\/\/cdn\.jsdelivr\.net\/pyodide\//, /^https:\/\/files\.pythonhosted\.org\//];
const REFRESHABLE = [/^https:\/\/pypi\.org\/(pypi|simple)\//];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (IMMUTABLE.some((r) => r.test(request.url))) event.respondWith(cacheFirst(request));
  else if (REFRESHABLE.some((r) => r.test(request.url))) event.respondWith(networkFirst(request));
});

// Versioned files never change: serve from the cache, download only when missing.
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request.url, response.clone()).catch(() => undefined);
  return response;
}

// Package indexes can change: prefer the network, fall back to the cache when offline.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request.url, response.clone()).catch(() => undefined);
    return response;
  } catch (error) {
    const hit = await cache.match(request.url);
    if (hit) return hit;
    throw error;
  }
}
