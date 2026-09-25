// bwlabels.test.mjs — o "maior componente por classe" O(n + clusters) reproduz exatamente o original O(clusters²)
// do brainchop (mesmo vencedor, inclusive nos empates), e é rápido com dezenas de milhares de clusters.
import { check, done, js, rng } from '../helpers.mjs'
const { BWLabeler } = await import(js('bwlabels.js'))

// cópia literal do algoritmo original (brainchop, MIT) como referência
function reference(bw, cl, ls) {
  const nvox = bw.length
  const ls2bw = new Uint32Array(cl + 1).fill(0)
  const sumls = new Uint32Array(cl + 1).fill(0)
  for (let i = 0; i < nvox; i++) { ls2bw[ls[i]] = bw[i]; sumls[ls[i]]++ }
  let mxbw = 0
  for (let i = 0; i < cl + 1; i++) {
    const bwVal = ls2bw[i]
    mxbw = Math.max(mxbw, bwVal)
    for (let j = 0; j < cl + 1; j++) {
      if (j === i || bwVal !== ls2bw[j]) continue
      if (sumls[i] < sumls[j]) ls2bw[i] = 0
      else if (sumls[i] === sumls[j] && i < j) ls2bw[i] = 0
    }
  }
  const vxs = new Uint32Array(nvox)
  for (let i = 0; i < nvox; i++) vxs[i] = ls2bw[ls[i]]
  return [mxbw, vxs]
}

const bwl = new BWLabeler()
const R = rng(7)
const dims = new Uint32Array([40, 36, 30])
const n = dims[0] * dims[1] * dims[2]
for (const [nClasses, pFill] of [[3, 0.5], [18, 0.35], [104, 0.25]]) {
  const img = new Uint32Array(n)
  for (let i = 0; i < n; i++) if (R() < pFill) img[i] = 1 + Math.floor(R() * nClasses)
  // mesmos rótulos de componente que o bwlabel usaria (conectividade 26, sem binarizar)
  const [cl, ls] = bwl.bwlabel(img, dims, 26, false, false)
  const [m0, a] = reference(img, cl, ls)
  const [m1, b] = bwl.largest_original_cluster_labels(img, cl, ls)
  let diff = 0
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) diff++
  check(m0 === m1 && diff === 0, `${nClasses} classes, ${cl} clusters: idêntico ao original (${diff} voxels diferentes)`)
}
// empates: três clusters do mesmo tamanho → vence o de maior índice, como no original
{
  const bw = new Uint32Array([5, 5, 5, 0]), ls = new Uint32Array([1, 2, 3, 0])
  const [, a] = reference(bw, 3, ls), [, b] = bwl.largest_original_cluster_labels(bw, 3, ls)
  check(a.join() === b.join() && b.join() === '0,0,5,0', `empate resolvido igual ao original (${b.join()})`)
}
// desempenho: 60 mil clusters isolados de 1 voxel (o original levava vários segundos)
{
  const d = new Uint32Array([100, 100, 48]), N = d[0] * d[1] * d[2]
  const img = new Uint32Array(N)
  for (let z = 0; z < d[2]; z += 2) for (let y = 0; y < d[1]; y += 2) for (let x = 0; x < d[0]; x += 2) img[x + y * d[0] + z * d[0] * d[1]] = 1 + ((x + y + z) % 7)
  const bw = new Uint32Array(img)
  const [cl, ls] = bwl.bwlabel(img, d, 26, false, false)
  const t0 = performance.now()
  bwl.largest_original_cluster_labels(bw, cl, ls)
  const ms = performance.now() - t0
  check(cl > 50000 && ms < 500, `maior componente por classe com ${cl} clusters: ${ms.toFixed(0)} ms`)
}
done('bwlabels')
