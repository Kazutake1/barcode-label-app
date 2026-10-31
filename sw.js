// First-party resources only; camera decoder CDN script is not cached.
const CACHE="barcode-label-local-v4";
const FILES=["./","./index.html","./style.css","./app.js","./manifest.webmanifest","./icon.svg","./icon-192.png"];
self.addEventListener("install",e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener("activate",e=>e.waitUntil(Promise.all([
  caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith("barcode-label-local-")&&k!==CACHE).map(k=>caches.delete(k)))),
  self.clients.claim()
])));
self.addEventListener("fetch",e=>{
  const req=e.request;
  if(req.method!=="GET")return;
  if(new URL(req.url).origin!==self.location.origin)return;
  e.respondWith(fetch(req).then(res=>{
    if(res.ok){const copy=res.clone();caches.open(CACHE).then(cache=>cache.put(req,copy)).catch(()=>{});}
    return res;
  }).catch(()=>caches.match(req)));
});
