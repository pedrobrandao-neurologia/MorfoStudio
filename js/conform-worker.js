// conform-worker.js — conformação FreeSurfer-style (256³, 1 mm, LIA, uint8) fora da thread principal.
//
// Porte fiel do Niivue.conform() (NiiVue, BSD-2 — que por sua vez traduz o conform.py do FastSurfer,
// Apache-2.0), com a mesma aritmética float32 do gl-matrix (MIT) para produzir saída idêntica byte a byte.
// Motivo: nv.conform() roda sincronamente na thread principal (~3 s em 256³), congelando a interface.
// Aqui ela roda num Web Worker; o NVImage é recriado na thread principal a partir do NIfTI resultante.
//
// Escalonamento de intensidade (getScale):
//   robust=false → mínimo global até o percentil 99,9 dos voxels não nulos (regra do FreeSurfer/FastSurfer,
//                  a usada pelo brainchop, de onde vêm os modelos MeshNet);
//   robust=true  → janela de exibição do NiiVue (cal_min/cal_max), como o brain2print.

// ---------------------------------------------------------------- gl-matrix (float32), extraído do bundle NiiVue
const ARRAY_TYPE = Float32Array
const mat4 = {
  create() { const o = new ARRAY_TYPE(16); o[0] = 1; o[5] = 1; o[10] = 1; o[15] = 1; return o },
  fromValues(...v) { const o = new ARRAY_TYPE(16); for (let i = 0; i < 16; i++) o[i] = v[i]; return o },
  transpose(out, a) {
    if (out === a) {
      const a01 = a[1], a02 = a[2], a03 = a[3], a12 = a[6], a13 = a[7], a23 = a[11]
      out[1] = a[4]; out[2] = a[8]; out[3] = a[12]; out[4] = a01; out[6] = a[9]; out[7] = a[13]
      out[8] = a02; out[9] = a12; out[11] = a[14]; out[12] = a03; out[13] = a13; out[14] = a23
    } else {
      out[0] = a[0]; out[1] = a[4]; out[2] = a[8]; out[3] = a[12]; out[4] = a[1]; out[5] = a[5]; out[6] = a[9]; out[7] = a[13]
      out[8] = a[2]; out[9] = a[6]; out[10] = a[10]; out[11] = a[14]; out[12] = a[3]; out[13] = a[7]; out[14] = a[11]; out[15] = a[15]
    }
    return out
  },
  invert(out, a) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7]
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15]
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10
    const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30
    const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
    if (!det) return null
    det = 1 / det
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det
    return out
  },
  multiply(out, a, b) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7]
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15]
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3]
      out[c * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
      out[c * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
      out[c * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
      out[c * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
    }
    return out
  },
  scale(out, a, v) {
    const x = v[0], y = v[1], z = v[2]
    for (let i = 0; i < 4; i++) { out[i] = a[i] * x; out[4 + i] = a[4 + i] * y; out[8 + i] = a[8 + i] * z; out[12 + i] = a[12 + i] }
    return out
  }
}
const vec4 = {
  fromValues(x, y, z, w) { const o = new ARRAY_TYPE(4); o[0] = x; o[1] = y; o[2] = z; o[3] = w; return o },
  create() { return new ARRAY_TYPE(4) },
  transformMat4(out, a, m) {
    const x = a[0], y = a[1], z = a[2], w = a[3]
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w
    out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w
    return out
  },
  scale(out, a, b) { out[0] = a[0] * b; out[1] = a[1] * b; out[2] = a[2] * b; out[3] = a[3] * b; return out }
}
const vec3 = {
  fromValues(x, y, z) { const o = new ARRAY_TYPE(3); o[0] = x; o[1] = y; o[2] = z; return o },
  create() { return new ARRAY_TYPE(3) },
  subtract(out, a, b) { out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; return out }
}

// ---------------------------------------------------------------- NiiVue: conformVox2Vox / resampleVolume / getScale / scalecropUint8
export function conformVox2Vox({ inDims, inAffine, outDims, outMM = 1, toRAS = false }) {
  const [outDimX, outDimY, outDimZ] = outDims
  const a = inAffine
  const affine = mat4.fromValues(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11], a[12], a[13], a[14], a[15])
  const half = vec4.fromValues(inDims[1] / 2, inDims[2] / 2, inDims[3] / 2, 1)
  const Pxyz_c4 = vec4.create()
  const affineT = mat4.create()
  mat4.transpose(affineT, affine)
  vec4.transformMat4(Pxyz_c4, half, affineT)
  const Pxyz_c = vec3.fromValues(Pxyz_c4[0], Pxyz_c4[1], Pxyz_c4[2])
  const delta = vec3.fromValues(outMM, outMM, outMM)
  let Mdc = mat4.fromValues(-1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1)
  if (toRAS) Mdc = mat4.fromValues(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
  mat4.transpose(Mdc, Mdc)
  const dims = vec4.fromValues(outDimX, outDimY, outDimZ, 1)
  const MdcD = mat4.create()
  mat4.scale(MdcD, Mdc, delta)
  const volCenter = vec4.fromValues(dims[0], dims[1], dims[2], 1)
  vec4.transformMat4(volCenter, volCenter, MdcD)
  vec4.scale(volCenter, volCenter, 0.5)
  const translate3 = vec3.create()
  vec3.subtract(translate3, Pxyz_c, vec3.fromValues(volCenter[0], volCenter[1], volCenter[2]))
  const outAffine = mat4.create()
  mat4.transpose(outAffine, MdcD)
  outAffine[3] = translate3[0]
  outAffine[7] = translate3[1]
  outAffine[11] = translate3[2]
  const invOutAffine = mat4.create()
  mat4.invert(invOutAffine, outAffine)
  const vox2vox = mat4.create()
  mat4.multiply(vox2vox, affine, invOutAffine)
  const invVox2vox = mat4.create()
  mat4.invert(invVox2vox, vox2vox)
  return { outAffine, vox2vox, invVox2vox }
}

export function resampleVolume({ inImg, inDims, outDims, invVox2vox, isLinear }) {
  const [outDimX, outDimY, outDimZ] = outDims
  const outImg = new Float32Array(outDimX * outDimY * outDimZ)
  const dimX = inDims[1], dimY = inDims[2], dimZ = inDims[3], dimXY = dimX * dimY
  const inv0 = invVox2vox[0], inv4 = invVox2vox[4], inv8 = invVox2vox[8]
  let i = -1
  for (let z = 0; z < outDimZ; z++) {
    for (let y = 0; y < outDimY; y++) {
      const ixYZ = y * invVox2vox[1] + z * invVox2vox[2] + invVox2vox[3]
      const iyYZ = y * invVox2vox[5] + z * invVox2vox[6] + invVox2vox[7]
      const izYZ = y * invVox2vox[9] + z * invVox2vox[10] + invVox2vox[11]
      for (let x = 0; x < outDimX; x++) {
        const ix = x * inv0 + ixYZ, iy = x * inv4 + iyYZ, iz = x * inv8 + izYZ
        i++
        if (isLinear) {
          const fx = Math.floor(ix), fy = Math.floor(iy), fz = Math.floor(iz)
          if (fx < 0 || fy < 0 || fz < 0) continue
          const cx = Math.ceil(ix), cy = Math.ceil(iy), cz = Math.ceil(iz)
          if (cx >= dimX || cy >= dimY || cz >= dimZ) continue
          const rcx = ix - fx, rcy = iy - fy, rcz = iz - fz
          const rfx = 1 - rcx, rfy = 1 - rcy, rfz = 1 - rcz
          const fff = fx + fy * dimX + fz * dimXY
          let vx = 0
          vx += inImg[fff] * rfx * rfy * rfz
          vx += inImg[fff + dimXY] * rfx * rfy * rcz
          vx += inImg[fff + dimX] * rfx * rcy * rfz
          vx += inImg[fff + dimX + dimXY] * rfx * rcy * rcz
          vx += inImg[fff + 1] * rcx * rfy * rfz
          vx += inImg[fff + 1 + dimXY] * rcx * rfy * rcz
          vx += inImg[fff + 1 + dimX] * rcx * rcy * rfz
          vx += inImg[fff + 1 + dimX + dimXY] * rcx * rcy * rcz
          outImg[i] = vx
        } else {
          const rx = Math.round(ix), ry = Math.round(iy), rz = Math.round(iz)
          if (rx < 0 || ry < 0 || rz < 0 || rx >= dimX || ry >= dimY || rz >= dimZ) continue
          outImg[i] = inImg[rx + ry * dimX + rz * dimXY]
        }
      }
    }
  }
  return outImg
}

export function getScale({ img, dims, globalMin, globalMax, datatypeCode, sclSlope, sclInter, calMin, calMax, dstMin = 0, dstMax = 255, fLow = 0, fHigh = 0.999 }) {
  let srcMin = globalMin
  let srcMax = globalMax
  if (datatypeCode === 2) return [srcMin, 1] // uint8: já está em 0–255
  if (!isFinite(fLow) || !isFinite(fHigh)) {
    if (isFinite(calMin) && isFinite(calMax) && calMax > calMin) {
      return [calMin, (dstMax - dstMin) / (calMax - calMin)]
    }
  }
  const voxnum = dims[1] * dims[2] * dims[3]
  let scaledImg = img
  if (sclSlope !== 1 || sclInter !== 0) {
    scaledImg = new Float32Array(voxnum)
    for (let i = 0; i < voxnum; i++) scaledImg[i] = img[i] * sclSlope + sclInter
  }
  if (fLow === 0 && fHigh === 1) return [srcMin, 1]
  let nz = 0
  for (let i = 0; i < voxnum; i++) if (Math.abs(scaledImg[i]) >= 1e-15) nz++
  const histosize = 1e3
  const binSize = (srcMax - srcMin) / histosize
  const hist = new Array(histosize).fill(0)
  for (let i = 0; i < voxnum; i++) {
    let bin = Math.floor((scaledImg[i] - srcMin) / binSize)
    bin = Math.min(bin, histosize - 1)
    hist[bin]++
  }
  const cs = new Array(histosize).fill(0)
  cs[0] = hist[0]
  for (let i = 1; i < histosize; i++) cs[i] = cs[i - 1] + hist[i]
  let nth = Math.floor(fLow * voxnum)
  let idx = 0
  while (idx < histosize) { if (cs[idx] >= nth) break; idx++ }
  const saved = srcMin
  srcMin = idx * binSize + saved
  nth = voxnum - Math.floor((1 - fHigh) * nz)
  idx = 0
  while (idx < histosize - 1) { if (cs[idx + 1] >= nth) break; idx++ }
  srcMax = idx * binSize + saved
  let scale = 1
  if (srcMin !== srcMax) scale = (dstMax - dstMin) / (srcMax - srcMin)
  return [srcMin, scale]
}

export function scalecropUint8(img32, dstMin, dstMax, srcMin, scale) {
  const img8 = new Uint8Array(img32.length)
  for (let i = 0; i < img32.length; i++) {
    let val = dstMin + scale * (img32[i] - srcMin)
    val = Math.max(val, dstMin)
    val = Math.min(val, dstMax)
    img8[i] = val
  }
  return img8
}

/** conform completo: devolve { img: Uint8Array(256³), affine: number[16] row-major } */
export function conform(p) {
  const outDims = [256, 256, 256]
  const { outAffine, invVox2vox } = conformVox2Vox({ inDims: p.dims, inAffine: p.affine, outDims, outMM: 1, toRAS: !!p.toRAS })
  const inNvox = p.dims[1] * p.dims[2] * p.dims[3]
  const inImg = new Float32Array(p.img)
  if (p.sclSlope !== 1 || p.sclInter !== 0) for (let i = 0; i < inNvox; i++) inImg[i] = inImg[i] * p.sclSlope + p.sclInter
  const out32 = resampleVolume({ inImg, inDims: p.dims, outDims, invVox2vox, isLinear: p.isLinear !== false })
  const [srcMin, scale] = getScale({
    img: p.img, dims: p.dims, globalMin: p.globalMin, globalMax: p.globalMax, datatypeCode: p.datatypeCode,
    sclSlope: p.sclSlope, sclInter: p.sclInter, calMin: p.calMin, calMax: p.calMax, fLow: p.robust ? NaN : 0
  })
  return { img: scalecropUint8(out32, 0, 255, srcMin, scale), affine: Array.from(outAffine), srcMin, scale }
}

/**
 * Reamostra rótulos (vizinho mais próximo) de uma grade qualquer para a grade conformada 256³.
 * outAffine/inAffine: 16 números row-major voxel→mm. Usado na importação de segmentações externas.
 */
export function resampleLabels({ labels, inDims, inAffine, outAffine, outDims = [256, 256, 256] }) {
  const inv = invert4(inAffine)
  // M = inv(inAffine) · outAffine : voxel de saída → voxel de entrada
  const M = new Float64Array(12)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
    let s = 0
    for (let k = 0; k < 4; k++) s += inv[r * 4 + k] * outAffine[k * 4 + c]
    M[r * 4 + c] = s
  }
  const [nx, ny, nz] = inDims, [ox, oy, oz] = outDims
  const out = new Uint8Array(ox * oy * oz)
  let i = 0
  for (let z = 0; z < oz; z++) for (let y = 0; y < oy; y++) {
    const bx = M[1] * y + M[2] * z + M[3], by = M[5] * y + M[6] * z + M[7], bz = M[9] * y + M[10] * z + M[11]
    for (let x = 0; x < ox; x++, i++) {
      const X = Math.round(M[0] * x + bx), Y = Math.round(M[4] * x + by), Z = Math.round(M[8] * x + bz)
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue
      out[i] = labels[X + Y * nx + Z * nx * ny]
    }
  }
  return out
}

/** inversa 4×4 (row-major, precisão dupla) */
function invert4(a) {
  const m = mat4.invert(new Float64Array(16), Float64Array.from(a))
  if (!m) throw new Error('affine singular')
  return m
}

// registra o handler só quando este arquivo é o ponto de entrada do worker (quando importado por outro
// worker, ex. seg-import-worker.js, o módulo importador define o próprio onmessage depois)
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined' && !self.onmessage) {
  self.onmessage = (e) => {
    try {
      if (e.data.mode === 'labels') {
        const img = resampleLabels(e.data)
        self.postMessage({ cmd: 'done', img }, [img.buffer])
        return
      }
      const r = conform(e.data)
      self.postMessage({ cmd: 'done', ...r }, [r.img.buffer])
    } catch (err) {
      self.postMessage({ cmd: 'error', message: err.message || String(err) })
    }
  }
}
