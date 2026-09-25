// fusion-worker.js — roda a fusão aseg 18 + aparc+aseg 104 fora da thread principal (~0,5 s em 256³).
import { fuseAsegAparc } from './fusion.js'

self.onmessage = (e) => {
  try {
    const { labels, stats } = fuseAsegAparc(e.data)
    self.postMessage({ cmd: 'done', labels, stats }, [labels.buffer])
  } catch (err) {
    self.postMessage({ cmd: 'error', message: err.message || String(err) })
  }
}
