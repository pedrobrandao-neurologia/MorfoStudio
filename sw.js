// sw.js — cache offline do Morfo Studio (app shell + vendor + modelos + fontes)
const VERSION = 'morfo-v0.4.0'
const PRECACHE = [
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
  "./js/fsl-prep.js",
  "./js/mask-worker.js",
  "./js/hippocampus-worker.js",
  "./js/hippocampus.js",
  "./js/motion-worker.js",
  "./js/n4.js",
  "./js/nifti-writer.js",
  "./js/pdf.js",
  "./js/preprocess-worker.js",
  "./js/quality.js",
  "./js/report.js",
  "./js/sav.js",
  "./js/stats.js",
  "./js/tensor-utils.js",
  "./js/zip.js",
  "./licenses/LICENSE-brain2print-brainchop.txt",
  "./licenses/LICENSE-dcm2niix.txt",
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

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then(async (cache) => {
    // adiciona um a um para não falhar tudo por um único arquivo
    for (const url of PRECACHE) { try { await cache.add(new Request(url, { cache: 'reload' })) } catch (e) { console.warn('precache falhou', url) } }
  }).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return // modelos externos (modelo próprio) vão direto à rede
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)) }
    return res
  }).catch(() => hit)))
})
