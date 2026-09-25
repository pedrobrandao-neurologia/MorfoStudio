// Teste de js/n4.js: recuperação de campo de viés conhecido + casos de borda.
import { check, done, js, rng } from '../helpers.mjs'
const { n4BiasCorrect } = await import(js('n4.js'))

// ---- fantoma T1 típico (1,2 mm), dois tecidos, viés suave realista (±12 %)
{
  const nx = 160, ny = 160, nz = 128, pix = [1.2, 1.2, 1.25]
  const img = new Float32Array(nx * ny * nz), tissue = new Uint8Array(img.length), field = new Float32Array(img.length)
  const r01 = rng(5)
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + y * nx + z * nx * ny
    const r = Math.hypot((x - nx / 2) * pix[0], (y - ny / 2) * pix[1], (z - nz / 2) * pix[2])
    let v = 5 + r01() * 3
    if (r < 70) { v = 100 + (r01() - 0.5) * 8; tissue[i] = 1 }
    if (r < 45) { v = 160 + (r01() - 0.5) * 8; tissue[i] = 2 }
    field[i] = 1 + 0.12 * (x / nx - 0.5) + 0.08 * Math.exp(-(((x - 33) ** 2 + (y - 117) ** 2) / 2200)) - 0.07 * (z / nz - 0.5)
    img[i] = v * field[i]
  }
  const cv = (im, t) => { let n = 0, s = 0, s2 = 0; for (let i = 0; i < im.length; i++) if (tissue[i] === t) { n++; s += im[i]; s2 += im[i] * im[i] } const m = s / n; return Math.sqrt(s2 / n - m * m) / m }
  const t0 = Date.now()
  const res = n4BiasCorrect(img, [nx, ny, nz], pix, { returnField: true })
  const secs = (Date.now() - t0) / 1000
  // piso de ruído: uniforme ±4 → CV 2,31 % (GM) e 1,44 % (WM)
  const removed = (b, a, fl) => (b * b - a * a) / (b * b - fl * fl)
  const gm = removed(cv(img, 1), cv(res.img, 1), 0.0231), wm = removed(cv(img, 2), cv(res.img, 2), 0.0144)
  let sf = 0, st = 0, sff = 0, stt = 0, sft = 0, k = 0
  for (let i = 0; i < img.length; i++) if (tissue[i]) { const a = Math.exp(res.logField[i]), b = field[i]; sf += a; st += b; sff += a * a; stt += b * b; sft += a * b; k++ }
  const corr = (sft / k - sf / k * st / k) / Math.sqrt((sff / k - (sf / k) ** 2) * (stt / k - (st / k) ** 2))
  console.log(`  (${secs.toFixed(1)} s)`)
  check(res.applied && gm > 0.6 && wm > 0.5, `variância de viés removida: SC ${(100 * gm).toFixed(0)} % · SB ${(100 * wm).toFixed(0)} %`)
  check(corr > 0.85, `correlação campo estimado × verdadeiro ${corr.toFixed(3)}`)
  check(n4BiasCorrect(img, [nx, ny, nz], pix).logField === null, 'campo completo só sob demanda (returnField)')
}
// ---- casos de borda: eixo com 1 corte (antes → tudo NaN), imagem constante, valores negativos
for (const [label, dims] of [['256×256×1', [256, 256, 1]], ['64×64×5', [64, 64, 5]]]) {
  const n = dims[0] * dims[1] * dims[2], img = new Float32Array(n)
  const r01 = rng(9)
  for (let i = 0; i < n; i++) img[i] = (i % dims[0]) > 10 && (i % dims[0]) < dims[0] - 10 ? 100 + 30 * r01() : 2
  const r = n4BiasCorrect(img, dims, [1, 1, 1])
  let nan = 0; for (const v of r.img) if (Number.isNaN(v)) nan++
  check(nan === 0, `${label}: sem NaN (${r.applied ? 'aplicado' : 'ignorado'})`)
}
{
  const img = new Float32Array(40 * 40 * 40).fill(50)
  const r = n4BiasCorrect(img, [40, 40, 40], [1, 1, 1])
  check(r.img.every((v) => Number.isFinite(v)), 'imagem constante: saída finita')
  const ct = new Float32Array(40 * 40 * 40).map((_, i) => (i % 40 < 20 ? -1000 : 40))
  const r2 = n4BiasCorrect(ct, [40, 40, 40], [1, 1, 1])
  check(r2.img.every((v) => Number.isFinite(v)), 'valores negativos (TC): saída finita')
}
done('n4')
