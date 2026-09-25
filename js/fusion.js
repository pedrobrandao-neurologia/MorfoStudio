// fusion.js — fusão "aseg 18 + aparc+aseg 104" no espaço de rótulos do modelo 104.
//
// Motivo (medido contra o FreeSurfer 7 em 3 sujeitos, ver README): o modelo aseg 18 acerta muito mais as
// estruturas subcorticais (Dice médio 0,81; hipocampo com erro de volume ≈ 1 %) e cobre 97,6 % do cérebro,
// enquanto o aparc+aseg 104 tem as parcelas corticais de Desikan–Killiany mas é conservador na borda pial
// (cobre ~84 % do cérebro) e erra mais o subcortical (Dice 0,69). A fusão pega o melhor de cada um:
//   • anatomia (subcortical, ventrículos, cerebelo, tronco, substância branca) do aseg 18, com o lado
//     esquerdo/direito tirado dos rótulos lateralizados do 104 (vizinho lateralizado mais próximo na linha x);
//   • corpo caloso (CC_*) e LCR do 104, que o aseg 18 não tem;
//   • fita cortical do aseg 18 rotulada com as parcelas ctx-* do 104: onde o 104 já tem parcela, mantém;
//     no restante da fita, a parcela chega por propagação geodésica (BFS, 26-vizinhos) dentro da própria fita.
// Entrada/saída: volumes conformados 256³ (índice i + j·nx + k·nx·ny; eixo i = L em LIA).

const SUB = new Set(['Thalamus', 'Caudate', 'Putamen', 'Pallidum', 'Hippocampus', 'Amygdala', 'Accumbens-area', 'VentralDC'])
const ALIAS = { 'Inferior-Lateral-Ventricle': 'Inf-Lat-Vent' }

export function fuseAsegAparc({ aparc, aseg, names104, names18, dims = [256, 256, 256] }) {
  const [nx, ny, nz] = dims
  const n = nx * ny * nz
  if (aparc.length !== n || aseg.length !== n) throw new Error('fusão: volumes com tamanhos diferentes')
  const byName = new Map(Object.entries(names104).map(([k, v]) => [v, Number(k)]))
  const id104 = (name, side) => byName.get(`${side}-${name}`) ?? byName.get(`${side}-${name}-Proper*`) ?? byName.get(`${side}-${name}-Proper`) ?? byName.get(name) ?? 0
  // tabelas do 104: lado, córtex, corpo caloso
  const side104 = new Int8Array(256), isCtx = new Uint8Array(256), isCC = new Uint8Array(256)
  for (const [k, v] of Object.entries(names104)) {
    const id = Number(k)
    if (/^(Left-|ctx-lh-)/.test(v)) side104[id] = 1
    else if (/^(Right-|ctx-rh-)/.test(v)) side104[id] = -1
    if (v.startsWith('ctx-')) isCtx[id] = 1
    if (v.startsWith('CC_')) isCC[id] = 1
  }
  const csf104 = byName.get('CSF') ?? -1
  // tabelas do aseg 18 → ids do 104 por lado
  const Lid = new Uint8Array(256), Rid = new Uint8Array(256), isSub18 = new Uint8Array(256)
  let cortex18 = -1
  for (const [k, raw] of Object.entries(names18)) {
    const id = Number(k), name = ALIAS[raw] ?? raw
    if (!id) continue
    Lid[id] = id104(name, 'Left'); Rid[id] = id104(name, 'Right')
    if (SUB.has(raw)) isSub18[id] = 1
    if (raw === 'Cerebral-Cortex') cortex18 = id
  }
  if (cortex18 < 0) throw new Error('fusão: o modelo de 18 classes não tem Cerebral-Cortex')

  const out = new Uint8Array(n)
  const ribbon = new Uint8Array(n)
  const queue = new Int32Array(n)
  let qTail = 0
  const fw = new Int8Array(nx), fwd = new Int32Array(nx)
  let nRibbon = 0, nSeed = 0
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const row = j * nx + k * nx * ny
      // varredura →: último lado lateralizado visto e a distância até ele
      let last = 0, lastD = 1 << 30
      for (let i = 0; i < nx; i++) {
        const s = side104[aparc[row + i]]
        if (s) { last = s; lastD = 0 } else lastD++
        fw[i] = last; fwd[i] = lastD
      }
      // varredura ← e decisão por voxel
      last = 0; lastD = 1 << 30
      for (let i = nx - 1; i >= 0; i--) {
        const v = row + i, a = aparc[v], b = aseg[v]
        const s = side104[a]
        if (s) { last = s; lastD = 0 } else lastD++
        if (!b) { out[v] = a === csf104 ? a : 0; continue }
        let side = fwd[i] <= lastD ? fw[i] : last
        if (!side) side = i >= nx / 2 ? 1 : -1 // LIA: i crescente → esquerda
        if (isCC[a] && !isSub18[b]) { out[v] = a; continue }
        if (b === cortex18) {
          nRibbon++
          if (isCtx[a]) { ribbon[v] = 2; out[v] = a; queue[qTail++] = v; nSeed++ } // semente (já visitada)
          else ribbon[v] = 1
          continue
        }
        out[v] = side > 0 ? Lid[b] : Rid[b]
      }
    }
  }
  // propagação geodésica das parcelas dentro da fita cortical (BFS multi-fonte, 26-vizinhos)
  const sxy = nx * ny
  let qHead = 0
  while (qHead < qTail) {
    const v = queue[qHead++]
    const lab = out[v]
    const k = (v / sxy) | 0, r = v - k * sxy, j = (r / nx) | 0, i = r - j * nx
    for (let dk = -1; dk <= 1; dk++) {
      const kk = k + dk
      if (kk < 0 || kk >= nz) continue
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj
        if (jj < 0 || jj >= ny) continue
        const base = jj * nx + kk * sxy
        for (let di = -1; di <= 1; di++) {
          const ii = i + di
          if (ii < 0 || ii >= nx) continue
          const u = base + ii
          if (ribbon[u] === 1) { ribbon[u] = 2; out[u] = lab; queue[qTail++] = u }
        }
      }
    }
  }
  // fita sem conexão com nenhuma parcela (ilhas minúsculas): fica 0
  let orphan = 0
  for (let v = 0; v < n; v++) if (ribbon[v] === 1) orphan++
  return { labels: out, stats: { ribbonVoxels: nRibbon, seedVoxels: nSeed, propagatedVoxels: nRibbon - nSeed - orphan, orphanVoxels: orphan } }
}
