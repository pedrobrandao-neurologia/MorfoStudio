// Testes de js/fsl-prep.js: reorientação RAS, recorte de pescoço, morfologia e limpeza de máscara.
import { check, done, js } from '../helpers.mjs'
const { reorientToRAS, cropNeck, maskCleanup, normalizeWithinMask, dilate6, erode6 } = await import(js('fsl-prep.js'))

const ras = (A, p) => [0, 1, 2].map((r) => A[r * 4] * p[0] + A[r * 4 + 1] * p[1] + A[r * 4 + 2] * p[2] + A[r * 4 + 3])
const find = (img, dims, val) => { for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) if (img[x + y * dims[0] + z * dims[0] * dims[1]] === val) return [x, y, z]; return null }

// ---- reorientação: flips (LPS) preservam a posição RAS do marcador; idempotente
{
  const dims = [10, 12, 8], img = new Float32Array(10 * 12 * 8)
  img[2 + 3 * 10 + 4 * 120] = 99
  const aff = [-1, 0, 0, 9, 0, -2, 0, 22, 0, 0, 3, 0, 0, 0, 0, 1]
  const r = reorientToRAS(img, dims, [1, 2, 3], aff)
  check(r.applied && r.orientation === '−x−y+z', `detecta LPS (${r.orientation})`)
  const p = find(r.img, r.dims, 99)
  const w0 = ras(aff, [2, 3, 4]), w1 = ras(r.affine, p)
  check(w0.every((v, i) => Math.abs(v - w1[i]) < 1e-6), `posição RAS preservada em flips (${w1.map((v) => v.toFixed(1))})`)
  check(r.affine[0] > 0 && r.affine[5] > 0 && r.affine[10] > 0, 'affine nova é RAS')
  check(!reorientToRAS(r.img, r.dims, r.pixdims, r.affine).applied, 'segunda aplicação é no-op')
}
// ---- reorientação com permutação (sagital)
{
  const dims = [6, 8, 10], img = new Float32Array(6 * 8 * 10)
  img[1 + 2 * 6 + 3 * 48] = 77
  const aff = [0, 0, 1, 0, 1, 0, 0, 0, 0, -1, 0, 7, 0, 0, 0, 1]
  const r = reorientToRAS(img, dims, [1, 1, 1], aff)
  const p = find(r.img, r.dims, 77)
  const w0 = ras(aff, [1, 2, 3]), w1 = ras(r.affine, p)
  check(r.dims.join() === '10,6,8' && w0.every((v, i) => Math.abs(v - w1[i]) < 1e-6), `permutação preserva RAS (dims ${r.dims.join('×')})`)
}
// ---- recorte de pescoço
{
  const dims = [40, 40, 120], pix = [4, 4, 2], img = new Float32Array(40 * 40 * 120)
  for (let z = 0; z < 120; z++) for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
    const head = Math.hypot((x - 20) * 4, (y - 20) * 4, (z - 100) * 2) < 60
    const neck = z < 70 && Math.hypot((x - 20) * 4, (y - 24) * 4) < 30
    if (head || neck) img[x + y * 40 + z * 1600] = 150
  }
  const aff = [4, 0, 0, -80, 0, 4, 0, -80, 0, 0, 2, -120, 0, 0, 0, 1]
  const r = cropNeck({ img, dims, pixdims: pix, affine: aff, keepMM: 170 })
  check(r.applied && r.removedSlices > 20 && r.removedSlices < 45, `pescoço recortado (${r.removedSlices} cortes)`)
  check(Math.abs(r.affine[11] - (-120 + r.removedSlices * 2)) < 1e-6, 'origem da affine ajustada')
  check(!cropNeck({ img: img.slice(0, 40 * 40 * 60), dims: [40, 40, 60], pixdims: pix, affine: aff }).applied, 'FOV pequeno → no-op')
}
// ---- morfologia rápida ≡ referência ingênua
{
  const dims = [23, 17, 11], n = 23 * 17 * 11, mask = new Uint8Array(n)
  let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < n; i++) mask[i] = rnd() < 0.35 ? 1 : 0
  const NB = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]
  const naive = (m, dil) => {
    const [nx, ny, nz] = dims, o = Uint8Array.from(m)
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = x + y * nx + z * nx * ny
      if (dil ? m[i] : !m[i]) continue
      for (const [dx, dy, dz] of NB) {
        const X = x + dx, Y = y + dy, Z = z + dz
        const inside = X >= 0 && Y >= 0 && Z >= 0 && X < nx && Y < ny && Z < nz
        if (dil) { if (inside && m[X + Y * nx + Z * nx * ny]) { o[i] = 1; break } } else if (!inside || !m[X + Y * nx + Z * nx * ny]) { o[i] = 0; break }
      }
    }
    return o
  }
  check(dilate6(mask, dims).every((v, i) => v === naive(mask, true)[i]), 'dilate6 idêntica à referência')
  check(erode6(mask, dims).every((v, i) => v === naive(mask, false)[i]), 'erode6 idêntica à referência')
}
// ---- limpeza de máscara
{
  const dims = [40, 40, 40], prob = new Uint8Array(64000)
  for (let z = 0; z < 40; z++) for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
    const d = Math.hypot(x - 20, y - 20, z - 20)
    let p = d < 14 ? 230 : 5
    if (d < 3) p = 40
    if (x < 4 && y < 4 && z < 4) p = 220
    prob[x + y * 40 + z * 1600] = p
  }
  const r = maskCleanup(prob, dims, 0.5)
  check(r.removedComponents >= 1 && r.mask[1 + 40 + 1600] === 0, 'componente solto removido')
  check(r.mask[20 + 20 * 40 + 20 * 1600] === 1, 'cavidade central preenchida')
  const r2 = maskCleanup(prob, dims, 0.95)
  check(r2.voxels < r.voxels, `f maior → máscara menor (${r.voxels} → ${r2.voxels})`)
  const inten = new Uint8Array(64000)
  for (let i = 0; i < 64000; i++) inten[i] = r.mask[i] ? 60 + (i % 80) : 10
  const nrm = normalizeWithinMask(inten, r.mask)
  check(nrm.applied && nrm.img.every((v, i) => (r.mask[i] ? true : v === 0)), 'normalização: fora da máscara = 0')
}
done('fsl-prep')
