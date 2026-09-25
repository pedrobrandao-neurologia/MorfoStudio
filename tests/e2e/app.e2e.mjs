// app.e2e.mjs — fluxo completo do app no Chromium headless com rótulos sintéticos (?mock, sem inferência da rede
// de segmentação): demo → pré-processamento (reorientação, recorte, N4) → BET (rede de máscara real) → estatísticas →
// todas as exportações → coorte. Mede a maior tarefa longa da thread principal (interface travada).
// Uso: node tests/e2e/app.e2e.mjs [fusion|aseg_18|aparc_aseg_104|...]  (padrão: fusion, o modelo padrão do app)
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs'
import { serve } from './serve.mjs'

const model = process.argv[2] || 'fusion'
let fails = 0
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FALHA'} ${msg}`); if (!ok) fails++ }

const { url, close } = await serve()
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await (await browser.newContext({ acceptDownloads: true })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
await page.goto(url + 'index.html?mock=1')
await page.waitForFunction(() => window.morfo && document.getElementById('logText').textContent.includes('pronto'), undefined, { timeout: 60000 })
check(true, `app carregou (${await page.evaluate(() => window.morfo.VERSION)})`)

await page.click('#btnDemo')
await page.waitForFunction(() => !document.getElementById('btnRun').disabled, undefined, { timeout: 60000 })
check(true, 'demo aberto, botão Segmentar habilitado')

await page.selectOption('#modelSel', model)
await page.evaluate(() => { for (const id of ['optBet', 'optBiasStd']) { const el = document.getElementById(id); if (!el.checked) el.click() } })
// sonda de travamento: pulsos de 20 ms na thread principal; lacunas > 250 ms = interface congelada.
// O tempo dentro de nv.updateGLVolume (envio de textura 256³ ao WebGL) é separado: no SwiftShader (GL por
// software deste contêiner) leva segundos; numa GPU real, dezenas de ms. O código do app não pode travar.
await page.evaluate(() => {
  window.__gaps = []; window.__gl = []
  let last = performance.now()
  setInterval(() => { const t = performance.now(); if (t - last > 250) window.__gaps.push([last, t]); last = t }, 20)
  const nv = window.morfo.state.nv, o = nv.updateGLVolume.bind(nv)
  nv.updateGLVolume = (...a) => { const t = performance.now(); try { return o(...a) } finally { window.__gl.push([t, performance.now()]) } }
})
const t0 = Date.now()
await page.click('#btnRun')
await page.waitForFunction(() => window.morfo.state.result != null || /Erro:/.test(document.getElementById('logText').textContent), undefined, { timeout: 900000 })
const run = await page.evaluate(() => {
  const st = window.morfo.state
  return {
    log: document.getElementById('logText').textContent, ok: !!st.result, nReg: st.result?.regions.length,
    parenchyma: st.result?.summaries.brain_parenchyma_mm3, pre: !!st.pre, bet: !!st.bet, conform: st.meta?.preproc?.conform, fusion: st.meta?.fusion && { ...st.meta.fusion, models: undefined, method: undefined },
    rows: document.querySelectorAll('#statsTable tbody tr, table tbody tr').length,
    // maior congelamento descontado o envio de textura do NiiVue, e o maior envio de textura
    appFreeze: Math.max(0, ...window.__gaps.map(([a, b]) => (b - a) - window.__gl.reduce((s, [c, d]) => s + Math.max(0, Math.min(b, d) - Math.max(a, c)), 0))),
    glMax: Math.max(0, ...window.__gl.map(([a, b]) => b - a))
  }
})
if (!run.ok) console.log(run.log)
check(run.ok, `segmentação (mock) concluída em ${((Date.now() - t0) / 1000).toFixed(0)} s: ${run.nReg} regiões, parênquima ${(run.parenchyma / 1000).toFixed(0)} cm³`)
check(run.pre && run.bet, 'pré-processamento e BET registrados no estado')
check(run.conform && typeof run.conform === 'object', `procedência da conformação no meta (${JSON.stringify(run.conform)})`)
if (model === 'fusion') check(run.fusion && run.fusion.ribbonVoxels > 0, `fusão registrada no meta (${JSON.stringify(run.fusion)})`)
check(run.rows > 0, `tabela de regiões renderizada (${run.rows} linhas)`)
check(run.appFreeze < 1000, `maior congelamento da interface por código do app: ${run.appFreeze.toFixed(0)} ms (< 1000 ms) · envio de textura ao WebGL (NiiVue, GL por software): até ${run.glMax.toFixed(0)} ms`)

// exportações
for (const kind of ['csv', 'json', 'sav', 'pdf', 'seg', 'conf', 'pre', 'mask', 'brain', 'zip']) {
  try {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.evaluate((k) => window.morfo.doExport(k), kind)])
    const path = await dl.path()
    const { statSync } = await import('node:fs')
    const size = statSync(path).size
    check(size > 100, `exportação ${kind}: ${dl.suggestedFilename()} (${size} bytes)`)
  } catch (e) { check(false, `exportação ${kind}: ${e.message.split('\n')[0]}`) }
}

// coorte
await page.evaluate(() => { window.confirm = () => true })
await page.click('#btnAddCohort')
const nCohort = await page.evaluate(() => window.morfo.state.cohort.length)
check(nCohort >= 1, `coorte com ${nCohort} linha(s)`)
try {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.evaluate(() => window.morfo.doExport('cohort-sav'))])
  check(!!dl, `exportação da coorte: ${dl.suggestedFilename()}`)
} catch (e) { check(false, 'exportação da coorte: ' + e.message.split('\n')[0]) }

// nova execução sobre o mesmo exame: o estado anterior não pode vazar
await page.click('#btnRun')
await page.waitForFunction(() => window.morfo.state.result != null && !window.morfo.state.busy, undefined, { timeout: 900000 })
check(true, 'segunda execução concluída')

const pageErrors = errors.filter((e) => !/favicon|service worker|sw\.js/i.test(e))
check(pageErrors.length === 0, `erros de página: ${pageErrors.length ? pageErrors.join(' | ') : 'nenhum'}`)
await browser.close(); close()
console.log(fails ? `\n${fails} falha(s)` : '\ntudo ok')
process.exit(fails ? 1 : 0)
