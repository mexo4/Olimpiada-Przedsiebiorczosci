const CACHE='op-trainer-v1-9-2';
const ASSETS=['./','./index.html','./styles.css','./app.js','./key-resolver.mjs','./manifest.json','./demo-data.json','./icons/icon-192.png','./icons/icon-512.png','./icons/apple-touch-icon.png'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>e.waitUntil(Promise.all([self.clients.claim(),caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))])));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const u=new URL(e.request.url);
  const shell=/\/(?:|index\.html|app\.js|styles\.css|key-resolver\.mjs|manifest\.json)$/.test(u.pathname);
  const freshData=/\/(?:op-raw\.json|op-data\.json|key-index\.json|archive-index\.json)$/.test(u.pathname)||/\/(?:archive|keys)\/.*\.(?:pdf|html?)$/i.test(u.pathname)||/\/vendor\/pdf.*\.mjs$/i.test(u.pathname);
  if(shell||freshData){e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{const c=r.clone();caches.open(CACHE).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request)));return;}
  e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(x=>x.put(e.request,copy));return r})));
});
