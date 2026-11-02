// A release activates only after every required response matches this manifest.
// Camera decoder CDN script is never cached; its SRI stays in app.js.
const CACHE_PREFIX='barcode-label-local:'+self.registration.scope+':';
const CACHE=CACHE_PREFIX+'v64';
const CORE=[
  {
    "url": "./index.html",
    "sha256": "58b18f468ac1902f8e3282d0c9909f1648018e1ffe7a07e5913867705278b815"
  },
  {
    "url": "./app.js?v=64",
    "sha256": "ee6e83c91884a607a035c49f2a8d509bc09156d08d4e5e697cccf87e126c1094"
  },
  {
    "url": "./style.css?v=64",
    "sha256": "5eff00f9359fb87c8fe6fabff536c3fbaf510b6a775137821969fe06340e5658"
  },
  {
    "url": "./manifest.webmanifest",
    "sha256": "52ce528e754f2d0dc2c7bb5ba3610e2654e754641e6a7d9d959811e91b8d18ca"
  },
  {
    "url": "./icon-192.png?v=2",
    "sha256": "8754e79a0b504871997e409b3e2b0b3629409dcd96a3a7e53821a488217b4264"
  },
  {
    "url": "./icon-512.png?v=2",
    "sha256": "5200ce0e6a3c9902d74077ea63cfd34129f1d27a4a8814f5caa5ddfaaedd62ee"
  }
];
function coreUrl(entry){return new URL(entry.url,self.registration.scope).href;}
async function verifiedResponse(entry){
  const response=await fetch(new Request(coreUrl(entry),{cache:'reload'}));
  if(!response.ok)throw Error('Release resource unavailable: '+entry.url);
  const digest=await crypto.subtle.digest('SHA-256',await response.clone().arrayBuffer());
  const actual=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(actual!==entry.sha256)throw Error('Release resource mismatch: '+entry.url);
  return response;
}
self.addEventListener('install',event=>event.waitUntil((async()=>{
  // Validate the whole release before making any of it available.
  const responses=await Promise.all(CORE.map(verifiedResponse));
  const cache=await caches.open(CACHE);
  await Promise.all(CORE.map((entry,i)=>cache.put(coreUrl(entry),responses[i])));
  // No skipWaiting: already open tabs finish using their current worker.
})()));
self.addEventListener('activate',event=>event.waitUntil(
  caches.keys().then(keys=>Promise.all(
    keys.filter(key=>key.startsWith(CACHE_PREFIX)&&key!==CACHE).map(key=>caches.delete(key))
  ))
));
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET'||new URL(req.url).origin!==self.location.origin)return;
  const entry=req.mode==='navigate'?CORE[0]:CORE.find(item=>coreUrl(item)===req.url);
  if(!entry)return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const cached=await cache.match(coreUrl(entry));
    if(cached)return cached;
    // If storage was evicted, accept only a file belonging to this same release.
    try{
      const response=await verifiedResponse(entry);
      await cache.put(coreUrl(entry),response.clone());
      return response;
    }catch{
      return new Response('保存済みアプリを読み込めません。通信環境を確認してアプリを開き直してください。',
        {status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
    }
  })());
});
