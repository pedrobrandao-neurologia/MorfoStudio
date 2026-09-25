// Teste de js/hippocampus-worker.js (worker real) com fantomas 256³.
import { check, done, loadWorker, rng } from '../helpers.mjs'

const run = await loadWorker('hippocampus-worker.js')
const N = 256, NN = N * N
// affine LIA conformada (FreeSurfer): x = −i + cx, y = k − cz, z = −j + cy  (i→L, j→I, k→A)
function lia(cx, cy, cz) { return [-1, 0, 0, cx, 0, 0, 1, -cz, 0, -1, 0, cy, 0, 0, 0, 1] }

/** desenha dois hipocampos curvos em coordenadas RAS (mm) e devolve rótulos/intensidade */
function phantom({ affine, merged, midX = 0, cortexShell = false, outliers = false }) {
  const labels = new Uint8Array(N * N * N), inten = new Uint8Array(N * N * N).fill(150)
  const A = affine
  // inversa de uma LIA pura: i = cx − x, k = y + cz, j = cy − z
  const vox = (x, y, z) => [Math.round(A[3] - x), Math.round(A[11] - z), Math.round(y - A[7])]
  const r01 = rng(11)
  let count = 0
  for (const side of [-1, 1]) {
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const x = midX + side * (28 + 6 * Math.sin(t * 2.2)), y = 20 - 40 * t, z = -12 + 8 * Math.sin(t * Math.PI * 0.9)
      const r = 7 - 3.5 * t
      for (let dz = -8; dz <= 8; dz++) for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
        const d = Math.hypot(dx, dy, dz)
        const [i, j, k] = vox(x + dx, y + dy, z + dz)
        const idx = i + j * N + k * NN
        if (d <= r) {
          const lab = merged ? 14 : side < 0 ? 77 : 78
          if (labels[idx] !== lab) { labels[idx] = lab; count++ }
          inten[idx] = 105 + Math.round((r01() - 0.5) * 12)
        } else if (cortexShell && d <= r + 3 && !labels[idx]) { labels[idx] = 2; inten[idx] = 106 } // córtex adjacente, mesma intensidade
      }
    }
  }
  const outlierIdx = []
  if (outliers) { // "líquor" plantado dentro do hipocampo esquerdo
    const [i, j, k] = vox(midX - 30, 5, -10)
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const idx = (i + dx) + (j + dy) * N + (k + dz) * NN
      if (labels[idx]) { inten[idx] = 30; outlierIdx.push(idx) }
    }
  }
  return { labels, inten, count, outlierIdx }
}
const ids = (merged) => (merged ? { left: [], right: [], merged: [14] } : { left: [77], right: [78], merged: [] })

// 1. lateralizado, sem refinamento: soma das partes = total; cabeça anterior
{
  const affine = lia(128, 128, 128)
  const ph = phantom({ affine, merged: false })
  const m = await run({ labels: ph.labels, intensity: ph.inten, dims: [N, N, N], affine, hippoIds: ids(false), claimableIds: [2], options: { refine: false } })
  const L = m.result.left, R = m.result.right
  check(L && R && L.head.volume_mm3 + L.body.volume_mm3 + L.tail.volume_mm3 === L.volume_mm3, 'soma cabeça+corpo+cauda = total')
  check(L.head.centroid_ras_mm[1] > L.tail.centroid_ras_mm[1], 'cabeça anterior à cauda (orientação LIA)')
  check(L.centroid_ras_mm[0] < 0 && R.centroid_ras_mm[0] > 0, 'esquerdo em x<0, direito em x>0')
  // comprimento real ponta a ponta do fantoma: arco central 43,5 + calotas 7 + 3,5 = 54,0 mm
  check(Math.abs(L.axis_length_mm - 54) / 54 < 0.06, `comprimento do eixo ${L.axis_length_mm.toFixed(1)} mm ≈ 54,0 mm (±6 %)`)
}
// 2. rótulo sem lado, cabeça 30 mm fora do x=0 do scanner: linha média estimada separa corretamente
{
  const affine = lia(128, 128, 128)
  const ph = phantom({ affine, merged: true, midX: 30 })
  const m = await run({ labels: ph.labels, intensity: ph.inten, dims: [N, N, N], affine, hippoIds: ids(true), claimableIds: [2], options: { refine: false } })
  const L = m.result.left, R = m.result.right
  check(L && R && Math.abs(L.volume_mm3 - R.volume_mm3) / R.volume_mm3 < 0.02, `lados equilibrados com linha média deslocada (E ${L?.volume_mm3} · D ${R?.volume_mm3})`)
  check(m.result.log.some((l) => /linha média estimada/.test(l)), 'linha média estimada registrada no log')
}
// 3. refinamento com córtex encostado (mesma intensidade): crescimento limitado; outliers ficam fora
{
  const affine = lia(128, 128, 128)
  const ph = phantom({ affine, merged: false, cortexShell: true, outliers: true })
  const base = await run({ labels: ph.labels, intensity: ph.inten, dims: [N, N, N], affine, hippoIds: ids(false), claimableIds: [2], options: { refine: false } })
  const m = await run({ labels: ph.labels, intensity: ph.inten, dims: [N, N, N], affine, hippoIds: ids(false), claimableIds: [2], options: { refine: true } })
  const growth = m.result.right.volume_mm3 / base.result.right.volume_mm3 - 1
  check(growth < 0.03, `crescimento no córtex adjacente limitado (${(100 * growth).toFixed(1)} % < 3 %)`)
  const back = ph.outlierIdx.filter((i) => m.labelsOut[i] !== 0).length
  check(ph.outlierIdx.length > 0 && back === 0, `outliers plantados ficam fora da máscara final (${back}/${ph.outlierIdx.length} devolvidos)`)
}
// 4. um lado inválido não derruba o outro
{
  const affine = lia(128, 128, 128)
  const ph = phantom({ affine, merged: false })
  // fragmenta o esquerdo: mantém só ~100 voxels
  let kept = 0
  for (let i = 0; i < ph.labels.length; i++) if (ph.labels[i] === 77) { if (kept < 100) kept++; else ph.labels[i] = 0 }
  const m = await run({ labels: ph.labels, intensity: ph.inten, dims: [N, N, N], affine, hippoIds: ids(false), claimableIds: [2], options: { refine: false } })
  check(!m.result.left && m.result.right, 'lado esquerdo inválido ignorado, direito analisado')
}
done('hippocampus')
