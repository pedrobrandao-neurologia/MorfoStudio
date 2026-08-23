// hippocampus-worker.js — análise hipocampal em subregiões (cabeça / corpo / cauda) no navegador.
//
// Pipeline inspirado nas ferramentas de referência (ver README, seção "Segmentação hipocampal"):
//  1. Localização da ROI a partir da segmentação de cérebro inteiro (análogo ao ROILoc do HSF e ao
//     crop inicial do HippUnfold): caixa envolvente do rótulo "Hippocampus" por hemisfério, com margem.
//  2. Refinamento clássico da máscara (análogo, em versão não-bayesiana, à etapa de ajuste por
//     intensidade do FreeSurfer segmentHA): modelo de intensidade robusto (mediana ± k·MAD) estimado
//     dentro do rótulo, crescimento geodésico limitado a rótulos "reivindicáveis" (córtex adjacente),
//     remoção de outliers, fechamento morfológico, preenchimento de cavidades e maior componente conexo.
//  3. Sistema de coordenadas longitudinal por equação de Laplace (núcleo metodológico do HippUnfold):
//     ∇²φ = 0 no interior da máscara, com φ=0 na extremidade anterior e φ=1 na posterior (condições de
//     Dirichlet nas "tampas" definidas pelo eixo principal), Neumann na borda lateral. Resolvido por
//     Jacobi com inicialização pela projeção no eixo principal (PCA).
//  4. Reparametrização por comprimento de arco: φ é harmônica, não linear em distância; o campo é
//     convertido em fração do comprimento geodésico do eixo central (polilinha de centroides por bin).
//  5. Parcelamento cabeça/corpo/cauda por frações do comprimento de arco (convenção de marcos de
//     Poppenk et al. 2013 aproximada em frações médias; ajustável nas opções).
//  6. Morfometria: volumes, comprimento do eixo, área de secção média, diâmetro equivalente, área de
//     superfície voxelizada, esfericidade, contraste de borda (QC) e índices de assimetria.
//
// Importante: em T1 ~1 mm NÃO há contraste para delinear subcampos (CA1–CA4, GD, subículo) com
// segurança — isso exige T2 coronal fino (ASHS) ou modelos treinados dedicados (HippUnfold, HSF).
// Por isso este módulo entrega subREGIÕES ao longo do eixo longitudinal, não subCAMPOS.

function post(msg, transfer) { self.postMessage(msg, transfer || []) }
function progress(message, frac) { post({ cmd: 'progress', message, frac }) }

// ---------------------------------------------------------------- utilidades de grade
const NB6 = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]

function mat4mul(a, x, y, z) {
  return [
    a[0] * x + a[1] * y + a[2] * z + a[3],
    a[4] * x + a[5] * y + a[6] * z + a[7],
    a[8] * x + a[9] * y + a[10] * z + a[11]
  ]
}

/** mediana e MAD (desvio absoluto mediano) de um array numérico */
function medianMAD(values) {
  const v = Float32Array.from(values).sort()
  const med = v.length ? v[v.length >> 1] : 0
  const dev = Float32Array.from(v, (x) => Math.abs(x - med)).sort()
  const mad = dev.length ? dev[dev.length >> 1] : 0
  return { median: med, mad, sigma: 1.4826 * mad } // σ robusto (equivalente gaussiano)
}

/** percentil simples (0–1) de um Float32Array já ordenado */
function pctl(sorted, p) { return sorted[Math.max(0, Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1))))] }

// ---------------------------------------------------------------- componentes conexos 26-viz (subvolume)
function largestComponent(mask, dims) {
  const [nx, ny, nz] = dims
  const n = nx * ny * nz
  const comp = new Int32Array(n).fill(-1)
  const stack = new Int32Array(n)
  let best = -1, bestSize = 0, nComp = 0
  for (let seed = 0; seed < n; seed++) {
    if (!mask[seed] || comp[seed] >= 0) continue
    let top = 0, size = 0
    stack[top++] = seed; comp[seed] = nComp
    while (top) {
      const idx = stack[--top]; size++
      const z = (idx / (nx * ny)) | 0, y = ((idx / nx) | 0) % ny, x = idx % nx
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy && !dz) continue
        const X = x + dx, Y = y + dy, Z = z + dz
        if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue
        const j = X + Y * nx + Z * nx * ny
        if (mask[j] && comp[j] < 0) { comp[j] = nComp; stack[top++] = j }
      }
    }
    if (size > bestSize) { bestSize = size; best = nComp }
    nComp++
  }
  if (nComp > 1) for (let i = 0; i < n; i++) if (mask[i] && comp[i] !== best) mask[i] = 0
  return { removedComponents: Math.max(0, nComp - 1), keptVoxels: bestSize }
}

/** preenche cavidades internas: componentes 6-viz do fundo que não tocam a borda do subvolume */
function fillCavities(mask, dims) {
  const [nx, ny, nz] = dims
  const n = nx * ny * nz
  const outside = new Uint8Array(n)
  const stack = new Int32Array(n)
  let top = 0
  const push = (x, y, z) => {
    const i = x + y * nx + z * nx * ny
    if (!mask[i] && !outside[i]) { outside[i] = 1; stack[top++] = i }
  }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { push(x, y, 0); push(x, y, nz - 1) }
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { push(x, 0, z); push(x, ny - 1, z) }
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) { push(0, y, z); push(nx - 1, y, z) }
  while (top) {
    const idx = stack[--top]
    const z = (idx / (nx * ny)) | 0, y = ((idx / nx) | 0) % ny, x = idx % nx
    for (const [dx, dy, dz] of NB6) {
      const X = x + dx, Y = y + dy, Z = z + dz
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue
      const j = X + Y * nx + Z * nx * ny
      if (!mask[j] && !outside[j]) { outside[j] = 1; stack[top++] = j }
    }
  }
  let filled = 0
  for (let i = 0; i < n; i++) if (!mask[i] && !outside[i]) { mask[i] = 1; filled++ }
  return filled
}

/** dilatação (delta=1) ou erosão (delta=0 com inversão) 6-viz, uma iteração */
function dilate6(mask, dims) {
  const [nx, ny, nz] = dims
  const out = Uint8Array.from(mask)
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + y * nx + z * nx * ny
    if (mask[i]) continue
    for (const [dx, dy, dz] of NB6) {
      const X = x + dx, Y = y + dy, Z = z + dz
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue
      if (mask[X + Y * nx + Z * nx * ny]) { out[i] = 1; break }
    }
  }
  return out
}
function erode6(mask, dims) {
  const [nx, ny, nz] = dims
  const out = Uint8Array.from(mask)
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + y * nx + z * nx * ny
    if (!mask[i]) continue
    for (const [dx, dy, dz] of NB6) {
      const X = x + dx, Y = y + dy, Z = z + dz
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz || !mask[X + Y * nx + Z * nx * ny]) { out[i] = 0; break }
    }
  }
  return out
}

/** transformada de distância chanfrada 3-4-5 (÷3 ≈ mm em voxel isotrópico de 1 mm) */
function chamferEDT(mask, dims) {
  const [nx, ny, nz] = dims
  const n = nx * ny * nz
  const INF = 1e9
  const d = new Float32Array(n)
  for (let i = 0; i < n; i++) d[i] = mask[i] ? INF : 0
  const w = (dx, dy, dz) => (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) === 1 ? 3 : Math.abs(dx) + Math.abs(dy) + Math.abs(dz) === 2 ? 4 : 5)
  const passes = [
    { z0: 0, z1: nz, dz: 1, y0: 0, y1: ny, dy: 1, x0: 0, x1: nx, dx: 1, back: false },
    { z0: nz - 1, z1: -1, dz: -1, y0: ny - 1, y1: -1, dy: -1, x0: nx - 1, x1: -1, dx: -1, back: true }
  ]
  for (const p of passes) {
    for (let z = p.z0; z !== p.z1; z += p.dz) for (let y = p.y0; y !== p.y1; y += p.dy) for (let x = p.x0; x !== p.x1; x += p.dx) {
      const i = x + y * nx + z * nx * ny
      if (!mask[i]) continue
      let dv = d[i]
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy && !dz) continue
        // metade causal da vizinhança conforme o sentido da varredura
        const ord = dz * 9 + dy * 3 + dx
        if (p.back ? ord <= 0 : ord >= 0) continue
        const X = x + dx, Y = y + dy, Z = z + dz
        if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue
        const cand = d[X + Y * nx + Z * nx * ny] + w(dx, dy, dz)
        if (cand < dv) dv = cand
      }
      d[i] = dv
    }
  }
  for (let i = 0; i < n; i++) if (d[i] >= INF) d[i] = 0
  return d // em unidades de 1/3 de voxel
}

// ---------------------------------------------------------------- análise de um hemisfério
function analyseSide({ side, voxels, labels, intensity, dims, affine, claimable, options, log }) {
  const [NX, NY] = [dims[0], dims[1]]
  const NXY = NX * NY
  const opt = options
  // ---- 1. caixa envolvente com margem (ROI)
  const M = 6
  let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1, y1 = -1, z1 = -1
  for (const idx of voxels) {
    const z = (idx / NXY) | 0, y = ((idx / NX) | 0) % NY, x = idx % NX
    if (x < x0) x0 = x; if (x > x1) x1 = x
    if (y < y0) y0 = y; if (y > y1) y1 = y
    if (z < z0) z0 = z; if (z > z1) z1 = z
  }
  x0 = Math.max(0, x0 - M); y0 = Math.max(0, y0 - M); z0 = Math.max(0, z0 - M)
  x1 = Math.min(dims[0] - 1, x1 + M); y1 = Math.min(dims[1] - 1, y1 + M); z1 = Math.min(dims[2] - 1, z1 + M)
  const bx = x1 - x0 + 1, by = y1 - y0 + 1, bz = z1 - z0 + 1
  const bn = bx * by * bz
  const bdims = [bx, by, bz]
  const gIdx = (i) => { const z = (i / (bx * by)) | 0, y = ((i / bx) | 0) % by, x = i % bx; return (x0 + x) + (y0 + y) * NX + (z0 + z) * NXY }
  // subvolumes locais
  const mask = new Uint8Array(bn)
  const inten = new Float32Array(bn)
  const lab = new Uint8Array(bn)
  for (let i = 0; i < bn; i++) { const g = gIdx(i); inten[i] = intensity[g]; lab[i] = labels[g] }
  for (const idx of voxels) {
    const z = (idx / NXY) | 0, y = ((idx / NX) | 0) % NY, x = idx % NX
    mask[(x - x0) + (y - y0) * bx + (z - z0) * bx * by] = 1
  }
  const rawVoxels = voxels.length

  // ---- 2. refinamento por intensidade (opcional)
  let grown = 0, removedOutliers = 0, filled = 0
  const stats0 = medianMAD(Array.from({ length: bn }, (_, i) => i).filter((i) => mask[i]).map((i) => inten[i]))
  if (opt.refine && stats0.sigma > 0.5) {
    const kGrow = opt.kGrow ?? 2.0
    const kOutlier = opt.kOutlier ?? 3.5
    // crescimento geodésico limitado (2 iterações, 6-viz), apenas sobre rótulos reivindicáveis
    for (let it = 0; it < (opt.growIters ?? 2); it++) {
      const cand = []
      for (let z = 0; z < bz; z++) for (let y = 0; y < by; y++) for (let x = 0; x < bx; x++) {
        const i = x + y * bx + z * bx * by
        if (mask[i] || !claimable.has(lab[i])) continue
        if (Math.abs(inten[i] - stats0.median) > kGrow * stats0.sigma) continue
        for (const [dx, dy, dz] of NB6) {
          const X = x + dx, Y = y + dy, Z = z + dz
          if (X < 0 || Y < 0 || Z < 0 || X >= bx || Y >= by || Z >= bz) continue
          if (mask[X + Y * bx + Z * bx * by]) { cand.push(i); break }
        }
      }
      for (const i of cand) mask[i] = 1
      grown += cand.length
      if (!cand.length) break
    }
    // remoção de outliers (ex.: líquor do corno temporal incluído no rótulo)
    for (let i = 0; i < bn; i++) {
      if (mask[i] && Math.abs(inten[i] - stats0.median) > kOutlier * stats0.sigma) { mask[i] = 0; removedOutliers++ }
    }
    // fechamento morfológico 6-viz (raio 1): operação extensiva, contém a máscara original
    const closed = erode6(dilate6(mask, bdims), bdims)
    mask.set(closed)
  }
  filled = fillCavities(mask, bdims)
  const cc = largestComponent(mask, bdims)
  let nVox = 0; for (let i = 0; i < bn; i++) if (mask[i]) nVox++
  if (nVox < 200) throw new Error(`${side}: máscara final com apenas ${nVox} voxels — hipocampo não confiável nesta segmentação`)
  log.push(`${side}: rótulo ${rawVoxels} vox → refinado ${nVox} vox (+${grown} crescidos, −${removedOutliers} outliers, ${filled} cavidades preenchidas, ${cc.removedComponents} componentes soltos removidos)`)

  // ---- 3. eixo principal (PCA em RAS) e projeção
  const idxs = new Int32Array(nVox)
  { let k = 0; for (let i = 0; i < bn; i++) if (mask[i]) idxs[k++] = i }
  const ras = new Float32Array(nVox * 3)
  let mx = 0, my = 0, mz = 0
  for (let k = 0; k < nVox; k++) {
    const i = idxs[k]
    const z = (i / (bx * by)) | 0, y = ((i / bx) | 0) % by, x = i % bx
    const p = mat4mul(affine, x0 + x, y0 + y, z0 + z)
    ras[k * 3] = p[0]; ras[k * 3 + 1] = p[1]; ras[k * 3 + 2] = p[2]
    mx += p[0]; my += p[1]; mz += p[2]
  }
  mx /= nVox; my /= nVox; mz /= nVox
  // matriz de covariância 3×3 e autovetor dominante por iteração de potência
  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0
  for (let k = 0; k < nVox; k++) {
    const dx = ras[k * 3] - mx, dy = ras[k * 3 + 1] - my, dz = ras[k * 3 + 2] - mz
    cxx += dx * dx; cxy += dx * dy; cxz += dx * dz; cyy += dy * dy; cyz += dy * dz; czz += dz * dz
  }
  let ax = 0, ay = 1, az = 0
  for (let it = 0; it < 60; it++) {
    const nxv = cxx * ax + cxy * ay + cxz * az
    const nyv = cxy * ax + cyy * ay + cyz * az
    const nzv = cxz * ax + cyz * ay + czz * az
    const nrm = Math.hypot(nxv, nyv, nzv) || 1
    ax = nxv / nrm; ay = nyv / nrm; az = nzv / nrm
  }
  // orienta o eixo para anterior (+Y em RAS); o eixo longo hipocampal é sobretudo A–P
  if (ay < 0) { ax = -ax; ay = -ay; az = -az }
  const proj = new Float32Array(nVox)
  for (let k = 0; k < nVox; k++) proj[k] = (ras[k * 3] - mx) * ax + (ras[k * 3 + 1] - my) * ay + (ras[k * 3 + 2] - mz) * az
  const sortedProj = Float32Array.from(proj).sort()
  const pLo = pctl(sortedProj, 0.05), pHi = pctl(sortedProj, 0.95)

  // ---- 4. equação de Laplace: φ=0 na tampa anterior, φ=1 na posterior, Neumann na borda
  const phi = new Float32Array(bn).fill(-1)
  const fixed = new Uint8Array(bn) // 1 = Dirichlet
  for (let k = 0; k < nVox; k++) {
    const i = idxs[k]
    if (proj[k] >= pHi) { phi[i] = 0; fixed[i] = 1 } // anterior (cabeça)
    else if (proj[k] <= pLo) { phi[i] = 1; fixed[i] = 1 } // posterior (cauda)
    else phi[i] = Math.min(1, Math.max(0, 1 - (proj[k] - pLo) / (pHi - pLo || 1)))
  }
  const free = []
  for (let k = 0; k < nVox; k++) if (!fixed[idxs[k]]) free.push(idxs[k])
  // pré-computa vizinhos em-máscara dos voxels livres
  const nbOff = [-1, 1, -bx, bx, -bx * by, bx * by]
  const nbrs = new Int32Array(free.length * 6)
  const nbrN = new Uint8Array(free.length)
  for (let f = 0; f < free.length; f++) {
    const i = free[f]
    const z = (i / (bx * by)) | 0, y = ((i / bx) | 0) % by, x = i % bx
    let c = 0
    for (let q = 0; q < 6; q++) {
      const [dx, dy, dz] = NB6[q]
      const X = x + dx, Y = y + dy, Z = z + dz
      if (X < 0 || Y < 0 || Z < 0 || X >= bx || Y >= by || Z >= bz) continue
      const j = i + nbOff[q]
      if (mask[j]) nbrs[f * 6 + c++] = j
    }
    nbrN[f] = c
  }
  let iters = 0, delta = 1
  // HippUnfold usa Jacobi até SSD < 1e-5 (cap 10 mil iterações); aqui Gauss-Seidel com
  // sobre-relaxação (SOR, ω=1,7) — mesma solução harmônica, convergência bem mais rápida —
  // inicializado pela projeção no eixo principal (papel análogo ao do fast-marching lá)
  const maxIters = opt.laplaceMaxIters ?? 1500, tol = opt.laplaceTol ?? 5e-5
  const omega = opt.laplaceOmega ?? 1.7
  while (iters < maxIters && delta > tol) {
    delta = 0
    for (let f = 0; f < free.length; f++) {
      const c = nbrN[f]
      if (!c) continue
      let s = 0
      for (let q = 0; q < c; q++) s += phi[nbrs[f * 6 + q]]
      const i = free[f]
      const upd = phi[i] + omega * (s / c - phi[i])
      const d = Math.abs(upd - phi[i])
      if (d > delta) delta = d
      phi[i] = upd
    }
    iters++
  }
  log.push(`${side}: Laplace convergiu em ${iters} iterações (Δmáx ${delta.toExponential(1)})`)

  // ---- 5. reparametrização por comprimento de arco do eixo central
  const NBINS = 40
  const binSum = Array.from({ length: NBINS }, () => [0, 0, 0, 0]) // x,y,z,n em RAS
  for (let k = 0; k < nVox; k++) {
    const b = Math.min(NBINS - 1, Math.max(0, Math.floor(phi[idxs[k]] * NBINS)))
    const s = binSum[b]
    s[0] += ras[k * 3]; s[1] += ras[k * 3 + 1]; s[2] += ras[k * 3 + 2]; s[3]++
  }
  const centroids = []
  for (let b = 0; b < NBINS; b++) if (binSum[b][3] > 0) centroids.push({ b, p: [binSum[b][0] / binSum[b][3], binSum[b][1] / binSum[b][3], binSum[b][2] / binSum[b][3]] })
  let axisLength = 0
  const cum = [0]
  for (let c = 1; c < centroids.length; c++) {
    axisLength += Math.hypot(
      centroids[c].p[0] - centroids[c - 1].p[0],
      centroids[c].p[1] - centroids[c - 1].p[1],
      centroids[c].p[2] - centroids[c - 1].p[2])
    cum.push(axisLength)
  }
  // φ (centro do bin) → fração de arco; interpolação linear
  const phiKnots = centroids.map((c) => (c.b + 0.5) / NBINS)
  const sKnots = cum.map((c) => (axisLength > 0 ? c / axisLength : 0))
  const phiToS = (p) => {
    if (p <= phiKnots[0]) return sKnots[0]
    for (let c = 1; c < phiKnots.length; c++) {
      if (p <= phiKnots[c]) {
        const t = (p - phiKnots[c - 1]) / (phiKnots[c] - phiKnots[c - 1] || 1)
        return sKnots[c - 1] + t * (sKnots[c] - sKnots[c - 1])
      }
    }
    return sKnots[sKnots.length - 1]
  }

  // ---- 6. parcelamento cabeça/corpo/cauda + morfometria
  // fallback proporcional da convenção de marcos de Poppenk et al. 2013 (uncal apex / colículos):
  // sem os marcos anatômicos, divide-se o eixo em terços (ver README); frações ajustáveis nas opções
  const headFrac = opt.headFrac ?? 1 / 3, tailFrac = opt.tailFrac ?? 2 / 3
  const partOf = new Uint8Array(bn) // 1 cabeça, 2 corpo, 3 cauda
  const parts = { head: initPart(), body: initPart(), tail: initPart() }
  const edt = chamferEDT(mask, bdims)
  let surfFaces = 0, edgeContrastSum = 0, edgeFaces = 0, maxEDT = 0
  for (let k = 0; k < nVox; k++) {
    const i = idxs[k]
    const s = phiToS(phi[i])
    const part = s < headFrac ? 'head' : s < tailFrac ? 'body' : 'tail'
    partOf[i] = part === 'head' ? 1 : part === 'body' ? 2 : 3
    const P = parts[part]
    P.n++; P.sx += ras[k * 3]; P.sy += ras[k * 3 + 1]; P.sz += ras[k * 3 + 2]
    P.si += inten[i]; P.si2 += inten[i] * inten[i]
    if (edt[i] > maxEDT) maxEDT = edt[i]
    // superfície e contraste de borda (faces 6-viz para fora da máscara)
    const z = (i / (bx * by)) | 0, y = ((i / bx) | 0) % by, x = i % bx
    for (let q = 0; q < 6; q++) {
      const [dx, dy, dz] = NB6[q]
      const X = x + dx, Y = y + dy, Z = z + dz
      if (X < 0 || Y < 0 || Z < 0 || X >= bx || Y >= by || Z >= bz) { surfFaces++; continue }
      const j = i + nbOff[q]
      if (!mask[j]) {
        surfFaces++
        edgeContrastSum += Math.abs(inten[i] - inten[j]); edgeFaces++
      }
    }
  }
  const volume = nVox // 1 mm³/voxel no espaço conformado
  const surface = surfFaces // 1 mm² por face (superestima ~1,5× vs. malha suave; ver README)
  const sphericity = surface > 0 ? (Math.PI ** (1 / 3)) * ((6 * volume) ** (2 / 3)) / surface : null
  const meanXsec = axisLength > 0 ? volume / axisLength : null
  const finish = (P, name, frac0, frac1) => {
    const segLen = axisLength * (frac1 - frac0)
    const mean = P.n ? P.si / P.n : 0
    return {
      part: name, voxels: P.n, volume_mm3: P.n,
      centroid_ras_mm: P.n ? [P.sx / P.n, P.sy / P.n, P.sz / P.n] : null,
      mean_intensity: mean, sd_intensity: P.n ? Math.sqrt(Math.max(0, P.si2 / P.n - mean * mean)) : 0,
      length_mm: segLen, mean_xsec_mm2: segLen > 0 ? P.n / segLen : null,
      eq_diameter_mm: segLen > 0 ? 2 * Math.sqrt(P.n / segLen / Math.PI) : null
    }
  }
  const csum = ['sx', 'sy', 'sz'].map((k) => parts.head[k] + parts.body[k] + parts.tail[k])
  const result = {
    side,
    voxels_label: rawVoxels, voxels_refined: nVox,
    volume_mm3: volume,
    centroid_ras_mm: [csum[0] / nVox, csum[1] / nVox, csum[2] / nVox],
    head: finish(parts.head, 'head', 0, headFrac),
    body: finish(parts.body, 'body', headFrac, tailFrac),
    tail: finish(parts.tail, 'tail', tailFrac, 1),
    axis_length_mm: axisLength,
    axis_direction_ras: [ax, ay, az],
    mean_xsec_mm2: meanXsec,
    eq_diameter_mm: meanXsec != null ? 2 * Math.sqrt(meanXsec / Math.PI) : null,
    max_inscribed_diameter_mm: (2 * maxEDT) / 3,
    surface_mm2: surface, sphericity,
    edge_contrast: edgeFaces ? edgeContrastSum / edgeFaces : null,
    intensity_median: stats0.median, intensity_sigma: stats0.sigma,
    laplace_iters: iters,
    refinement: { grown, removed_outliers: removedOutliers, cavities_filled: filled, components_removed: cc.removedComponents },
    qc_flags: []
  }
  // QC: faixas típicas de adultos no espaço conformado
  if (volume < 1800) result.qc_flags.push('volume abaixo da faixa típica (possível atrofia ou falha de segmentação)')
  if (volume > 6500) result.qc_flags.push('volume acima da faixa típica (possível vazamento da máscara)')
  if (result.edge_contrast != null && result.edge_contrast < 12) result.qc_flags.push('contraste de borda baixo — limites pouco confiáveis neste exame')
  if (axisLength < 25 || axisLength > 65) result.qc_flags.push(`comprimento do eixo atípico (${axisLength.toFixed(0)} mm)`)
  return { result, writeLabels: (out, base) => { for (let k = 0; k < nVox; k++) { const i = idxs[k]; out[gIdx(i)] = base + partOf[i] - 1 } } }
}

function initPart() { return { n: 0, sx: 0, sy: 0, sz: 0, si: 0, si2: 0 } }

// ---------------------------------------------------------------- entrada
self.onmessage = (e) => {
  const { labels, intensity, dims, affine, hippoIds, claimableIds, options } = e.data
  try {
    const t0 = Date.now()
    const opt = options || {}
    const log = []
    const NX = dims[0], NXY = dims[0] * dims[1]
    const hippoSet = new Set([...(hippoIds.left || []), ...(hippoIds.right || []), ...(hippoIds.merged || [])])
    const leftSet = new Set(hippoIds.left || []), rightSet = new Set(hippoIds.right || [])
    const claimable = new Set(claimableIds || [])
    progress('Localizando hipocampos na segmentação…', 0.05)
    // separa voxels por hemisfério: por rótulo L/R quando houver; senão pelo sinal de x em RAS
    const leftVox = [], rightVox = []
    const a = affine
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i]
      if (!hippoSet.has(l)) continue
      if (leftSet.has(l)) leftVox.push(i)
      else if (rightSet.has(l)) rightVox.push(i)
      else {
        const z = (i / NXY) | 0, y = ((i / NX) | 0) % dims[1], x = i % NX
        const rasX = a[0] * x + a[1] * y + a[2] * z + a[3]
        if (rasX < 0) leftVox.push(i); else rightVox.push(i)
      }
    }
    const lateralized = leftSet.size > 0 || rightSet.size > 0
    log.push(`hemisférios por ${lateralized ? 'rótulos L/R do modelo' : 'linha média (x=0 em RAS), aproximado'}`)
    if (leftVox.length < 200 && rightVox.length < 200) throw new Error('a segmentação não contém voxels suficientes de hipocampo — use um modelo aseg/aparc+aseg')
    const out = new Uint8Array(labels.length)
    const sides = {}
    let step = 0
    for (const [name, vox, base] of [['esquerdo', leftVox, 1], ['direito', rightVox, 4]]) {
      if (vox.length < 200) { log.push(`${name}: ${vox.length} voxels — hemisfério ignorado`); continue }
      progress(`Hipocampo ${name}: refinamento e coordenadas de Laplace…`, 0.15 + 0.4 * step)
      const { result, writeLabels } = analyseSide({
        side: name, voxels: vox, labels, intensity, dims, affine,
        claimable, options: opt, log
      })
      writeLabels(out, base)
      sides[name === 'esquerdo' ? 'left' : 'right'] = result
      step++
    }
    // assimetria por subregião
    const asymmetry = {}
    if (sides.left && sides.right) {
      const ai = (L, R) => (L + R > 0 ? (200 * (L - R)) / (L + R) : null)
      asymmetry.total_pct = ai(sides.left.volume_mm3, sides.right.volume_mm3)
      for (const p of ['head', 'body', 'tail']) asymmetry[`${p}_pct`] = ai(sides.left[p].volume_mm3, sides.right[p].volume_mm3)
    }
    progress('Concluído', 1)
    post({
      cmd: 'done',
      labelsOut: out,
      result: {
        method: 'subregiões pelo eixo longitudinal (Laplace + comprimento de arco), refinamento por intensidade',
        options: { headFrac: opt.headFrac ?? 1 / 3, tailFrac: opt.tailFrac ?? 2 / 3, refine: opt.refine !== false },
        lateralized, left: sides.left || null, right: sides.right || null, asymmetry,
        log, elapsed_ms: Date.now() - t0
      }
    }, [out.buffer])
  } catch (err) {
    post({ cmd: 'error', message: err.message || String(err) })
  }
}
