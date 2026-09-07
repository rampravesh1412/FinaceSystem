/* eslint-env serviceworker */
/**
 * AMIRI Finance service worker.
 *
 * Hand-written rather than generated, because the one rule that matters here is a rule no
 * default preset gets right:
 *
 *   ── NOTHING under /api IS EVER CACHED. ──
 *
 * A stale balance is not a degraded experience, it is a wrong number on a financial
 * screen, and a user cannot tell the difference between "this is yesterday's figure" and
 * "this is the figure". Offline-first caching of ledger reads would make the application
 * lie. So the worker caches the SHELL — the HTML, JS, CSS and icons needed to draw the
 * app — and lets every piece of data go to the network or fail visibly.
 *
 * What that buys: the app opens instantly from the home screen, survives a flaky
 * connection on the way into the office, and shows its own offline screen instead of the
 * browser's dinosaur. What it deliberately does not buy: reading the books on a plane.
 *
 * Bump CACHE_VERSION to invalidate everything; `activate` deletes any cache that is not
 * in the current set.
 */

const CACHE_VERSION = "v1";
const SHELL_CACHE = `amiri-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `amiri-assets-${CACHE_VERSION}`;
const CURRENT = new Set([SHELL_CACHE, ASSET_CACHE]);

/** Enough to paint the app offline. Hashed bundles are added at runtime as they load. */
const SHELL_URLS = [
  "/",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

/** Rendered when a navigation fails and no cached shell is available. */
const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Offline — AMIRI Finance</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100dvh; display:grid; place-items:center; padding:2rem;
         background:#0d1220; color:#e7ecf5;
         font:400 15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif }
  .box { max-width:26rem; text-align:center }
  .mark { width:56px; height:56px; margin:0 auto 1.25rem; border-radius:14px;
          background:linear-gradient(#4b4edd,#303296); display:grid; place-items:center }
  h1 { font-size:1.125rem; margin:0 0 .5rem; letter-spacing:-.01em }
  p { margin:0 0 1.5rem; color:#93a0b8; font-size:.875rem }
  button { font:inherit; font-weight:500; font-size:.875rem; color:#fff; cursor:pointer;
           background:#4b4edd; border:0; border-radius:8px; padding:.625rem 1.25rem }
</style></head>
<body><div class="box">
  <div class="mark"><svg width="30" height="30" viewBox="0 0 64 64" fill="#fff">
    <path d="M32 15 47 26.4H17z"/><rect x="17" y="28.6" width="30" height="2.9" rx="1.45"/>
    <rect x="17" y="45.6" width="30" height="2.9" rx="1.45"/>
    <rect x="22.6" y="33.9" width="2.9" height="9.4" rx="1.45"/>
    <rect x="30.5" y="33.9" width="2.9" height="9.4" rx="1.45"/>
    <rect x="38.4" y="33.9" width="2.9" height="9.4" rx="1.45"/></svg></div>
  <h1>You are offline</h1>
  <p>AMIRI Finance needs a connection to show your books. Balances are never served from
     a cache, so nothing here can go quietly out of date.</p>
  <button onclick="location.reload()">Try again</button>
</div></body></html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individually, not addAll: addAll is atomic, so one 404 on one icon throws away
      // the entire precache and the worker never installs.
      await Promise.all(
        SHELL_URLS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {}),
        ),
      );
      // The waiting worker does NOT take over on its own — the page asks it to, once the
      // user has accepted the update. Skipping straight in would swap the JS bundle under
      // a half-filled payment form.
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !CURRENT.has(k)).map((k) => caches.delete(k)));
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

/** Hashed build output — content-addressed, so a hit is always correct. */
function isImmutableAsset(url) {
  return url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/");
}

function isApi(url) {
  return url.pathname.startsWith("/api/");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only GET is ever cacheable, and a cross-origin request is somebody else's business.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The rule this file exists for. Reads and writes both go straight to the network; a
  // failure surfaces to the app, which already knows how to show it.
  if (isApi(url)) return;

  // Navigations: network first, so a signed-in user always gets the newest shell, with
  // the cached shell as the fallback that makes the app open offline at all.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const preloaded = await event.preloadResponse;
          if (preloaded) {
            void caches.open(SHELL_CACHE).then((c) => c.put("/", preloaded.clone()));
            return preloaded;
          }
          const fresh = await fetch(request);
          void caches.open(SHELL_CACHE).then((c) => c.put("/", fresh.clone()));
          return fresh;
        } catch {
          // Any in-app route resolves to the same SPA document.
          const cached = (await caches.match("/")) || (await caches.match(request));
          return (
            cached ||
            new Response(OFFLINE_HTML, {
              status: 503,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            })
          );
        }
      })(),
    );
    return;
  }

  // Hashed assets: cache first. The filename changes when the content does, so a cached
  // copy can never be stale — and this is what makes a repeat launch instant.
  if (isImmutableAsset(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          void caches.open(ASSET_CACHE).then((c) => c.put(request, copy));
        }
        return response;
      })(),
    );
    return;
  }

  // Everything else same-origin (manifest, favicon): network with a cache fallback.
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          void caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
        }
        return response;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw new Error("offline and not cached");
      }
    })(),
  );
});
