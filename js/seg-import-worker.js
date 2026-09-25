// seg-import-worker.js — importação de segmentação externa fora da thread principal.
// Remapeia códigos FreeSurfer (até ~2035) para ids compactos uint8 via tabela tipada, conta os volumes
// na GRADE NATIVA (como o FreeSurfer) e reamostra os rótulos para a grade conformada do T1.
import { FS_LUT } from './fs-lut.js'
import { computeStats } from './stats.js'
import { resampleLabels } from './conform-worker.js'

function post(msg, transfer) { self.postMessage(msg, transfer || []) }
function hslRGB(h, s, l) {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255))
}

self.onmessage = (e) => {
  const { img, slope, inter, dims, affine, confAffine } = e.data
  try {
    const [nx, ny, nz] = dims
    const n = nx * ny * nz
    post({ cmd: 'progress', message: 'Lendo códigos de rótulo…', frac: 0.2 })
    // 1ª passada: códigos inteiros presentes (tabela tipada — um Map por voxel custava ~20 s em 256³)
    let maxCode = 0, nonInt = 0
    const code = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      const v = img[i] * slope + inter
      const c = Math.round(v)
      if (Math.abs(v - c) > 1e-3) nonInt++
      code[i] = c
      if (c > maxCode) maxCode = c
    }
    if (nonInt > n * 0.001) throw new Error('não parece um mapa de rótulos (valores não inteiros)')
    if (maxCode > 1e6) throw new Error(`código de rótulo muito alto (${maxCode})`)
    const counts = new Float64Array(maxCode + 1)
    for (let i = 0; i < n; i++) if (code[i] > 0) counts[code[i]]++
    const codes = []
    for (let c = 1; c <= maxCode; c++) if (counts[c]) codes.push(c)
    if (codes.length < 3) throw new Error('não parece um mapa de rótulos (menos de 3 rótulos)')
    if (codes.length > 255) throw new Error(`${codes.length} rótulos distintos — máximo 255 (parcelamentos a2009s não são suportados)`)
    const compactOf = new Uint8Array(maxCode + 1)
    codes.forEach((c, k) => { compactOf[c] = k + 1 })
    const labels = new Uint8Array(n)
    for (let i = 0; i < n; i++) if (code[i] > 0) labels[i] = compactOf[code[i]]
    // nomes e cores do LUT do FreeSurfer
    const labelNames = { 0: 'Unknown' }
    const colormap = { R: [0], G: [0], B: [0] }
    let unknown = 0
    codes.forEach((c, k) => {
      const lut = FS_LUT[c]
      if (!lut) unknown++
      labelNames[k + 1] = lut ? lut[0] : `label-${c}`
      const [r, g, b] = lut ? lut.slice(1) : hslRGB((k * 137.508) % 360, 0.65, 0.55)
      colormap.R.push(r); colormap.G.push(g); colormap.B.push(b)
    })
    colormap.labels = Array.from({ length: colormap.R.length }, (_, i) => labelNames[i] ?? '')
    // volume do voxel pela affine (|det| da parte 3×3)
    const A = affine
    const det = A[0] * (A[5] * A[10] - A[6] * A[9]) - A[1] * (A[4] * A[10] - A[6] * A[8]) + A[2] * (A[4] * A[9] - A[5] * A[8])
    const voxelVolume = Math.abs(det) || 1
    post({ cmd: 'progress', message: 'Volumes na grade nativa…', frac: 0.5 })
    const result = computeStats({ labels, intensity: null, dims, affine, voxelVolume, labelNames, colormap })
    post({ cmd: 'progress', message: 'Reamostrando rótulos para a grade conformada (vizinho mais próximo)…', frac: 0.8 })
    const confLabels = resampleLabels({ labels, inDims: dims, inAffine: affine, outAffine: confAffine })
    post({ cmd: 'done', codes, labelNames, colormap, result, confLabels, voxelVolume, unknown }, [confLabels.buffer])
  } catch (err) {
    post({ cmd: 'error', message: err.message || String(err) })
  }
}
