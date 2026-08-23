// preprocess-worker.js — "modo robusto" para exames fora do domínio (anisotrópicos, poucos cortes, campo de viés).
// Etapas (inspiradas no que SynthSR/SynthSeg resolvem, implementadas com processamento clássico):
//  1. reamostragem cúbica (Catmull-Rom) dos eixos espessos até ~isotrópico
//  2. máscara de primeiro plano por Otsu
//  3. correção de campo de viés por filtragem homomórfica (log-domínio, box-filter iterado, convolução normalizada)
//  4. suavização 3D leve opcional (ruído de baixo campo)
// Não substitui uma rede treinada com domain randomization; reduz o "degrau" entre cortes e o viés de iluminação
// antes da conformação para 256³/1 mm e da inferência.
// A correção de campo de viés tem dois métodos: 'n4' (estilo N4ITK/ANTs, ver js/n4.js) e
// 'homomorfico' (filtragem homomórfica rápida, implementada abaixo).

import { n4BiasCorrect } from './n4.js'

function post(msg, transfer) { self.postMessage(msg, transfer || []) }
function progress(msg, frac) { post({ cmd: 'progress', message: msg, frac }) }

// ---------- reamostragem cúbica separável ----------
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}
/** reamostra o eixo `axis` (0,1,2) de `n` para `nNew` amostras (grade alinhada pelo centro do primeiro voxel) */
function resampleAxis(img, dims, axis, nNew) {
  const [nx, ny, nz] = dims
  const n = dims[axis]
  const outDims = [...dims]; outDims[axis] = nNew
  const out = new Float32Array(outDims[0] * outDims[1] * outDims[2])
  const stride = [1, nx, nx * ny][axis]
  const scale = (n - 1) / Math.max(1, nNew - 1)
  const oStrides = [1, outDims[0], outDims[0] * outDims[1]]
  // pré-computa pesos
  const i0s = new Int32Array(nNew), ts = new Float32Array(nNew)
  for (let o = 0; o < nNew; o++) { const s = o * scale; const i1 = Math.min(n - 1, Math.floor(s)); i0s[o] = i1; ts[o] = s - i1 }
  const cl = (i) => Math.max(0, Math.min(n - 1, i))
  for (let z = 0; z < outDims[2]; z++) {
    for (let y = 0; y < outDims[1]; y++) {
      for (let x = 0; x < outDims[0]; x++) {
        const coord = [x, y, z]
        const o = coord[axis]
        const i1 = i0s[o], t = ts[o]
        // índice base no volume de entrada com a coordenada do eixo zerada
        const inCoord = [x, y, z]; inCoord[axis] = 0
        const base = inCoord[0] + inCoord[1] * nx + inCoord[2] * nx * ny
        const p0 = img[base + cl(i1 - 1) * stride], p1 = img[base + i1 * stride]
        const p2 = img[base + cl(i1 + 1) * stride], p3 = img[base + cl(i1 + 2) * stride]
        let v = t === 0 ? p1 : catmullRom(p0, p1, p2, p3, t)
        // Catmull-Rom pode ultrapassar o intervalo local; limita
        const lo = Math.min(p1, p2), hi = Math.max(p1, p2)
        if (v < lo) v = lo; else if (v > hi) v = hi
        out[x * oStrides[0] + y * oStrides[1] + z * oStrides[2]] = v
      }
    }
  }
  return { img: out, dims: outDims }
}

// ---------- Otsu ----------
function otsu(img, mask) {
  let mx = -Infinity, mn = Infinity
  for (let i = 0; i < img.length; i++) { const v = img[i]; if (v > mx) mx = v; if (v < mn) mn = v }
  const nb = 256, hist = new Float64Array(nb)
  const sc = (nb - 1) / (mx - mn || 1)
  for (let i = 0; i < img.length; i++) hist[Math.round((img[i] - mn) * sc)]++
  const total = img.length
  let sumAll = 0
  for (let b = 0; b < nb; b++) sumAll += b * hist[b]
  let wB = 0, sumB = 0, best = 0, thr = 0
  for (let b = 0; b < nb; b++) {
    wB += hist[b]; if (wB === 0) continue
    const wF = total - wB; if (wF === 0) break
    sumB += b * hist[b]
    const mB = sumB / wB, mF = (sumAll - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; thr = b }
  }
  return mn + thr / sc
}

// ---------- box filter iterado (≈ gaussiana) ----------
function boxAxis(src, dst, dims, axis, r) {
  const [nx, ny, nz] = dims
  const n = dims[axis]
  const stride = [1, nx, nx * ny][axis]
  const other = [0, 1, 2].filter((a) => a !== axis)
  const oN = [dims[other[0]], dims[other[1]]], oS = [[1, nx, nx * ny][other[0]], [1, nx, nx * ny][other[1]]]
  const win = 2 * r + 1
  for (let b = 0; b < oN[1]; b++) {
    for (let a = 0; a < oN[0]; a++) {
      const base = a * oS[0] + b * oS[1]
      // soma acumulada com bordas replicadas
      let s = 0
      for (let i = -r; i <= r; i++) s += src[base + Math.max(0, Math.min(n - 1, i)) * stride]
      for (let i = 0; i < n; i++) {
        dst[base + i * stride] = s / win
        const add = Math.min(n - 1, i + r + 1), rem = Math.max(0, i - r)
        s += src[base + add * stride] - src[base + rem * stride]
      }
    }
  }
}
function smooth3(img, dims, radiusVox, iters = 3) {
  let a = Float32Array.from(img), b = new Float32Array(img.length)
  for (let it = 0; it < iters; it++) {
    for (let axis = 0; axis < 3; axis++) {
      const r = Math.max(1, Math.round(radiusVox[axis]))
      boxAxis(a, b, dims, axis, r)
      const t = a; a = b; b = t
    }
  }
  return a
}

function biasCorrect(img, dims, pixdims, sigmaMM) {
  const thr = otsu(img)
  const mask = new Float32Array(img.length)
  const logI = new Float32Array(img.length)
  let n = 0
  for (let i = 0; i < img.length; i++) {
    if (img[i] > thr * 0.5 && img[i] > 0) { mask[i] = 1; logI[i] = Math.log(img[i] + 1); n++ }
  }
  if (n < 1000) return { img, applied: false }
  // raio de box: 3 iterações de box de raio r ≈ gaussiana com σ ≈ r (aprox.)
  const radius = pixdims.map((p) => sigmaMM / p / 1.2)
  const num = smooth3(logI, dims, radius)
  const den = smooth3(mask, dims, radius)
  let meanLog = 0
  const field = new Float32Array(img.length)
  for (let i = 0; i < img.length; i++) { field[i] = den[i] > 1e-3 ? num[i] / den[i] : 0; if (mask[i]) meanLog += field[i] }
  meanLog /= n
  const out = new Float32Array(img.length)
  for (let i = 0; i < img.length; i++) {
    if (mask[i]) {
      const corr = Math.exp(logI[i] - field[i] + meanLog) - 1
      out[i] = corr > 0 ? corr : 0
    } else out[i] = img[i]
  }
  return { img: out, applied: true }
}

self.onmessage = (e) => {
  const { img, dims, pixdims, affine, options } = e.data
  try {
    let cur = new Float32Array(img), curDims = [...dims], curPix = [...pixdims]
    const curAffine = [...affine]
    const log = []
    // 1. reamostragem dos eixos espessos
    const target = Math.max(options.targetMM || 1.0, Math.min(...pixdims))
    for (let axis = 0; axis < 3; axis++) {
      if (curPix[axis] > target * 1.15 && curDims[axis] > 1) {
        const nNew = Math.round((curDims[axis] - 1) * curPix[axis] / target) + 1
        progress(`Reamostragem cúbica do eixo ${'xyz'[axis]}: ${curDims[axis]} → ${nNew} cortes`, 0.1 + axis * 0.15)
        const r = resampleAxis(cur, curDims, axis, nNew)
        const f = (curDims[axis] - 1) / Math.max(1, nNew - 1) // novo passo em unidades de voxel antigo
        cur = r.img; curDims = r.dims
        // affine: coluna do eixo escalada por f (mesma origem, centro do primeiro voxel)
        curAffine[axis] *= f; curAffine[4 + axis] *= f; curAffine[8 + axis] *= f
        curPix[axis] = curPix[axis] * f
        log.push(`eixo ${'xyz'[axis]}: ${pixdims[axis].toFixed(2)} → ${curPix[axis].toFixed(2)} mm (Catmull-Rom)`)
      }
    }
    // 2/3. campo de viés: N4 (ANTs-like) ou homomórfico
    if (options.biasCorrect !== false) {
      if ((options.biasMethod || 'n4') === 'n4') {
        progress('Correção de campo de viés N4 (ANTs-like)', 0.6)
        const b = n4BiasCorrect(cur, curDims, curPix, options.n4 || {}, (msg, frac) => progress(msg, 0.6 + 0.2 * (frac || 0)))
        cur = b.img
        log.push(...(b.applied ? b.log : ['N4: máscara insuficiente, etapa ignorada']))
      } else {
        progress('Correção homomórfica de campo de viés', 0.6)
        const b = biasCorrect(cur, curDims, curPix, options.biasSigmaMM || 30)
        cur = b.img
        log.push(b.applied ? `campo de viés corrigido (homomórfico, σ≈${options.biasSigmaMM || 30} mm)` : 'campo de viés: máscara insuficiente, etapa ignorada')
      }
    }
    // 4. suavização leve
    if (options.denoise) {
      progress('Suavização 3D leve', 0.85)
      cur = smooth3(cur, curDims, [1, 1, 1], 1)
      log.push('suavização 3D (box 3×3×3)')
    }
    progress('Pré-processamento concluído', 1)
    post({ cmd: 'done', img: cur, dims: curDims, pixdims: curPix, affine: curAffine, log }, [cur.buffer])
  } catch (err) {
    post({ cmd: 'error', message: err.message || String(err) })
  }
}
