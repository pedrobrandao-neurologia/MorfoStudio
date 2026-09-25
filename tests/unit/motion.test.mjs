// Teste do js/motion-worker.js (worker real): cabeça fora do centro do FOV, fundo com ruído,
// movimento rígido conhecido em torno de um ponto arbitrário. Mede o erro de mapeamento (mm)
// usando o centro de rotação devolvido pelo worker — o custo e a reamostragem devem usar o MESMO centro.
import { check, done, loadWorker, rng } from '../helpers.mjs'

const run = await loadWorker('motion-worker.js')
const dims = [96, 96, 80], pix = [2, 2, 2.2], [nx, ny, nz] = dims, n = nx * ny * nz
const hc = [110, 130, 88] // centro da "cabeça" (mm) deslocado do centro do FOV
function world(x, y, z) {
  const r = ((x - hc[0]) / 70) ** 2 + ((y - hc[1]) / 85) ** 2 + ((z - hc[2]) / 65) ** 2
  if (r > 1) return 0
  const inner = ((x - hc[0]) / 50) ** 2 + ((y - hc[1]) / 65) ** 2 + ((z - hc[2]) / 45) ** 2
  let v = inner < 1 ? 120 + 15 * Math.sin(x * 0.2) * Math.cos(y * 0.15) : 70
  if (Math.abs(x - hc[0] - 25) < 10 && Math.abs(y - hc[1] + 20) < 10 && Math.abs(z - hc[2] - 10) < 10) v = 200
  return v
}
const rot = (rx, ry, rz) => {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz)
  return [cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz, cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz, -sy, sx * cy, cx * cy]
}
const R0 = rot(2 * Math.PI / 180, 0, 4 * Math.PI / 180), C0 = [100, 140, 90], t0 = [3, -2, 1.5]
// mapeamento verdadeiro fixo→móvel: q = R0(p − C0) + C0 + t0; móvel(q) = mundo(T⁻¹ q)
const fwd = (R, c, t, p) => { const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]; return [0, 1, 2].map((r) => R[r * 3] * d[0] + R[r * 3 + 1] * d[1] + R[r * 3 + 2] * d[2] + c[r] + t[r]) }
const inv = (q) => { const d = [q[0] - C0[0] - t0[0], q[1] - C0[1] - t0[1], q[2] - C0[2] - t0[2]]; return [0, 1, 2].map((c) => R0[c] * d[0] + R0[3 + c] * d[1] + R0[6 + c] * d[2] + C0[c]) }
const noise = rng(3)
function make(T) {
  const img = new Float32Array(n)
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const q = [x * pix[0], y * pix[1], z * pix[2]]
    const p = T ? T(q) : q
    img[x + y * nx + z * nx * ny] = world(p[0], p[1], p[2]) + 24 * Math.abs(noise() + noise() - 1)
  }
  return img
}
const ref = make(null), mov = make(inv)
const t = Date.now()
const m = await run({ volumes: [ref, mov], dims, pixdims: pix, options: { metric: 'mi' } })
const p = m.params[1], c = m.rotationCenter_mm
const Rw = rot(p.rx_deg * Math.PI / 180, p.ry_deg * Math.PI / 180, p.rz_deg * Math.PI / 180)
let err = 0, emax = 0, cnt = 0
for (let z = 10; z < nz; z += 6) for (let y = 10; y < ny; y += 6) for (let x = 10; x < nx; x += 6) {
  const pp = [x * pix[0], y * pix[1], z * pix[2]]
  if (world(...pp) === 0) continue
  const a = fwd(Rw, c, [p.tx_mm, p.ty_mm, p.tz_mm], pp), b = fwd(R0, C0, t0, pp)
  const e = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); err += e; cnt++; if (e > emax) emax = e
}
err /= cnt
console.log(`  (tempo ${((Date.now() - t) / 1000).toFixed(1)} s; centro ${c.map((v) => v.toFixed(1))})`)
check(err < 1.0, `erro médio de mapeamento ${err.toFixed(2)} mm < 1 mm (máx ${emax.toFixed(2)})`)
check(Array.isArray(c) && c.length === 3, 'centro de rotação devolvido')
check(m.img.length === n && Number.isFinite(m.meanDisplacement), 'média e deslocamento válidos')
done('motion')
