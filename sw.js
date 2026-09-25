// sw.js — cache offline do Morfo Studio (app shell + vendor + modelos + fontes)
const VERSION = 'morfo-v0.5.0'
const PRECACHE = [
  "./",
  "./fonts/archivo-wdth.woff2",
  "./fonts/jetbrains-mono.woff2",
  "./fonts/source-sans-3.woff2",
  "./icons/icon-192.png",
  "./icons/icon-512-maskable.png",
  "./icons/icon-512.png",
  "./index.html",
  "./js/app.js",
  "./js/brainchop-parameters.js",
  "./js/brainchop-webworker.js",
  "./js/bwlabels.js",
  "./js/conform-worker.js",
  "./js/fs-lut.js",
  "./js/fsl-prep.js",
  "./js/fusion-worker.js",
  "./js/fusion.js",
  "./js/hippocampus-worker.js",
  "./js/hippocampus.js",
  "./js/mask-worker.js",
  "./js/motion-worker.js",
  "./js/n4.js",
  "./js/nifti-writer.js",
  "./js/pdf.js",
  "./js/preprocess-worker.js",
  "./js/quality.js",
  "./js/report.js",
  "./js/sav.js",
  "./js/seg-import-worker.js",
  "./js/stats.js",
  "./js/tensor-utils.js",
  "./js/zip.js",
  "./licenses/LICENSE-brain2print-brainchop.txt",
  "./licenses/LICENSE-dcm2niix.txt",
  "./licenses/LICENSE-fastsurfer-conform.txt",
  "./licenses/LICENSE-gl-matrix.txt",
  "./licenses/LICENSE-niivue.txt",
  "./manifest.json",
  "./models/model20chan3cls/colorLUT.json",
  "./models/model20chan3cls/colormap.json",
  "./models/model20chan3cls/labels.json",
  "./models/model20chan3cls/model.bin",
  "./models/model20chan3cls/model.json",
  "./models/model21_104class/colorLUT.json",
  "./models/model21_104class/colormap.json",
  "./models/model21_104class/group1-shard1of1.bin",
  "./models/model21_104class/labels.json",
  "./models/model21_104class/model.json",
  "./models/model30chan18cls/colorLUT.json",
  "./models/model30chan18cls/colormap.json",
  "./models/model30chan18cls/labels.json",
  "./models/model30chan18cls/model.bin",
  "./models/model30chan18cls/model.json",
  "./models/model30chan50cls/colorLUT.json",
  "./models/model30chan50cls/colormap.json",
  "./models/model30chan50cls/labels.json",
  "./models/model30chan50cls/model.bin",
  "./models/model30chan50cls/model.json",
  "./models/model5_gw_ae/colorLUT.json",
  "./models/model5_gw_ae/colormap.json",
  "./models/model5_gw_ae/colormap3.json",
  "./models/model5_gw_ae/group1-shard1of1.bin",
  "./models/model5_gw_ae/labels.json",
  "./models/model5_gw_ae/model.json",
  "./styles.css",
  "./vendor/dcm2niix/dcm2niix.jpeg.js",
  "./vendor/dcm2niix/dcm2niix.jpeg.wasm",
  "./vendor/dcm2niix/index.jpeg.js",
  "./vendor/dcm2niix/worker.jpeg.js",
  "./vendor/niivue.min.js",
  "./vendor/tf.fesm.min.js"
]

// instalação atômica: se qualquer arquivo falhar, a versão anterior (completa) continua servindo
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))))
  // sem skipWaiting automático: a aba aberta mantém app.js e workers da MESMA versão; o app oferece recarregar
})
self.addEventListener('message', (event) => { if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting() })
self.addEventListener('activate', (event) => {
  // apaga só caches do próprio app (no GitHub Pages várias apps dividem a mesma origem)
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('morfo-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return // modelos externos (modelo próprio) vão direto à rede
  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true })
    if (hit) return hit
    try {
      const res = await fetch(req)
      if (res.status === 200) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {}) }
      return res
    } catch (e) {
      // offline: navegação cai no index.html cacheado; demais pedidos falham explicitamente
      if (req.mode === 'navigate') { const shell = await caches.match('./index.html'); if (shell) return shell }
      return Response.error()
    }
  })())
})
