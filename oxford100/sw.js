/* oxford100 service worker · OFFLINE_SW_V1
   - 预缓存新版单词小程序（index.html、manifest、Jessica 发音包、图标）
   - index.html：网络优先（3 秒超时），失败用缓存 → 有更新时仍能拿到新版
   - 有道单词发音：第一次播放时顺手缓存（最多 300 个），之后离线也能播
   - legacy.html 及其资源不拦截，照常走网络 */
const VERSION = "fow1-off1";
const CORE = "oxford100-core-" + VERSION;
const AUDIO = "oxford100-yd-audio-v1";   // 发音缓存跨版本保留
const MAX_AUDIO = 300;
const PRECACHE = ["./", "./index.html", "./manifest.json", "./jessica_audio.js?v=1", "./icon-192.png", "./icon-512.png"];
const BASE = new URL("./", self.location).pathname;           // "/oxford100/"
const INDEX_PATHS = [BASE, BASE + "index.html"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CORE).then(c => Promise.all(PRECACHE.map(u =>
    fetch(new Request(u, { cache: "reload" })).then(r => { if (r.ok) return c.put(u, r); }).catch(() => {})
  ))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("oxford100-core-") && k !== CORE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)); }

async function indexNetworkFirst(req) {
  const c = await caches.open(CORE);
  try {
    const r = await Promise.race([fetch(req, { cache: "no-store" }), timeout(3000)]);
    if (r && r.ok) { c.put("./index.html", r.clone()).catch(() => {}); return r; }
    throw new Error("bad " + (r && r.status));
  } catch (err) {
    const hit = await c.match("./index.html") || await c.match("./");
    if (hit) return hit;
    return new Response("<meta charset=utf-8><p style='font:16px sans-serif;padding:20px'>当前离线，且这台设备还没有缓存过单词小程序。联网打开一次后就能离线使用。</p>", { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
}

async function cacheFirst(req) {
  const c = await caches.open(CORE);
  const hit = await c.match(req);
  if (hit) {
    // 小文件后台更新（manifest / 图标）；版本化的发音包不需要
    if (!/jessica_audio/.test(req.url)) fetch(req).then(r => { if (r.ok) c.put(req, r); }).catch(() => {});
    return hit;
  }
  const r = await fetch(req);
  if (r.ok) c.put(req, r.clone()).catch(() => {});
  return r;
}

async function trimAudio(c) {
  try { const ks = await c.keys(); for (let i = 0; i < ks.length - MAX_AUDIO; i++) await c.delete(ks[i]); } catch (e) {}
}
function audioKey(url) { const u = new URL(url); return "https://dict.youdao.com/dictvoice?type=" + (u.searchParams.get("type") || "2") + "&audio=" + encodeURIComponent((u.searchParams.get("audio") || "").toLowerCase()); }

async function youdao(e) {
  const req = e.request;
  const key = audioKey(req.url);
  const c = await caches.open(AUDIO);
  const hit = await c.match(key);
  if (hit && !navigator.onLine) return hit;
  try {
    const r = await Promise.race([fetch(req), timeout(4000)]);
    if (!hit && (r.ok || r.type === "opaque") && r.status !== 206) {
      // 完整响应才缓存；音频元素若发了 Range 请求，另外完整取一次
      if (!req.headers.get("range")) { e.waitUntil(c.put(key, r.clone()).then(() => trimAudio(c)).catch(() => {})); }
      else e.waitUntil(fetch(key, { mode: "no-cors" }).then(x => c.put(key, x)).then(() => trimAudio(c)).catch(() => {}));
    } else if (!hit) {
      e.waitUntil(fetch(key, { mode: "no-cors" }).then(x => c.put(key, x)).then(() => trimAudio(c)).catch(() => {}));
    }
    return r;
  } catch (err) {
    if (hit) return hit;
    return Response.error();
  }
}

self.addEventListener("message", e => {
  if (e.data && e.data.type === "cacheAudio" && e.data.url) {
    const key = audioKey(e.data.url);
    e.waitUntil(caches.open(AUDIO).then(c => c.match(key).then(h => h || fetch(key, { mode: "no-cors" }).then(x => c.put(key, x)).then(() => trimAudio(c)))).catch(() => {}));
  }
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname === "dict.youdao.com" && url.pathname === "/dictvoice") { e.respondWith(youdao(e)); return; }
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;
  const rel = url.pathname.slice(BASE.length);
  if (req.mode === "navigate" || INDEX_PATHS.includes(url.pathname)) {
    if (INDEX_PATHS.includes(url.pathname)) e.respondWith(indexNetworkFirst(req));
    return; // legacy.html 等其他页面：不拦截
  }
  if (["manifest.json", "jessica_audio.js", "icon-192.png", "icon-512.png"].includes(rel)) { e.respondWith(cacheFirst(req)); return; }
  // 其他（legacy 的 audio_modules_*.js、assets/ 等）：不拦截
});
