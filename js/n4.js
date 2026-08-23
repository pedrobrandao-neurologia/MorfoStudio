// n4.js — correção de inomogeneidade de campo estilo N4 (N4ITK), reimplementada em JavaScript.
//
// Segue o algoritmo do itkN4BiasFieldCorrectionImageFilter (ITK), usado pelo ANTs em
// Examples/N4BiasFieldCorrection.cxx (Tustison et al., IEEE TMI 2010):
//   1. máscara (Otsu) e transformação para log-intensidade; subamostragem (shrink factor);
//   2. a cada iteração, "afia" o histograma da log-intensidade por deconvolução de Wiener
//      com um kernel gaussiano (FWHM do viés) e calcula o valor esperado E[u|v] da
//      intensidade verdadeira dado o valor observado;
//   3. o resíduo v − E[u|v] é aproximado por um campo suave de B-splines cúbicas
//      (aproximação de dados dispersos de Lee, Wolberg & Shin 1997, como no
//      itkBSplineScatteredDataPointSetToImageFilter), acumulado no campo total;
//   4. converge quando o coeficiente de variação do campo incremental fica abaixo do
//      limiar; a grade de controle é refinada (dobrada) a cada nível;
//   5. o campo é reconstruído na resolução original e a imagem é dividida por exp(campo).
//
// Diferenças deliberadas em relação ao ITK (documentadas no README):
//   • as convoluções do histograma são feitas no domínio direto (200 bins → custo trivial),
//     exceto a deconvolução de Wiener, que usa uma FFT radix-2 própria;
//   • a reconstrução final do campo usa interpolação trilinear do campo suave subamostrado
//     (o campo é, por construção, de baixa frequência).

// ---------------------------------------------------------------- FFT radix-2 (real→complexo)
function fft(re, im, invert) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (invert ? 2 : -2) * Math.PI / len
    const wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k]
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr
        re[i + k] = ur + vr; im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi
        const nwr = cwr * wr - cwi * wi
        cwi = cwr * wi + cwi * wr; cwr = nwr
      }
    }
  }
  if (invert) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n }
}

// ---------------------------------------------------------------- afiamento do histograma (SharpenImage do ITK)
/**
 * Para as log-intensidades mascaradas, devolve uma função v → E[u|v].
 * @param {Float32Array} vals log-intensidades dos voxels na máscara
 * @param {object} p {nBins, fwhm, wienerNoise}
 */
function sharpenMapping(vals, { nBins = 200, fwhm = 0.15, wienerNoise = 0.01 }) {
  let mn = Infinity, mx = -Infinity
  for (let i = 0; i < vals.length; i++) { const v = vals[i]; if (v < mn) mn = v; if (v > mx) mx = v }
  if (!(mx > mn)) return { map: (v) => v, mn, mx }
  const slope = (mx - mn) / (nBins - 1)
  // histograma com atribuição linear (triangular), como no ITK
  const H = new Float64Array(nBins)
  for (let i = 0; i < vals.length; i++) {
    const c = (vals[i] - mn) / slope
    const i0 = Math.floor(c), f = c - i0
    if (i0 >= 0 && i0 < nBins) H[i0] += 1 - f
    if (i0 + 1 < nBins) H[i0 + 1] += f
  }
  // FFT com padding para potência de 2 (≥ 2·nBins para evitar wrap-around)
  let pad = 1
  while (pad < 2 * nBins) pad <<= 1
  const Vr = new Float64Array(pad), Vi = new Float64Array(pad)
  Vr.set(H)
  fft(Vr, Vi, false)
  // kernel gaussiano do viés, com wrap (centrado no bin 0), σ em unidades de bin
  const sigma = fwhm / (2 * Math.sqrt(2 * Math.log(2))) / slope
  const Fr = new Float64Array(pad), Fi = new Float64Array(pad)
  let ksum = 0
  for (let i = 0; i < pad; i++) {
    const d = i <= pad / 2 ? i : i - pad
    const g = Math.exp(-(d * d) / (2 * sigma * sigma))
    Fr[i] = g; ksum += g
  }
  for (let i = 0; i < pad; i++) Fr[i] /= ksum
  fft(Fr, Fi, false)
  // deconvolução de Wiener: Û = V · conj(F) / (|F|² + ruído)
  const Ur = new Float64Array(pad), Ui = new Float64Array(pad)
  for (let i = 0; i < pad; i++) {
    const den = Fr[i] * Fr[i] + Fi[i] * Fi[i] + wienerNoise
    Ur[i] = (Vr[i] * Fr[i] + Vi[i] * Fi[i]) / den
    Ui[i] = (Vi[i] * Fr[i] - Vr[i] * Fi[i]) / den
  }
  fft(Ur, Ui, true)
  const fU = new Float64Array(nBins)
  for (let i = 0; i < nBins; i++) fU[i] = Math.max(0, Ur[i])
  // E[u|v] = conv(u·f(u), G)(v) / conv(f(u), G)(v) — convolução direta (nBins² é barato)
  const u = new Float64Array(nBins)
  for (let i = 0; i < nBins; i++) u[i] = mn + i * slope
  const kHalf = Math.min(nBins - 1, Math.ceil(4 * sigma))
  const kern = new Float64Array(2 * kHalf + 1)
  for (let k = -kHalf; k <= kHalf; k++) kern[k + kHalf] = Math.exp(-(k * k) / (2 * sigma * sigma))
  const num = new Float64Array(nBins), den = new Float64Array(nBins)
  for (let v = 0; v < nBins; v++) {
    let sN = 0, sD = 0
    const k0 = Math.max(0, v - kHalf), k1 = Math.min(nBins - 1, v + kHalf)
    for (let j = k0; j <= k1; j++) {
      const g = kern[j - v + kHalf]
      sN += u[j] * fU[j] * g
      sD += fU[j] * g
    }
    num[v] = sN; den[v] = sD
  }
  const E = new Float64Array(nBins)
  for (let v = 0; v < nBins; v++) E[v] = den[v] > 1e-12 ? num[v] / den[v] : u[v]
  const map = (v) => {
    const c = (v - mn) / slope
    if (c <= 0) return E[0]
    if (c >= nBins - 1) return E[nBins - 1]
    const i0 = Math.floor(c), f = c - i0
    return E[i0] * (1 - f) + E[i0 + 1] * f
  }
  return { map, mn, mx }
}

// ---------------------------------------------------------------- B-spline: aproximação de dados dispersos (Lee et al. 1997)
const bsp = [(t) => ((1 - t) ** 3) / 6, (t) => (3 * t * t * t - 6 * t * t + 4) / 6, (t) => (-3 * t * t * t + 3 * t * t + 3 * t + 1) / 6, (t) => (t * t * t) / 6]

/** tabelas por eixo (índice da célula e 4 pesos cúbicos) para uma grade — evita recomputar bsp() por voxel */
function axisTable(n, ncells) {
  const idx = new Int32Array(n)
  const w = new Float32Array(n * 4)
  for (let x = 0; x < n; x++) {
    const g = (x / Math.max(1, n - 1)) * ncells
    const i = Math.min(ncells - 1, Math.floor(g))
    const t = g - i
    idx[x] = i
    for (let k = 0; k < 4; k++) w[x * 4 + k] = bsp[k](t)
  }
  return { idx, w }
}

/**
 * Ajusta um campo B-spline cúbico ao resíduo nos voxels da máscara (algoritmo BA).
 * Grade de controle com (nc+3) pontos por eixo, nc células. Devolve o lattice de coeficientes.
 * `tables` = { tx, ty, tz } de axisTable() para a grade corrente.
 */
function fitBSpline(residual, maskIdx, dims, ncells, tables) {
  const [nx, ny] = dims
  const ncp = ncells.map((c) => c + 3)
  const phiNum = new Float64Array(ncp[0] * ncp[1] * ncp[2])
  const phiDen = new Float64Array(ncp[0] * ncp[1] * ncp[2])
  const CPX = ncp[0], CPXY = ncp[0] * ncp[1]
  const { tx: TX, ty: TY, tz: TZ } = tables
  for (let m = 0; m < maskIdx.length; m++) {
    const idx = maskIdx[m]
    const z = (idx / (nx * ny)) | 0, y = ((idx / nx) | 0) % ny, x = idx % nx
    const ix = TX.idx[x], iy = TY.idx[y], iz = TZ.idx[z]
    const ox = x * 4, oy = y * 4, oz = z * 4
    // Σ w² para o ponto
    let sw2 = 0
    for (let c = 0; c < 4; c++) for (let b = 0; b < 4; b++) {
      const wbc = TY.w[oy + b] * TZ.w[oz + c]
      for (let a = 0; a < 4; a++) { const w = TX.w[ox + a] * wbc; sw2 += w * w }
    }
    if (sw2 < 1e-12) continue
    const zk = residual[m] / sw2
    for (let c = 0; c < 4; c++) for (let b = 0; b < 4; b++) {
      const wbc = TY.w[oy + b] * TZ.w[oz + c]
      const rowBase = (iy + b) * CPX + (iz + c) * CPXY + ix
      for (let a = 0; a < 4; a++) {
        const w = TX.w[ox + a] * wbc
        const w2 = w * w
        // contribuição BA: φ_kc = w·z/Σw², ponderada por w²
        phiNum[rowBase + a] += w2 * (w * zk)
        phiDen[rowBase + a] += w2
      }
    }
  }
  const phi = new Float64Array(phiNum.length)
  for (let i = 0; i < phi.length; i++) phi[i] = phiDen[i] > 1e-12 ? phiNum[i] / phiDen[i] : 0
  return phi
}

/** avalia o lattice em um voxel usando as tabelas */
function evalLattice(phi, ncells, tables, x, y, z) {
  const CPX = ncells[0] + 3, CPXY = CPX * (ncells[1] + 3)
  const { tx: TX, ty: TY, tz: TZ } = tables
  const ix = TX.idx[x], iy = TY.idx[y], iz = TZ.idx[z]
  const ox = x * 4, oy = y * 4, oz = z * 4
  let s = 0
  for (let c = 0; c < 4; c++) {
    const wz = TZ.w[oz + c]
    for (let b = 0; b < 4; b++) {
      const wy = TY.w[oy + b] * wz
      const rowBase = (iy + b) * CPX + (iz + c) * CPXY + ix
      for (let a = 0; a < 4; a++) s += TX.w[ox + a] * wy * phi[rowBase + a]
    }
  }
  return s
}

// ---------------------------------------------------------------- Otsu (compartilhado)
export function otsuThreshold(img) {
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

// ---------------------------------------------------------------- N4 principal
/**
 * @param {Float32Array} img volume (intensidades ≥ 0)
 * @param {number[]} dims [nx,ny,nz]
 * @param {number[]} pixdims [dx,dy,dz] mm
 * @param {object} opt
 *   shrink (4), maxIterations por nível ([50,50,50,50]), convergence (1e-7),
 *   nBins (200), fwhm (0.15), wienerNoise (0.01), splineDistance (mm, 200 — 1 célula inicial)
 * @param {function} [onProgress] (mensagem, fração)
 * @returns {{img: Float32Array, logField: Float32Array, applied: boolean, log: string[]}}
 */
export function n4BiasCorrect(img, dims, pixdims, opt = {}, onProgress) {
  const o = {
    shrink: opt.shrink ?? 4,
    // o ANTs usa 4 níveis ([50×4]); com 3 a grade final fica em ~50 mm — acima da escala da anatomia,
    // abaixo da escala do viés — e evita que o nível mais fino ajuste estrutura de tecido como se fosse campo
    maxIterations: opt.maxIterations ?? [50, 50, 50],
    // ITK usa 0,001 por padrão; o CLI do ANTs usa 0,0 (roda todas as iterações) — 0,001 poupa tempo no navegador
    convergence: opt.convergence ?? 0.001,
    nBins: opt.nBins ?? 200, fwhm: opt.fwhm ?? 0.15, wienerNoise: opt.wienerNoise ?? 0.01,
    splineDistance: opt.splineDistance ?? 200
  }
  const [nx, ny, nz] = dims
  const log = []
  // ---- máscara Otsu. Nota: sem máscara o N4 do ANTs usa a imagem INTEIRA; a prática recomendada
  // (e o que fazemos aqui) é passar uma máscara de primeiro plano — equivalente a -x com Otsu.
  const thr = otsuThreshold(img)
  // ---- subamostragem por média, POR EIXO: o ANTs usa fator fixo 4 (pensado para 1 mm isotrópico);
  // aqui o fator de cada eixo mira ~`shrink` mm efetivos (cap 4), o que evita blocos de 8–20 mm
  // em exames de voxel grosso/anisotrópico — blocos grandes criam volume parcial que contamina o ajuste
  const targetMM = Math.max(1, o.shrink) // interpreta `shrink` como alvo em mm (4 ≈ comportamento ANTs em 1 mm)
  const sAxis = pixdims.map((p) => Math.max(1, Math.min(4, Math.round(targetMM / Math.max(0.1, p)))))
  const sd = [Math.max(1, Math.floor(nx / sAxis[0])), Math.max(1, Math.floor(ny / sAxis[1])), Math.max(1, Math.floor(nz / sAxis[2]))]
  const [sx, sy, sz] = sd
  const sub = new Float32Array(sx * sy * sz)
  const subN = new Float32Array(sx * sy * sz)
  const subSq = new Float32Array(sx * sy * sz)
  const subAbove = new Float32Array(sx * sy * sz) // nº de voxels do bloco acima do limiar
  for (let z = 0; z < nz; z++) {
    const zz = Math.min(sz - 1, (z / sAxis[2]) | 0)
    for (let y = 0; y < ny; y++) {
      const yy = Math.min(sy - 1, (y / sAxis[1]) | 0)
      for (let x = 0; x < nx; x++) {
        const xx = Math.min(sx - 1, (x / sAxis[0]) | 0)
        const j = xx + yy * sx + zz * sx * sy
        const v = img[x + y * nx + z * nx * ny]
        sub[j] += v; subSq[j] += v * v; subN[j]++
        if (v > thr) subAbove[j]++
      }
    }
  }
  for (let i = 0; i < sub.length; i++) sub[i] = subN[i] ? sub[i] / subN[i] : 0
  // ---- log-intensidade nos voxels da máscara. Dois filtros de pureza do bloco (o volume parcial
  // criado pela subamostragem contaminaria o histograma e o ajuste do campo):
  //  1. ≥ 90 % dos voxels do bloco acima do limiar de fundo (exclui borda cérebro/fundo);
  //  2. coeficiente de variação interno do bloco ≤ maskPurityCV (exclui blocos que misturam
  //     classes de tecido, ex. casca GM/SB). A máscara alimenta só o AJUSTE; o campo suave
  //     é avaliado em todo o volume, então excluir blocos mistos não perde cobertura.
  const purityCV = o.maskPurityCV ?? 0.12
  const maskIdx = []
  for (let i = 0; i < sub.length; i++) {
    if (!(sub[i] > thr && sub[i] > 0 && subAbove[i] >= 0.9 * subN[i])) continue
    const varB = Math.max(0, subSq[i] / subN[i] - sub[i] * sub[i])
    if (subN[i] > 1 && Math.sqrt(varB) / sub[i] > purityCV) continue
    maskIdx.push(i)
  }
  if (maskIdx.length < 500) return { img, logField: null, applied: false, log: ['N4: máscara insuficiente, etapa ignorada'] }
  const logV = new Float32Array(maskIdx.length)
  for (let m = 0; m < maskIdx.length; m++) logV[m] = Math.log(sub[maskIdx[m]])
  const logV0 = Float32Array.from(logV)
  // campo total acumulado em TODO o subvolume (soma exata dos campos incrementais suaves,
  // como o lattice acumulado do ITK — nunca é reajustado, apenas somado)
  const fieldSub = new Float32Array(sx * sy * sz)
  // ---- células iniciais da grade: 1 célula por splineDistance mm (mínimo 1), por eixo
  const mmSub = [pixdims[0] * (nx / sx), pixdims[1] * (ny / sy), pixdims[2] * (nz / sz)]
  let ncells = sd.map((n, a) => Math.max(1, Math.round((n * mmSub[a]) / o.splineDistance)))
  const residual = new Float32Array(maskIdx.length)
  const maskField = new Float32Array(maskIdx.length) // campo total acumulado nos voxels da máscara
  let totalIter = 0
  for (let level = 0; level < o.maxIterations.length; level++) {
    // tabelas de pesos por eixo e lattice acumulado deste nível (grade constante dentro do nível,
    // então os lattices incrementais somam-se coeficiente a coeficiente — como no ITK)
    const tables = { tx: axisTable(sx, ncells[0]), ty: axisTable(sy, ncells[1]), tz: axisTable(sz, ncells[2]) }
    const ncp = (ncells[0] + 3) * (ncells[1] + 3) * (ncells[2] + 3)
    const levelPhi = new Float64Array(ncp)
    let converged = false
    for (let it = 0; it < o.maxIterations[level] && !converged; it++) {
      // 1. afiamento do histograma → E[u|v]
      const { map } = sharpenMapping(logV, o)
      // 2. resíduo = v − E[u|v]
      for (let m = 0; m < logV.length; m++) residual[m] = logV[m] - map(logV[m])
      // 3. ajuste B-spline do resíduo → lattice incremental, somado ao do nível
      const phi = fitBSpline(residual, maskIdx, sd, ncells, tables)
      for (let i = 0; i < ncp; i++) levelPhi[i] += phi[i]
      // 4. atualiza log-intensidades na máscara; convergência = CV de exp(incremento) (como o ITK)
      let sum = 0, sum2 = 0
      for (let m = 0; m < maskIdx.length; m++) {
        const idx = maskIdx[m]
        const z = (idx / (sx * sy)) | 0, y = ((idx / sx) | 0) % sy, x = idx % sx
        const f = evalLattice(phi, ncells, tables, x, y, z)
        maskField[m] += f
        logV[m] = logV0[m] - maskField[m]
        const e = Math.exp(f)
        sum += e; sum2 += e * e
      }
      const meanE = sum / maskIdx.length
      const cv = Math.sqrt(Math.max(0, sum2 / maskIdx.length - meanE * meanE)) / meanE
      totalIter++
      if (cv < o.convergence) converged = true
      if (onProgress && (totalIter % 5 === 0)) onProgress(`N4: nível ${level + 1}/${o.maxIterations.length}, iteração ${it + 1} (CV ${cv.toExponential(1)})`, (level + it / o.maxIterations[level]) / o.maxIterations.length)
    }
    // campo do nível avaliado uma única vez em todo o subvolume
    for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) {
      fieldSub[x + y * sx + z * sx * sy] += evalLattice(levelPhi, ncells, tables, x, y, z)
    }
    log.push(`N4 nível ${level + 1}: grade ${ncells.join('×')} células${converged ? ', convergiu' : ''}`)
    ncells = ncells.map((c) => c * 2) // refinamento multinível (dobra a grade)
  }
  // ---- reconstrução na resolução original (trilinear do campo de baixa frequência) e aplicação
  const out = new Float32Array(img.length)
  const logField = new Float32Array(img.length)
  const fx = (sx - 1) / Math.max(1, nx - 1), fy = (sy - 1) / Math.max(1, ny - 1), fz = (sz - 1) / Math.max(1, nz - 1)
  for (let z = 0; z < nz; z++) {
    const gz = z * fz, z0 = Math.min(sz - 2, Math.floor(gz)), tz = sz > 1 ? gz - z0 : 0
    for (let y = 0; y < ny; y++) {
      const gy = y * fy, y0 = Math.min(sy - 2, Math.floor(gy)), ty = sy > 1 ? gy - y0 : 0
      for (let x = 0; x < nx; x++) {
        const gx = x * fx, x0 = Math.min(sx - 2, Math.floor(gx)), tx = sx > 1 ? gx - x0 : 0
        const c000 = fieldSub[x0 + y0 * sx + z0 * sx * sy], c100 = fieldSub[Math.min(sx - 1, x0 + 1) + y0 * sx + z0 * sx * sy]
        const c010 = fieldSub[x0 + Math.min(sy - 1, y0 + 1) * sx + z0 * sx * sy], c110 = fieldSub[Math.min(sx - 1, x0 + 1) + Math.min(sy - 1, y0 + 1) * sx + z0 * sx * sy]
        const zi = Math.min(sz - 1, z0 + 1)
        const c001 = fieldSub[x0 + y0 * sx + zi * sx * sy], c101 = fieldSub[Math.min(sx - 1, x0 + 1) + y0 * sx + zi * sx * sy]
        const c011 = fieldSub[x0 + Math.min(sy - 1, y0 + 1) * sx + zi * sx * sy], c111 = fieldSub[Math.min(sx - 1, x0 + 1) + Math.min(sy - 1, y0 + 1) * sx + zi * sx * sy]
        const f =
          (c000 * (1 - tx) + c100 * tx) * (1 - ty) * (1 - tz) +
          (c010 * (1 - tx) + c110 * tx) * ty * (1 - tz) +
          (c001 * (1 - tx) + c101 * tx) * (1 - ty) * tz +
          (c011 * (1 - tx) + c111 * tx) * ty * tz
        const i = x + y * nx + z * nx * ny
        logField[i] = f
        const v = img[i]
        out[i] = v > 0 ? v / Math.exp(f) : v
      }
    }
  }
  log.push(`N4: ${totalIter} iterações no total (shrink ${sAxis.join('×')}, FWHM ${o.fwhm}, ruído ${o.wienerNoise}, ${o.nBins} bins)`)
  return { img: out, logField, applied: true, log }
}
