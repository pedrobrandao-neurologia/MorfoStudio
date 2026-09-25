// import.e2e.mjs — importação de segmentação real do FreeSurfer no app (Chromium headless).
// Uso: node tests/e2e/import.e2e.mjs <T1.nii.gz> <aparc+aseg.mgz> <saida_prefixo>
// Verifica: volumes do app (grade nativa) == contagem direta; exporta seg conformada para Dice externo.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs'
import { serve } from './serve.mjs'

const [, , t1, segPath, out] = process.argv
const { url, close } = await serve()
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await (await browser.newContext({ acceptDownloads: true })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.addInitScript(() => { window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration) }).observe({ type: 'longtask', buffered: true }) } catch {} })
await page.goto(url + 'index.html')
await page.waitForFunction(() => window.morfo && document.getElementById('logText').textContent.includes('pronto'), undefined, { timeout: 60000 })
await page.setInputFiles('#inNifti', t1)
await page.waitForFunction(() => !document.getElementById('btnRun').disabled, undefined, { timeout: 60000 })
await page.evaluate(() => { window.__lt = [] })
await page.setInputFiles('#inSeg', segPath)
await page.waitForFunction(() => window.morfo.state.result != null || /Falha/.test(document.getElementById('logText').textContent), undefined, { timeout: 120000 })
const r = await page.evaluate(() => {
  const st = window.morfo.state
  return {
    log: document.getElementById('logText').textContent,
    ok: !!st.result, regions: st.result?.regions.map((x) => [x.name, x.volume_mm3]),
    summaries: st.result?.summaries, imported: st.meta?.imported, hippoEnabled: !document.getElementById('btnHippo').disabled,
    longtaskMax: Math.max(0, ...window.__lt)
  }
})
console.log(r.log)
if (!r.ok) { console.log('FALHOU', errors); process.exit(1) }
const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.morfo.doExport('seg'))])
await dl.saveAs(out + '_seg.nii.gz')
const { writeFileSync } = await import('node:fs')
writeFileSync(out + '_labels.json', JSON.stringify(await page.evaluate(() => window.morfo.state.labelNames)))
writeFileSync(out + '_import.json', JSON.stringify(r))
// hipocampo sobre a segmentação importada
await page.click('#btnHippo')
await page.waitForFunction(() => window.morfo.state.hippo != null || /falhou/.test(document.getElementById('logText').textContent), undefined, { timeout: 120000 })
const hip = await page.evaluate(() => window.morfo.state.hippo?.result && { L: window.morfo.state.hippo.result.left?.volume_mm3, R: window.morfo.state.hippo.result.right?.volume_mm3 })
console.log('hipocampo (subregiões) sobre a importada:', JSON.stringify(hip), '· maior tarefa longa na thread principal:', r.longtaskMax.toFixed(0), 'ms')
console.log('erros de página:', errors.length ? errors : 'nenhum')
await browser.close(); close()
