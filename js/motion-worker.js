// motion-worker.js — correção de movimento entre volumes por registro rígido + média,
// no espírito do antsMotionCorr (ANTs): cada volume de uma série (4D ou aquisições repetidas)
// é registrado rigidamente a uma referência e a média dos volumes alinhados é devolvida.
//
// Correspondência com o ANTs (Examples/antsMotionCorr.cxx) e diferenças deliberadas:
//  • referência: como no antsMotionCorr com média atualizada, usa-se o volume 0 na 1ª passada,
//    a média dos alinhados como referência na 2ª passada;
//  • transformada: rígida 6-DOF (3 translações mm + 3 rotações) em torno do centro de massa;
//  • métrica: informação mútua (Mattes, 32 bins — padrão do ANTs) ou correlação cruzada
//    normalizada global ('ncc'), calculada em amostra regular da máscara (Otsu);
//  • otimização: no ANTs é descida de gradiente com escalas por deslocamento físico
//    (itkRegistrationParameterScalesFromPhysicalShift); aqui usa-se busca local coordenada
//    multirresolução sem gradiente (passos que encolhem), com as MESMAS escalas físicas —
//    rotações convertidas por um raio de 80 mm — o que dispensa o gradiente da MI;
//  • pirâmide: shrink 4 → 2 (suavização por média de bloco), como os níveis grossos do ANTs.
//
// Importante: isto corrige movimento ENTRE volumes. Artefato de movimento DENTRO de um único
// volume 3D (ghosting/anéis) não é corrigível por registro — nem no ANTs (exigiria o k-space).

function post(msg, transfer) { self.postMessage(msg, transfer || []) }
function progress(message, frac) { post({ cmd: 'progress', message, frac }) }

const R_REPORT_MM = 80 // raio usado só para RESUMIR rotação como deslocamento (mm) no relatório

/** winsoriza [q0.001, q0.999] e reescala para [0,1], como o PreprocessImage do antsMotionCorr */
function winsorize(img) {
  const sorted = Float32Array.from(img).sort()
  const lo = sorted[Math.floor(0.001 * (sorted.length - 1))]
  const hi = sorted[Math.floor(0.999 * (sorted.length - 1))]
  const out = new Float32Array(img.length)
  const sc = hi > lo ? 1 / (hi - lo) : 0
  for (let i = 0; i < img.length; i++) {
    const v = img[i] < lo ? lo : img[i] > hi ? hi : img[i]
    out[i] = (v - lo) * sc
  }
  return out
}

// ---------------------------------------------------------------- pirâmide: média de blocos s×s×s
function shrinkVolume(img, dims, s) {
  if (s <= 1) return { img, dims: [...dims] }
  const [nx, ny, nz] = dims
  const sx = Math.max(1, Math.floor(nx / s)), sy = Math.max(1, Math.floor(ny / s)), sz = Math.max(1, Math.floor(nz / s))
  const out = new Float32Array(sx * sy * sz)
  const cnt = new Float32Array(sx * sy * sz)
  for (let z = 0; z < nz; z++) {
    const zz = Math.min(sz - 1, (z / s) | 0)
    for (let y = 0; y < ny; y++) {
      const yy = Math.min(sy - 1, (y / s) | 0)
      for (let x = 0; x < nx; x++) {
        const xx = Math.min(sx - 1, (x / s) | 0)
        const j = xx + yy * sx + zz * sx * sy
        out[j] += img[x + y * nx + z * nx * ny]; cnt[j]++
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = cnt[i] ? out[i] / cnt[i] : 0
  return { img: out, dims: [sx, sy, sz] }
}

function otsu(img) {
  let mx = -Infinity, mn = Infinity
  for (let i = 0; i < img.length; i++) { const v = img[i]; if (v > mx) mx = v; if (v < mn) mn = v }
  const nb = 256, hist = new Float64Array(nb)
  const sc = (nb - 1) / (mx - mn || 1)
  for (let i = 0; i < img.length; i++) hist[Math.round((img[i] - mn) * sc)]++
  let sumAll = 0
  for (let b = 0; b < nb; b++) sumAll += b * hist[b]
  let wB = 0, sumB = 0, best = 0, thr = 0
  for (let b = 0; b < nb; b++) {
    wB += hist[b]; if (!wB) continue
    const wF = img.length - wB; if (!wF) break
    sumB += b * hist[b]
    const mB = sumB / wB, mF = (sumAll - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; thr = b }
  }
  return mn + thr / sc
}

// ---------------------------------------------------------------- transformada rígida
/** matriz de rotação ZYX a partir de (rx,ry,rz) rad */
function rotMatrix(rx, ry, rz) {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz)
  return [
    cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz,
    cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz,
    -sy, sx * cy, cx * cy
  ]
}

/** amostra trilinear em coordenadas de voxel; fora do volume → NaN */
function sample(img, dims, x, y, z) {
  const [nx, ny, nz] = dims
  if (x < 0 || y < 0 || z < 0 || x > nx - 1 || y > ny - 1 || z > nz - 1) return NaN
  const x0 = Math.min(nx - 2, Math.floor(x)), y0 = Math.min(ny - 2, Math.floor(y)), z0 = Math.min(nz - 2, Math.floor(z))
  const tx = x - x0, ty = y - y0, tz = z - z0
  const i = (X, Y, Z) => img[X + Y * nx + Z * nx * ny]
  return (
    (i(x0, y0, z0) * (1 - tx) + i(x0 + 1, y0, z0) * tx) * (1 - ty) * (1 - tz) +
    (i(x0, y0 + 1, z0) * (1 - tx) + i(x0 + 1, y0 + 1, z0) * tx) * ty * (1 - tz) +
    (i(x0, y0, z0 + 1) * (1 - tx) + i(x0 + 1, y0, z0 + 1) * tx) * (1 - ty) * tz +
    (i(x0, y0 + 1, z0 + 1) * (1 - tx) + i(x0 + 1, y0 + 1, z0 + 1) * tx) * ty * tz
  )
}

// ---------------------------------------------------------------- métricas
/** prepara amostras da referência (coordenadas físicas mm + valores) sobre a máscara Otsu */
function buildSamples(ref, dims, pixdims, stride) {
  const thr = otsu(ref)
  const [nx, ny, nz] = dims
  const pts = [], vals = []
  for (let z = 0; z < nz; z += stride) for (let y = 0; y < ny; y += stride) for (let x = 0; x < nx; x += stride) {
    const v = ref[x + y * nx + z * nx * ny]
    if (v > thr) { pts.push(x * pixdims[0], y * pixdims[1], z * pixdims[2]); vals.push(v) }
  }
  return { pts: Float32Array.from(pts), vals: Float32Array.from(vals) }
}

/** custo (menor = melhor) da transformada p sobre as amostras; métrica 'mi' ou 'ncc' */
function cost(params, samples, mov, mdims, pixdims, center, metric) {
  const [tx, ty, tz, rx, ry, rz] = params
  const R = rotMatrix(rx, ry, rz)
  const { pts, vals } = samples
  const n = vals.length
  const [cx, cy, cz] = center
  // MI de Mattes (32 bins) ou NCC global
  const NB = 32
  let joint = null, hf = null, hm = null
  let sF = 0, sM = 0, sFF = 0, sMM = 0, sFM = 0, used = 0
  // faixas dos histogramas (estimadas na primeira chamada por métrica ficam a cargo do chamador:
  // usa-se min/máx dos valores fixos e uma passada rápida no volume móvel)
  if (metric === 'mi') { joint = new Float64Array(NB * NB); hf = new Float64Array(NB); hm = new Float64Array(NB) }
  const fLo = samples.fLo, fSc = samples.fSc, mLo = samples.mLo, mSc = samples.mSc
  for (let k = 0; k < n; k++) {
    const px = pts[k * 3] - cx, py = pts[k * 3 + 1] - cy, pz = pts[k * 3 + 2] - cz
    const qx = R[0] * px + R[1] * py + R[2] * pz + cx + tx
    const qy = R[3] * px + R[4] * py + R[5] * pz + cy + ty
    const qz = R[6] * px + R[7] * py + R[8] * pz + cz + tz
    const mv = sample(mov, mdims, qx / pixdims[0], qy / pixdims[1], qz / pixdims[2])
    if (Number.isNaN(mv)) continue
    const fv = vals[k]
    used++
    if (metric === 'mi') {
      const bf = Math.max(0, Math.min(NB - 1, Math.floor((fv - fLo) * fSc)))
      const bm = Math.max(0, Math.min(NB - 1, Math.floor((mv - mLo) * mSc)))
      joint[bf * NB + bm]++; hf[bf]++; hm[bm]++
    } else {
      sF += fv; sM += mv; sFF += fv * fv; sMM += mv * mv; sFM += fv * mv
    }
  }
  if (used < n * 0.25) return 1e9 // saiu demais do campo de visão
  if (metric === 'mi') {
    let mi = 0
    for (let a = 0; a < NB; a++) for (let b = 0; b < NB; b++) {
      const pj = joint[a * NB + b] / used
      if (pj > 0) mi += pj * Math.log(pj / ((hf[a] / used) * (hm[b] / used)))
    }
    return -mi
  }
  const covFM = sFM / used - (sF / used) * (sM / used)
  const vF = sFF / used - (sF / used) ** 2, vM = sMM / used - (sM / used) ** 2
  if (vF <= 0 || vM <= 0) return 1e9
  return -(covFM / Math.sqrt(vF * vM)) // −NCC
}

/** registro rígido da imagem móvel à referência, multirresolução, busca local coordenada */
function rigidRegister(ref, mov, dims, pixdims, options, tag) {
  const metric = options.metric || 'mi'
  const levels = [
    { shrink: 4, stride: 1, step0: 4, minStep: 0.25, maxIter: 60 },
    { shrink: 2, stride: 2, step0: 1, minStep: 0.1, maxIter: 40 }
  ]
  // inicialização por momentos (como o itkImageMomentsCalculator do antsMotionCorr):
  // translação inicial = COG(móvel) − COG(fixa)
  const cogF = centerOfMass(ref, dims, pixdims)
  const cogM = centerOfMass(mov, dims, pixdims)
  let params = [cogM[0] - cogF[0], cogM[1] - cogF[1], cogM[2] - cogF[2], 0, 0, 0]
  for (const lv of levels) {
    const rs = shrinkVolume(ref, dims, lv.shrink)
    const ms = shrinkVolume(mov, dims, lv.shrink)
    const pd = pixdims.map((p) => p * lv.shrink)
    const samples = buildSamples(rs.img, rs.dims, pd, lv.stride)
    if (samples.vals.length < 200) continue
    // faixas dos histogramas para a MI
    let fLo = Infinity, fHi = -Infinity
    for (const v of samples.vals) { if (v < fLo) fLo = v; if (v > fHi) fHi = v }
    let mLo = Infinity, mHi = -Infinity
    for (let i = 0; i < ms.img.length; i += 7) { const v = ms.img[i]; if (v < mLo) mLo = v; if (v > mHi) mHi = v }
    samples.fLo = fLo; samples.fSc = 31.999 / Math.max(1e-6, fHi - fLo)
    samples.mLo = mLo; samples.mSc = 31.999 / Math.max(1e-6, mHi - mLo)
    // centro de massa da referência (mm)
    let cx = 0, cy = 0, cz = 0, cw = 0
    for (let k = 0; k < samples.vals.length; k++) { const w = samples.vals[k]; cx += samples.pts[k * 3] * w; cy += samples.pts[k * 3 + 1] * w; cz += samples.pts[k * 3 + 2] * w; cw += w }
    const center = [cx / cw, cy / cw, cz / cw]
    // escalas físicas (RegistrationParameterScalesFromPhysicalShift do ANTs): o passo de rotação
    // é o passo em mm dividido pelo maior raio dos pontos amostrados em torno do centro,
    // de modo que cada passo produza no máximo ~step mm de deslocamento físico
    let rMax = 1
    for (let k = 0; k < samples.vals.length; k++) {
      const d = Math.hypot(samples.pts[k * 3] - center[0], samples.pts[k * 3 + 1] - center[1], samples.pts[k * 3 + 2] - center[2])
      if (d > rMax) rMax = d
    }
    const evalCost = (p) => cost(p, samples, ms.img, ms.dims, pd, center, metric)
    let best = evalCost(params)
    let step = lv.step0
    for (let it = 0; it < lv.maxIter && step >= lv.minStep; it++) {
      let improved = false
      for (let d = 0; d < 6; d++) {
        const delta = d < 3 ? step : step / rMax
        for (const sgn of [1, -1]) {
          const trial = params.slice()
          trial[d] += sgn * delta
          const c = evalCost(trial)
          if (c < best - 1e-9) { best = c; params = trial; improved = true; break }
        }
      }
      if (!improved) step /= 2
    }
    progress(`${tag}: nível shrink ${lv.shrink} — custo ${best.toFixed(4)}`, null)
  }
  return params
}

/** reamostra o volume móvel com a transformada rígida (trilinear), fora do FOV = 0 */
function resampleRigid(mov, dims, pixdims, params, center) {
  const [nx, ny, nz] = dims
  const [tx, ty, tz, rx, ry, rz] = params
  const R = rotMatrix(rx, ry, rz)
  const out = new Float32Array(mov.length)
  const [cx, cy, cz] = center
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const px = x * pixdims[0] - cx, py = y * pixdims[1] - cy, pz = z * pixdims[2] - cz
    const qx = (R[0] * px + R[1] * py + R[2] * pz + cx + tx) / pixdims[0]
    const qy = (R[3] * px + R[4] * py + R[5] * pz + cy + ty) / pixdims[1]
    const qz = (R[6] * px + R[7] * py + R[8] * pz + cz + tz) / pixdims[2]
    const v = sample(mov, dims, qx, qy, qz)
    out[x + y * nx + z * nx * ny] = Number.isNaN(v) ? 0 : v
  }
  return out
}

function centerOfMass(img, dims, pixdims) {
  const [nx, ny, nz] = dims
  let cx = 0, cy = 0, cz = 0, cw = 0
  for (let z = 0; z < nz; z += 2) for (let y = 0; y < ny; y += 2) for (let x = 0; x < nx; x += 2) {
    const w = img[x + y * nx + z * nx * ny]
    if (w > 0) { cx += x * w; cy += y * w; cz += z * w; cw += w }
  }
  return cw ? [cx / cw * pixdims[0], cy / cw * pixdims[1], cz / cw * pixdims[2]] : [nx / 2 * pixdims[0], ny / 2 * pixdims[1], nz / 2 * pixdims[2]]
}

// ---------------------------------------------------------------- entrada
self.onmessage = (e) => {
  const { volumes, dims, pixdims, options } = e.data
  try {
    const t0 = Date.now()
    const opt = options || {}
    const nVol = volumes.length
    if (nVol < 2) throw new Error('correção de movimento requer pelo menos 2 volumes')
    const vols = volumes.map((v) => new Float32Array(v))
    // o registro usa cópias winsorizadas [0,001–0,999]→[0,1] (PreprocessImage do antsMotionCorr);
    // a reamostragem final usa as intensidades originais
    const regVols = vols.map(winsorize)
    const n = dims[0] * dims[1] * dims[2]
    const log = [`${nVol} volumes ${dims.join('×')} — métrica ${opt.metric || 'mi'} (rígido 6-DOF, 2 passadas, winsorização 0,1–99,9 %)`]
    // passada 1: referência = volume 0; passada 2: referência = média alinhada (como -u 1 do antsMotionCorr)
    let reference = vols[0]
    let refReg = regVols[0]
    let paramsAll = vols.map(() => [0, 0, 0, 0, 0, 0])
    for (let pass = 0; pass < 2; pass++) {
      const aligned = new Array(nVol)
      for (let v = 0; v < nVol; v++) {
        progress(`Passada ${pass + 1}/2 — volume ${v + 1}/${nVol}: registro rígido…`, (pass * nVol + v) / (2 * nVol))
        if (pass === 0 && v === 0) { aligned[0] = vols[0]; continue }
        const p = rigidRegister(refReg, regVols[v], dims, pixdims, opt, `vol ${v + 1}`)
        paramsAll[v] = p
        const center = centerOfMass(refReg, dims, pixdims)
        aligned[v] = resampleRigid(vols[v], dims, pixdims, p, center)
      }
      // média dos alinhados vira a nova referência
      const mean = new Float32Array(n)
      for (const a of aligned) for (let i = 0; i < n; i++) mean[i] += a[i] / nVol
      reference = mean
      refReg = winsorize(mean)
    }
    // resultado: média final + parâmetros por volume
    const params = paramsAll.map((p, v) => ({
      volume: v + 1,
      tx_mm: p[0], ty_mm: p[1], tz_mm: p[2],
      rx_deg: p[3] * 180 / Math.PI, ry_deg: p[4] * 180 / Math.PI, rz_deg: p[5] * 180 / Math.PI,
      displacement_mm: Math.hypot(p[0], p[1], p[2]) + R_REPORT_MM * Math.hypot(p[3], p[4], p[5])
    }))
    const meanDisp = params.reduce((s, p) => s + p.displacement_mm, 0) / Math.max(1, nVol - 1)
    log.push(`deslocamento médio (translação + ${R_REPORT_MM} mm × rotação): ${meanDisp.toFixed(2)} mm`)
    post({ cmd: 'done', img: reference, params, meanDisplacement: meanDisp, log, elapsed_ms: Date.now() - t0 }, [reference.buffer])
  } catch (err) {
    post({ cmd: 'error', message: err.message || String(err) })
  }
}
