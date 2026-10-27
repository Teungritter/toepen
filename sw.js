/* Service worker: maakt Toepen installeerbaar en laat de app direct opstarten.
 *
 * Strategie: eerst het netwerk proberen (zodat een nieuwe versie na een push
 * meteen binnenkomt), en alleen als dat niet lukt of te lang duurt de
 * opgeslagen versie gebruiken. Verbinden met een kamer heeft wel internet nodig.
 */
const CACHE = 'toepen-v2';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'game.js', 'manifest.webmanifest',
  'vendor/peerjs.min.js', 'vendor/qrcode.min.js', 'fonts/fredoka.woff2', 'fonts/nunito.woff2',
  'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png',
];
const NETWORK_TIMEOUT = 2500;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  // Altijd bij de server navragen of er een nieuwere versie is (geen verouderde browsercache).
  const network = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT));
  const fast = await Promise.race([network.catch(() => null), timeout]);
  if (fast) return fast;
  const cached = await cache.match(req, { ignoreSearch: true });
  return cached || network;
}
