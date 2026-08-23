// app.js — Morfo Studio
import { Niivue, NVImage } from '../vendor/niivue.min.js'
import { Dcm2niix } from '../vendor/dcm2niix/index.jpeg.js'
import { inferenceModelsList, brainChopOpts } from './brainchop-parameters.js'
import { writeNifti, gzipBlob } from './nifti-writer.js'
import { computeStats, toCSV, toWideRow } from './stats.js'
import { writeSav } from './sav.js'
import { writeZip } from './zip.js'
import { detectContrast, assessQuality, renderRuler } from './quality.js'
import { buildReport } from './report.js'
import { hasHippocampus, runHippoWorker, buildHippoOverlay, hippoNiftiGz, hippoToCSV, hippoWideColumns, hippoColor } from './hippocampus.js'

const VERSION = '0.2.0'
const $ = (id) => document.getElementById(id)

// ids do brainchop-parameters.js (1-indexado): [memória alta, memória baixa]
const MODELS = {
  aparc_aseg_104: { label: 'aparc+aseg 104 classes (L/R, cerebelo, tronco, corpo caloso)', ids: [14, 15] },
  aparc_aseg_50: { label: 'aparc+aseg 50 classes (homólogos fundidos)', ids: [8, 9] },
  aseg_18: { label: 'aseg 18 classes (subcortical + tecidos)', ids: [4, 5] },
  tissue_3: { label: 'tecidos: cinzenta / branca / líquor', ids: [2, 3] },
  mask: { label: 'máscara cerebral', ids: [12, 12] },
  custom: { label: 'modelo próprio', ids: [14, 15] }
}

const state = {
  nv: null, base: null, conformed: null, seg: null, labelsVol: null,
  source: null, quality: null, pipeline: 'padrao', contrast: 'desconhecido',
  result: null, meta: null, labelNames: null, colormap: null, modelKey: null, modelEntry: null, hippo: null,
  worker: null, preWorker: null, rejectPending: null, busy: false, cancelled: false, robustLog: [], cohort: [], gpuRenderer: ''
}

// ---------------------------------------------------------------- utilidades de UI
const log = (msg) => { $('logText').textContent = msg; console.log('[morfo]', msg) }
const progress = (f) => { $('progressBar').style.width = f == null || f < 0 ? '0%' : `${Math.round(f * 100)}%` }
function setStep(name, status) {
  for (const li of document.querySelectorAll('.step')) {
    if (li.dataset.step !== name) continue
    li.classList.remove('active', 'done', 'running')
    if (status) li.classList.add(status)
  }
}
function stepsAfterInput() { ['quality', 'segment', 'stats', 'export'].forEach((s) => setStep(s, null)) }
function download(blobOrBytes, name) {
  const blob = blobOrBytes instanceof Blob ? blobOrBytes : new Blob([blobOrBytes])
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click()
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 2000)
}
const nowStamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const fileStamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }))
function setExportsEnabled(on) {
  for (const b of document.querySelectorAll('#exportRow button')) b.disabled = !on
  $('btnAddCohort').disabled = !on
  $('exportRow').querySelector('[data-export="src"]').disabled = !(on && state.source?.convertedFile)
}

// ---------------------------------------------------------------- NiiVue
async function initViewer() {
  const nv = new Niivue({
    backColor: [0.078, 0.09, 0.11, 1], show3Dcrosshair: true, dragAndDropEnabled: false, multiplanarForceRender: true,
    crosshairColor: [0.804, 0.243, 0.306, 1], isColorbar: false, loadingText: '',
    onLocationChange: (d) => { $('tagLoc').textContent = d.string || '—' }
  })
  await nv.attachToCanvas($('gl'))
  nv.setSliceType(nv.sliceTypeMultiplanar)
  nv.setMultiplanarPadPixels(4)
  state.nv = nv
  // GPU
  try {
    const gl = nv.gl
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    state.gpuRenderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'WebGL2'
    $('dotGpu').className = 'dot ok'; $('gpuText').textContent = shortGpu(state.gpuRenderer)
  } catch { $('dotGpu').className = 'dot warn'; $('gpuText').textContent = 'sem WebGL2' }
}

function shortGpu(r) {
  const m = r.match(/(NVIDIA|AMD|Radeon|Intel|Apple|Adreno|Mali|SwiftShader|llvmpipe)[^,()]*/i)
  return (m ? m[0] : r).trim().slice(0, 28)
}

async function showVolume(vol) {
  const nv = state.nv
  while (nv.volumes.length) await nv.removeVolume(nv.volumes[0])
  await nv.addVolume(vol)
  $('dropzone').classList.add('hidden')
  $('tagDims').textContent = `${vol.hdr.dims.slice(1, 4).join('×')} · ${vol.hdr.pixDims.slice(1, 4).map((v) => v.toFixed(2)).join('×')} mm`
}

// ---------------------------------------------------------------- entrada
async function openNiftiFile(file, source = {}) {
  try {
    log(`Lendo ${file.name}…`); progress(0.2)
    const vol = await NVImage.loadFromFile({ file, name: file.name })
    state.base = vol; state.conformed = null; state.labelsVol = null; state.result = null
    resetHippo()
    state.source = { kind: 'nifti', fileName: file.name, nFiles: 1, sidecar: {}, ...source }
    await showVolume(vol)
    if (!$('subjectId').value) $('subjectId').value = file.name.replace(/\.(nii|nii\.gz|mgz|mgh|nrrd)$/i, '').slice(0, 40)
    renderInputPanel()
    state.contrast = detectContrast({ sidecar: state.source.sidecar, fileName: file.name, description: vol.hdr.description || '' })
    evaluateQuality()
    setStep('input', 'done'); setStep('quality', 'active')
    $('btnRun').disabled = false; $('runHint').textContent = 'Pronto para segmentar.'
    $('statsBody').innerHTML = '<p class="empty">Nenhuma segmentação ainda.</p>'
    $('opacityBox').hidden = true
    setExportsEnabled(false)
    progress(0); log(`${file.name} carregado`)
  } catch (e) {
    console.error(e); log('Falha ao ler o arquivo: ' + e.message); progress(0)
  }
}

async function openDicomFiles(files) {
  const list = Array.from(files).filter((f) => !/\.(nii|nii\.gz|json|txt|bvec|bval|DS_Store)$/i.test(f.name))
  if (!list.length) { log('Nenhum arquivo DICOM na seleção.'); return }
  log(`Convertendo ${list.length} arquivos DICOM com dcm2niix…`); progress(0.1)
  setStep('input', 'running')
  let converted
  try {
    const d = new Dcm2niix()
    await d.init()
    converted = await d.input(list).z('y').ba('y').f('%p_%s_%d').run()
    d.worker.terminate()
  } catch (e) {
    console.error(e); log('dcm2niix falhou: ' + e.message); progress(0); setStep('input', 'active'); return
  }
  const niis = converted.filter((f) => /\.nii(\.gz)?$/i.test(f.name))
  if (!niis.length) { log('dcm2niix não produziu NIfTI (formato não suportado ou séries não-imagem).'); progress(0); setStep('input', 'active'); return }
  const series = []
  for (const f of niis) {
    const jname = f.name.replace(/\.nii(\.gz)?$/i, '.json')
    const j = converted.find((x) => x.name === jname)
    let sidecar = {}
    if (j) { try { sidecar = JSON.parse(await j.text()) } catch { /* ignore */ } }
    series.push({ file: f, sidecar, json: j })
  }
  const pick = series.length === 1 ? series[0] : await chooseSeries(series)
  if (!pick) { log('Conversão cancelada.'); progress(0); setStep('input', 'active'); return }
  await openNiftiFile(pick.file, { kind: 'dicom', nFiles: list.length, sidecar: pick.sidecar, convertedFile: pick.file, sidecarFile: pick.json })
}

function chooseSeries(series) {
  return new Promise((resolve) => {
    const ul = $('seriesList'); ul.innerHTML = ''
    for (const s of series) {
      const li = document.createElement('li')
      const sc = s.sidecar
      const m = [sc.SeriesDescription || sc.ProtocolName, sc.MRAcquisitionType, sc.SliceThickness ? `${sc.SliceThickness} mm` : null, sc.MagneticFieldStrength ? `${sc.MagneticFieldStrength} T` : null, (sc.ImageType || []).slice(0, 3).join('/')].filter(Boolean).join(' · ')
      li.innerHTML = `<div><div class="n"></div><div class="m"></div></div>`
      li.querySelector('.n').textContent = s.file.name
      li.querySelector('.m').textContent = m || `${Math.round(s.file.size / 1024)} kB`
      li.onclick = () => { $('seriesDlg').close(); resolve(s) }
      ul.appendChild(li)
    }
    $('seriesCancel').onclick = () => { $('seriesDlg').close(); resolve(null) }
    $('seriesDlg').showModal()
  })
}

async function readDropped(dataTransfer) {
  const files = []
  const walk = async (entry, path) => {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej))
      f._webkitRelativePath = path + f.name
      files.push(f)
    } else if (entry.isDirectory) {
      const reader = entry.createReader()
      let batch
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej))
        for (const e of batch) await walk(e, path + entry.name + '/')
      } while (batch.length)
    }
  }
  const items = Array.from(dataTransfer.items || [])
  const entries = items.map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean)
  if (entries.length) for (const e of entries) await walk(e, '')
  else files.push(...Array.from(dataTransfer.files))
  return files
}

function renderInputPanel() {
  const v = state.base, s = state.source, sc = s.sidecar || {}
  const rows = [
    ['Arquivo', s.fileName],
    ['Origem', s.kind === 'dicom' ? `DICOM (${s.nFiles} arquivos) → dcm2niix` : 'NIfTI'],
    ['Dimensões', v.hdr.dims.slice(1, 4).join(' × ')],
    ['Voxel (mm)', v.hdr.pixDims.slice(1, 4).map((x) => x.toFixed(2)).join(' × ')],
    ['Tipo', `${v.hdr.datatypeCode} (${v.img.constructor.name.replace('Array', '')})`]
  ]
  if (sc.SeriesDescription) rows.push(['Série', sc.SeriesDescription])
  if (sc.Manufacturer) rows.push(['Equipamento', `${sc.Manufacturer} ${sc.ManufacturersModelName || ''}${sc.MagneticFieldStrength ? ' · ' + sc.MagneticFieldStrength + ' T' : ''}`])
  if (sc.RepetitionTime) rows.push(['TR / TE / TI', `${(sc.RepetitionTime * 1000).toFixed(0)} / ${sc.EchoTime ? (sc.EchoTime * 1000).toFixed(1) : '—'} / ${sc.InversionTime ? (sc.InversionTime * 1000).toFixed(0) : '—'} ms`])
  if (v.hdr.description) rows.push(['Descrição', v.hdr.description])
  $('kvInput').innerHTML = rows.map(([k, val]) => `<dt>${k}</dt><dd title="${String(val).replace(/"/g, '&quot;')}">${val}</dd>`).join('')
}

// ---------------------------------------------------------------- qualidade
function evaluateQuality() {
  const v = state.base
  const q = assessQuality({ pixDims: v.hdr.pixDims.slice(1, 4), dims: v.hdr.dims.slice(1, 4), contrast: state.contrast, sidecar: state.source.sidecar })
  state.quality = q
  state.pipeline = q.pipeline
  renderQualityPanel()
}
function renderQualityPanel() {
  const q = state.quality
  const contrasts = ['T1', 'T2', 'FLAIR', 'PD', 'SWI', 'DWI', 'CT', 'desconhecido']
  $('qualityBody').innerHTML = `
    <div class="tier ${q.tier}"><span class="badge">${q.tier}</span>${q.tierLabel}</div>
    <div class="ruler">${renderRuler(q)}</div>
    <div class="field" style="margin-top:8px"><label for="contrastSel">Contraste da sequência</label>
      <select id="contrastSel">${contrasts.map((c) => `<option value="${c}" ${c === q.contrast ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
    <ul class="reasons">${q.reasons.map((r) => `<li>${r}</li>`).join('')}</ul>
    <div class="pipeline-choice">
      <button class="btn sm ${state.pipeline === 'padrao' ? 'sel' : ''}" data-pipe="padrao">Pipeline padrão</button>
      <button class="btn sm ${state.pipeline === 'robusto' ? 'sel' : ''}" data-pipe="robusto">Modo robusto</button>
    </div>
    <p class="hint">${state.pipeline === 'robusto' ? 'Reamostragem cúbica + correção de campo antes de conformar para 256³.' : 'Conformação direta para 256³ a 1 mm (FreeSurfer-style) e inferência.'}</p>`
  $('contrastSel').onchange = (e) => { state.contrast = e.target.value; evaluateQuality() }
  for (const b of $('qualityBody').querySelectorAll('[data-pipe]')) b.onclick = () => { state.pipeline = b.dataset.pipe; renderQualityPanel() }
}

// ---------------------------------------------------------------- pipeline
function volumeToFloat32(vol) {
  const [nx, ny, nz] = vol.hdr.dims.slice(1, 4)
  const n = nx * ny * nz
  const out = new Float32Array(n)
  const src = vol.img
  const slope = vol.hdr.scl_slope || 1, inter = vol.hdr.scl_inter || 0
  const isRGB = vol.hdr.datatypeCode === 128 || vol.hdr.datatypeCode === 2304
  if (isRGB) { const c = vol.hdr.datatypeCode === 128 ? 3 : 4; for (let i = 0; i < n; i++) out[i] = (src[i * c] + src[i * c + 1] + src[i * c + 2]) / 3 }
  else for (let i = 0; i < n; i++) out[i] = src[i] * slope + inter
  return out
}

function runPreprocess(vol) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./preprocess-worker.js', import.meta.url), { type: 'module' })
    state.preWorker = w
    state.rejectPending = reject
    const img = volumeToFloat32(vol)
    const dims = vol.hdr.dims.slice(1, 4), pixdims = vol.hdr.pixDims.slice(1, 4).map(Math.abs), affine = vol.hdr.affine.flat()
    const options = { targetMM: 1.0, biasCorrect: $('optBias').checked, denoise: $('optDenoise').checked }
    if (!$('optResample').checked) options.targetMM = 1e9
    w.onmessage = async (e) => {
      const m = e.data
      if (m.cmd === 'progress') { log(m.message); progress(0.05 + m.frac * 0.2) }
      else if (m.cmd === 'error') { w.terminate(); reject(new Error(m.message)) }
      else if (m.cmd === 'done') {
        w.terminate(); state.preWorker = null
        state.robustLog = m.log
        // normaliza para int16 para não explodir memória
        let mx = 0; for (let i = 0; i < m.img.length; i++) if (m.img[i] > mx) mx = m.img[i]
        const sc = mx > 0 ? 32000 / mx : 1
        const i16 = new Int16Array(m.img.length)
        for (let i = 0; i < i16.length; i++) i16[i] = Math.round(m.img[i] * sc)
        const buf = writeNifti({ dims: m.dims, pixdims: m.pixdims, affine: m.affine, dtype: 'int16', data: i16, sclSlope: 1 / sc, description: 'Morfo robusto' })
        const nvi = await NVImage.new(buf, 'robusto.nii')
        resolve(nvi)
      }
    }
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'worker de pré-processamento falhou')) }
    w.postMessage({ img, dims, pixdims, affine, options }, [img.buffer])
  })
}

function currentModelEntry() {
  const key = $('modelSel').value
  const low = $('lowMem').checked
  const def = MODELS[key]
  const entry = JSON.parse(JSON.stringify(inferenceModelsList[def.ids[low ? 1 : 0] - 1]))
  entry.isScalar = false
  entry.isNvidia = /nvidia/i.test(state.gpuRenderer)
  if (key === 'custom') {
    const murl = $('customModelUrl').value.trim(), lurl = $('customLabelsUrl').value.trim()
    if (!murl) throw new Error('Informe a URL do model.json do modelo próprio.')
    entry.path = murl; entry.labelsPath = lurl || null; entry.colormapPath = null; entry.preModelId = null; entry.modelName = 'custom'
    entry._absolute = true
  }
  return { key, entry, label: def.label }
}

async function fetchJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json() }

function cancelSegmentation() {
  if (state.worker) { try { state.worker.terminate() } catch { /* ignore */ } state.worker = null }
  if (state.preWorker) { try { state.preWorker.terminate() } catch { /* ignore */ } state.preWorker = null }
  state.cancelled = true
  if (state.rejectPending) { const r = state.rejectPending; state.rejectPending = null; r(new Error('cancelado')) }
}

function runInference(conf, modelSel, opts) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./brainchop-webworker.js', import.meta.url), { type: 'module' })
    state.worker = w
    state.rejectPending = reject
    w.onmessage = (e) => {
      const m = e.data
      if (m.cmd === 'ui') {
        if (m.message) log(m.message)
        if (typeof m.progressFrac === 'number' && m.progressFrac >= 0) progress(0.3 + m.progressFrac * 0.65)
        if (m.modalMessage) { w.terminate(); state.worker = null; reject(new Error(m.modalMessage)) }
      } else if (m.cmd === 'img') { w.terminate(); state.worker = null; resolve(new Uint8Array(m.img)) }
    }
    w.onerror = (e) => { w.terminate(); state.worker = null; reject(new Error(e.message || 'worker de inferência falhou')) }
    w.postMessage({ opts, modelEntry: modelSel.entry, niftiHeader: { datatypeCode: conf.hdr.datatypeCode, dims: conf.hdr.dims }, niftiImage: conf.img })
  })
}

async function finishSegmentation({ conf, labels, modelSel, backend, t0 }) {
  const nv = state.nv
  // ---- rótulos e cores
  let labelNames = null, colormap = null
  if (modelSel.entry.labelsPath) labelNames = await fetchJSON(modelSel.entry.labelsPath)
  if (modelSel.entry.colormapPath) colormap = await fetchJSON(modelSel.entry.colormapPath)
  if (!labelNames) labelNames = { 0: 'BG', 1: 'Brain' }
  if (!colormap) {
    const n = Math.max(...Object.keys(labelNames).map(Number)) + 1
    colormap = { R: new Array(n).fill(0), G: new Array(n).fill(0), B: new Array(n).fill(0) }
    for (let i = 1; i < n; i++) { const h = (i * 137.508) % 360; const [r, g, b] = hsl(h, 0.65, 0.55); colormap.R[i] = r; colormap.G[i] = g; colormap.B[i] = b }
  }
  if (!colormap.labels) colormap.labels = Object.keys(labelNames).sort((a, b) => a - b).map((k) => labelNames[k])
  state.labelNames = labelNames; state.colormap = colormap; state.modelKey = modelSel.key; state.modelEntry = modelSel.entry
  // ---- sobreposição
  const overlay = conf.clone()
  overlay.zeroImage()
  overlay.hdr.scl_inter = 0; overlay.hdr.scl_slope = 1
  overlay.img = labels
  overlay.hdr.intent_code = 1002
  overlay.setColormapLabel(colormap)
  overlay.opacity = Number($('opacity').value)
  overlay.name = 'segmentacao'
  await nv.addVolume(overlay)
  state.labelsVol = overlay; state.seg = labels
  $('opacityBox').hidden = false
  // ---- estatísticas
  setStep('segment', 'done'); setStep('stats', 'running'); log('Calculando estatísticas…'); progress(0.97)
  await new Promise((r) => setTimeout(r, 30))
  const result = computeStats({ labels, intensity: conf.img, dims: [256, 256, 256], affine: conf.hdr.affine.flat(), voxelVolume: 1, labelNames, colormap })
  state.result = result
  const q = state.quality
  state.meta = {
    subjectId: $('subjectId').value.trim() || 'sub-sem-id', session: $('sessionId').value.trim(), fileName: state.source.fileName,
    sourceKind: state.source.kind, nFiles: state.source.nFiles, acquisition: state.source.sidecar?.SeriesDescription || state.source.fileName,
    dims: state.base.hdr.dims.slice(1, 4), vox: q.vox, voxMin: q.voxMin, voxMax: q.voxMax, nSlices: q.nSlices, contrast: q.contrast,
    qualityTier: q.tier, pipeline: state.pipeline, robustLog: state.robustLog, modelKey: modelSel.key, modelLabel: modelSel.label,
    backend, elapsedS: ((performance.now() - t0) / 1000).toFixed(1), processedAt: nowStamp(), app: `Morfo Studio ${VERSION}`
  }
  renderStats()
  setStep('stats', 'done'); setStep('export', 'active')
  setExportsEnabled(true)
  // habilita a análise hipocampal quando o modelo rotula o hipocampo
  resetHippo()
  if (hasHippocampus(labelNames)) {
    $('btnHippo').disabled = false
    $('hippoBody').innerHTML = '<p class="empty">Segmentação pronta. Clique em <b>Analisar hipocampo</b> para refinar a máscara e dividir em cabeça · corpo · cauda.</p>'
  } else {
    $('hippoBody').innerHTML = '<p class="empty">O modelo selecionado não rotula o hipocampo. Use aseg 18 ou aparc+aseg.</p>'
  }
  progress(0); log(`Segmentação concluída em ${state.meta.elapsedS} s — ${result.regions.length} regiões`)
}

// ---------------------------------------------------------------- hipocampo
function resetHippo() {
  if (state.hippo?.overlay && state.nv) {
    try { state.nv.removeVolume(state.hippo.overlay) } catch { /* já removido junto com o volume base */ }
  }
  state.hippo = null
  $('btnHippo').disabled = true
  for (const b of document.querySelectorAll('#panelHippo [data-export]')) b.disabled = true
  $('hippoBody').innerHTML = '<p class="empty">Após segmentar com um modelo que rotule o hipocampo (aseg / aparc+aseg), esta análise refina a máscara e a divide em <b>cabeça · corpo · cauda</b> por um sistema de coordenadas longitudinal (equação de Laplace, método do HippUnfold). Em T1 ~1 mm não há contraste para subcampos (CA1–CA4, GD, subículo) — ver README.</p>'
}

async function runHippoAnalysis() {
  if (!state.seg || !state.conformed || state.busy) return
  const btn = $('btnHippo')
  btn.disabled = true
  try {
    log('Análise hipocampal: iniciando…'); progress(0.02)
    const t0 = performance.now()
    const conf = state.conformed, seg = state.seg
    const { labelsOut, result } = await runHippoWorker({
      labels: seg, intensity: conf.img, dims: [256, 256, 256],
      affine: conf.hdr.affine.flat(), labelNames: state.labelNames,
      options: { refine: $('hippoRefine').checked },
      onProgress: (msg, frac) => { log(msg); progress(frac) }
    })
    if (state.conformed !== conf || state.seg !== seg) return // nova segmentação começou no meio; descarta
    result.elapsed_s = ((performance.now() - t0) / 1000).toFixed(1)
    // sobreposição própria (acima da segmentação de cérebro inteiro)
    if (state.hippo?.overlay) { try { await state.nv.removeVolume(state.hippo.overlay) } catch { /* ignore */ } }
    const overlay = buildHippoOverlay(state.conformed, labelsOut, Number($('opacity').value) || 0.85)
    await state.nv.addVolume(overlay)
    state.hippo = { result, labels: labelsOut, overlay }
    renderHippoPanel()
    for (const b of document.querySelectorAll('#panelHippo [data-export]')) b.disabled = false
    progress(0); log(`Análise hipocampal concluída em ${result.elapsed_s} s`)
  } catch (e) {
    console.error(e)
    progress(0); log('Análise hipocampal falhou: ' + e.message)
    $('hippoBody').innerHTML = `<p class="empty">Falha: ${e.message}</p>`
  } finally {
    btn.disabled = false
  }
}

function renderHippoPanel() {
  const h = state.hippo?.result
  if (!h) return
  const rows = []
  const partsPT = { head: 'cabeça', body: 'corpo', tail: 'cauda' }
  for (const [key, label, codeBase] of [['left', 'Esquerdo', 1], ['right', 'Direito', 4]]) {
    const s = h[key]
    if (!s) { rows.push(`<tr><td colspan="4">${label}: não analisado</td></tr>`); continue }
    rows.push(`<tr class="hip-total" data-cent="${s.centroid_ras_mm.join(',')}"><td><b>${label} — total</b></td><td class="num">${fmt(s.volume_mm3)}</td><td class="num">${fmt(s.axis_length_mm, 1)}</td><td class="num">${fmt(s.eq_diameter_mm, 1)}</td></tr>`)
    for (const [p, code] of [['head', codeBase], ['body', codeBase + 1], ['tail', codeBase + 2]]) {
      const P = s[p]
      rows.push(`<tr data-cent="${(P.centroid_ras_mm || []).join(',')}"><td><span class="sw" style="background:rgb(${hippoColor(code).join(',')})"></span>${partsPT[p]}</td><td class="num">${fmt(P.volume_mm3)}</td><td class="num">${fmt(P.length_mm, 1)}</td><td class="num">${fmt(P.eq_diameter_mm, 1)}</td></tr>`)
    }
  }
  let html = `<div class="tbl-wrap"><table class="regions"><thead><tr><th>Subregião</th><th class="num">mm³</th><th class="num">compr. mm</th><th class="num">⌀ eq. mm</th></tr></thead><tbody id="hippoRows">${rows.join('')}</tbody></table></div>`
  if (h.asymmetry?.total_pct != null) {
    const ai = h.asymmetry
    const f = (v) => (v == null ? '—' : (Math.abs(v) > 10 ? `<b style="color:#cd3e4e">${fmt(v, 1)}</b>` : fmt(v, 1)))
    html += `<p class="hint" style="margin:6px 0 0">Assimetria 2(E−D)/(E+D)×100: total ${f(ai.total_pct)} % · cabeça ${f(ai.head_pct)} · corpo ${f(ai.body_pct)} · cauda ${f(ai.tail_pct)}</p>`
  }
  const flags = [...(h.left?.qc_flags || []).map((x) => 'E: ' + x), ...(h.right?.qc_flags || []).map((x) => 'D: ' + x)]
  if (flags.length) html += `<ul class="reasons" style="margin-top:6px">${flags.map((x) => `<li>⚠ ${x}</li>`).join('')}</ul>`
  html += `<p class="hint" style="margin:6px 0 0">Subregiões pelo eixo longitudinal (Laplace + fração do comprimento de arco: cabeça &lt; ${Math.round(h.options.headFrac * 100)} %, cauda &gt; ${Math.round(h.options.tailFrac * 100)} %)${h.options.refine ? ', máscara refinada por intensidade' : ''}. Não são subcampos histológicos. Clique numa linha para centrar a mira.</p>`
  $('hippoBody').innerHTML = html
  $('hippoRows').onclick = (e) => {
    const tr = e.target.closest('tr'); if (!tr?.dataset.cent) return
    const c = tr.dataset.cent.split(',').map(Number)
    if (c.length === 3 && c.every(Number.isFinite)) { state.nv.scene.crosshairPos = state.nv.mm2frac(c); state.nv.drawScene() }
  }
}

function setBusy(on) {
  state.busy = on
  const b = $('btnRun')
  b.textContent = on ? 'Cancelar' : 'Segmentar'
  b.classList.toggle('primary', !on)
  b.disabled = false
}

async function runSegmentation() {
  if (state.busy) { cancelSegmentation(); return }
  if (!state.base) return
  let modelSel
  try { modelSel = currentModelEntry() } catch (e) { log(e.message); return }
  state.cancelled = false
  setBusy(true)
  const t0 = performance.now()
  setStep('quality', 'done'); setStep('segment', 'running'); setStep('stats', null); setStep('export', null)
  setExportsEnabled(false)
  try {
    const nv = state.nv
    let vol = state.base
    state.robustLog = []
    if (state.pipeline === 'robusto') {
      log('Modo robusto: pré-processando…'); progress(0.05)
      vol = await runPreprocess(vol)
    }
    if (state.cancelled) throw new Error('cancelado')
    log('Conformando para 256³ a 1 mm…'); progress(0.28)
    const conf = await nv.conform(vol, false, true, false, true)
    state.conformed = conf
    await showVolume(conf)
    nv.setSliceType(nv.sliceTypeMultiplanar)
    // ---- inferência
    const opts = { ...brainChopOpts }
    opts.rootURL = new URL('.', location.href).href.replace(/\/$/, '')
    opts.backend = $('backendSel').value
    opts.telemetryFlag = false
    const labels = new URLSearchParams(location.search).has('mock') ? await mockLabels(conf, modelSel.entry) : await runInference(conf, modelSel, opts)
    if (state.cancelled) throw new Error('cancelado')
    await finishSegmentation({ conf, labels, modelSel, backend: opts.backend, t0 })
  } catch (e) {
    setStep('segment', 'active')
    progress(0)
    if (e.message === 'cancelado') log('Segmentação cancelada.')
    else { console.error(e); log('Erro: ' + e.message + (/memory|texture|WebGL/i.test(e.message) ? ' — tente "Baixa memória" ou backend CPU.' : '')) }
  } finally {
    state.rejectPending = null
    setBusy(false)
  }
}
// ?mock=1 — rótulos sintéticos (bandas de intensidade × posição) para testar painéis/exportações sem GPU
async function mockLabels(conf, entry) {
  log('MOCK: gerando rótulos sintéticos (sem inferência)')
  const names = entry.labelsPath ? await fetchJSON(entry.labelsPath) : { 0: 'BG', 1: 'Brain' }
  const ids = Object.keys(names).map(Number).filter((k) => k > 0)
  const out = new Uint8Array(conf.img.length)
  const n = 256, third = Math.max(1, Math.floor(ids.length / 3))
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = x + y * n + z * n * n, v = conf.img[i]
    if (v < 40) continue
    const band = v < 90 ? 0 : v < 170 ? 1 : 2
    const sector = ((x >> 5) * 3 + (y >> 6) + (z >> 6) * 5) % third
    out[i] = ids[(band * third + sector) % ids.length]
  }
  return out
}
function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255))
}

// ---------------------------------------------------------------- estatísticas (painel)
function renderStats() {
  const r = state.result, S = r.summaries
  const cards = [
    ['Parênquima', S.brain_parenchyma_mm3], ['SC cortical', S.cortical_gm_mm3], ['SB cerebral', S.cerebral_wm_mm3], ['Cerebelo', S.cerebellum_total_mm3],
    ['Tronco', S.brainstem_mm3], ['Ventrículos', S.ventricles_mm3]
  ].filter(([, v]) => v)
  let html = `<div class="summ">${cards.map(([l, v]) => `<div class="c"><div class="l">${l}</div><div class="v">${fmt(v / 1000, 1)} <small>cm³</small></div></div>`).join('')}</div>`
  html += `<p class="hint" style="margin:0 0 8px">Hemisférios (${r.hemispheres.method}): E ${fmt(r.hemispheres.left_parenchyma_mm3 / 1000, 1)} · D ${fmt(r.hemispheres.right_parenchyma_mm3 / 1000, 1)} cm³. Clique numa linha para centrar a mira.</p>`
  html += `<div class="field"><input type="text" id="regionFilter" placeholder="filtrar regiões…" autocomplete="off"></div>`
  html += `<div class="tbl-wrap"><table class="regions"><thead><tr><th>Região</th><th class="num">mm³</th><th class="num">% par.</th></tr></thead><tbody id="regionRows"></tbody></table></div>`
  $('statsBody').innerHTML = html
  const tbody = $('regionRows')
  const draw = (filter = '') => {
    const f = filter.toLowerCase()
    const rows = [...r.regions].sort((a, b) => b.volume_mm3 - a.volume_mm3).filter((x) => !f || x.namePT.toLowerCase().includes(f) || x.name.toLowerCase().includes(f))
    tbody.innerHTML = rows.map((x) => `<tr data-id="${x.id}" title="${x.name} · média ${fmt(x.mean_intensity, 1)} ± ${fmt(x.sd_intensity, 1)}"><td><span class="sw" style="background:rgb(${x.rgb.join(',')})"></span>${x.namePT}</td><td class="num">${fmt(x.volume_mm3)}</td><td class="num">${fmt(x.pct_parenchyma, 2)}</td></tr>`).join('')
  }
  draw()
  $('regionFilter').oninput = (e) => draw(e.target.value)
  tbody.onclick = (e) => {
    const tr = e.target.closest('tr'); if (!tr) return
    const reg = r.regions.find((x) => x.id === Number(tr.dataset.id)); if (!reg) return
    const nv = state.nv
    nv.scene.crosshairPos = nv.mm2frac(reg.centroid_ras_mm)
    nv.drawScene()
    log(`${reg.namePT}: ${fmt(reg.volume_mm3)} mm³ · centroide RAS ${reg.centroid_ras_mm.map((v) => v.toFixed(0)).join(', ')}`)
  }
}

// ---------------------------------------------------------------- exportações
function exportJSONObject() {
  return { app: state.meta.app, meta: state.meta, quality: state.quality, model: { key: state.modelKey, label: state.meta.modelLabel, path: state.modelEntry.path },
    summaries: state.result.summaries, lobes: state.result.lobes, hemispheres: state.result.hemispheres, asymmetry: state.result.asymmetry,
    hippocampus: state.hippo?.result || null, regions: state.result.regions }
}
/** linha larga do sujeito, incluindo colunas hipocampais quando a análise foi executada */
function wideRow() {
  return { ...toWideRow(state.result, state.meta), ...hippoWideColumns(state.hippo?.result) }
}
function snapshot() {
  const nv = state.nv
  nv.drawScene()
  const url = nv.canvas.toDataURL('image/jpeg', 0.85)
  const b64 = url.split(',')[1]
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { bytes, w: nv.canvas.width, h: nv.canvas.height }
}
function wideToSav(rows) {
  const keys = []
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k)
  const strKeys = new Set(['subject_id', 'session', 'acquisition', 'model', 'quality_tier', 'pipeline', 'processed_at'])
  const variables = keys.map((k) => ({ name: k, label: k.replace(/_/g, ' '), type: strKeys.has(k) ? 'string' : 'numeric', width: k === 'acquisition' ? 120 : 64, decimals: /_pct$|voxel/.test(k) ? 3 : 1 }))
  return writeSav({ variables, rows: rows.map((r) => keys.map((k) => r[k] ?? null)), fileLabel: `Morfo Studio ${VERSION}` })
}
function wideToCSV(rows) {
  const keys = []
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k)
  const esc = (v) => (v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : `"${String(v).replace(/"/g, '""')}"`)
  return '\ufeff' + [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\r\n')
}
async function segNiftiGz() {
  const c = state.conformed
  const buf = writeNifti({ dims: [256, 256, 256], pixdims: [1, 1, 1], affine: c.hdr.affine.flat(), dtype: 'uint8', data: state.seg, intent: 1002, description: `Morfo ${state.modelKey}` })
  return gzipBlob(buf)
}
async function confNiftiGz() {
  const c = state.conformed
  const buf = writeNifti({ dims: [256, 256, 256], pixdims: [1, 1, 1], affine: c.hdr.affine.flat(), dtype: 'uint8', data: c.img, description: 'Morfo conformado 256 1mm' })
  return gzipBlob(buf)
}
async function doExport(kind) {
  const base = `${state.meta?.subjectId || 'morfo'}_${state.modelKey || ''}_${fileStamp()}`
  try {
    switch (kind) {
      case 'csv': download(new Blob([toCSV(state.result, state.meta)], { type: 'text/csv' }), `${base}_regioes.csv`); break
      case 'json': download(new Blob([JSON.stringify(exportJSONObject(), null, 2)], { type: 'application/json' }), `${base}.json`); break
      case 'sav': download(new Blob([wideToSav([wideRow()])]), `${base}.sav`); break
      case 'pdf': {
        log('Gerando PDF…')
        const bytes = buildReport({ meta: state.meta, quality: state.quality, result: state.result, snapshot: snapshot(), modelInfo: { key: state.modelKey, label: state.meta.modelLabel }, hippo: state.hippo?.result })
        download(new Blob([bytes], { type: 'application/pdf' }), `${base}_relatorio.pdf`); break
      }
      case 'seg': download(await segNiftiGz(), `${base}_seg.nii.gz`); break
      case 'hippo-csv': if (state.hippo) download(new Blob([hippoToCSV(state.hippo.result, state.meta)], { type: 'text/csv' }), `${base}_hipocampo.csv`); break
      case 'hippo-nii': if (state.hippo) download(await hippoNiftiGz(state.conformed, state.hippo.labels), `${base}_hipocampo.nii.gz`); break
      case 'conf': download(await confNiftiGz(), `${base}_conformado.nii.gz`); break
      case 'src': if (state.source?.convertedFile) download(state.source.convertedFile, state.source.convertedFile.name); break
      case 'zip': {
        log('Montando pacote…')
        const entries = [
          { name: `${base}_regioes.csv`, data: new TextEncoder().encode(toCSV(state.result, state.meta)) },
          { name: `${base}.json`, data: new TextEncoder().encode(JSON.stringify(exportJSONObject(), null, 2)) },
          { name: `${base}.sav`, data: wideToSav([wideRow()]) },
          { name: `${base}_relatorio.pdf`, data: buildReport({ meta: state.meta, quality: state.quality, result: state.result, snapshot: snapshot(), modelInfo: { key: state.modelKey, label: state.meta.modelLabel }, hippo: state.hippo?.result }) },
          { name: `${base}_seg.nii.gz`, data: new Uint8Array(await (await segNiftiGz()).arrayBuffer()) },
          { name: `${base}_conformado.nii.gz`, data: new Uint8Array(await (await confNiftiGz()).arrayBuffer()) }
        ]
        if (state.hippo) {
          entries.push({ name: `${base}_hipocampo.csv`, data: new TextEncoder().encode(hippoToCSV(state.hippo.result, state.meta)) })
          entries.push({ name: `${base}_hipocampo.nii.gz`, data: new Uint8Array(await (await hippoNiftiGz(state.conformed, state.hippo.labels)).arrayBuffer()) })
        }
        if (state.source?.convertedFile) entries.push({ name: state.source.convertedFile.name, data: new Uint8Array(await state.source.convertedFile.arrayBuffer()) })
        if (state.source?.sidecarFile) entries.push({ name: state.source.sidecarFile.name, data: new Uint8Array(await state.source.sidecarFile.arrayBuffer()) })
        download(new Blob([writeZip(entries)], { type: 'application/zip' }), `${base}.zip`); break
      }
      case 'cohort-csv': download(new Blob([wideToCSV(state.cohort.map((c) => c.row))], { type: 'text/csv' }), `morfo_coorte_${fileStamp()}.csv`); break
      case 'cohort-sav': download(new Blob([wideToSav(state.cohort.map((c) => c.row))]), `morfo_coorte_${fileStamp()}.sav`); break
    }
    log(`Exportado: ${kind}`)
  } catch (e) { console.error(e); log('Falha na exportação: ' + e.message) }
}

// ---------------------------------------------------------------- coorte
function loadCohort() {
  try { state.cohort = JSON.parse(localStorage.getItem('morfo.cohort.v1') || '[]') } catch { state.cohort = [] }
  renderCohort()
}
function saveCohort() { try { localStorage.setItem('morfo.cohort.v1', JSON.stringify(state.cohort)) } catch (e) { log('Não foi possível salvar a coorte: ' + e.message) } }
function renderCohort() {
  const n = state.cohort.length
  $('cohortCount').textContent = `${n} sujeito${n === 1 ? '' : 's'}`
  for (const k of ['cohort-csv', 'cohort-sav']) $('exportRow').parentElement.querySelector(`[data-export="${k}"]`).disabled = n === 0
  $('btnClearCohort').disabled = n === 0
}
function addToCohort() {
  if (!state.result) return
  const row = wideRow()
  const idx = state.cohort.findIndex((c) => c.row.subject_id === row.subject_id && c.row.session === row.session && c.row.model === row.model)
  if (idx >= 0) state.cohort[idx] = { row }; else state.cohort.push({ row })
  saveCohort(); renderCohort()
  log(`${row.subject_id} ${idx >= 0 ? 'atualizado na' : 'adicionado à'} coorte (${state.cohort.length})`)
}

// ---------------------------------------------------------------- exemplo sintético
async function loadDemo() {
  const nx = 192, ny = 192, nz = 40, pix = [1.2, 1.2, 4.0]
  const img = new Int16Array(nx * ny * nz)
  const cx = 96, cy = 96, cz = 20
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const dx = (i - cx) * pix[0], dy = (j - cy) * pix[1] * 0.85, dz = (k - cz) * pix[2] * 1.1
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const bias = 0.8 + 0.4 * (i / nx)
    let v = 10 + Math.random() * 8
    if (r < 82) v = 40 // líquor extra
    if (r < 78) v = 120 + (Math.sin(i * 0.35) + Math.cos(j * 0.3)) * 12 // "córtex"
    if (r < 66) v = 210 // "branca"
    if (Math.abs(dx) < 10 && Math.abs(dy - 10) < 25 && Math.abs(dz) < 12) v = 35 // "ventrículo"
    if (r < 88 && r >= 82) v = 30
    if (r < 95 && r >= 88) v = 240 // "calota"
    img[i + j * nx + k * nx * ny] = Math.round(v * bias + (Math.random() - 0.5) * 10)
  }
  const affine = [-pix[0], 0, 0, cx * pix[0], 0, pix[1], 0, -cy * pix[1], 0, 0, pix[2], -cz * pix[2], 0, 0, 0, 1]
  const buf = writeNifti({ dims: [nx, ny, nz], pixdims: pix, affine, dtype: 'int16', data: img, description: 'Morfo demo sintetico T1-like' })
  const file = new File([buf], 'exemplo_sintetico_T1_4mm.nii')
  $('subjectId').value = 'demo-sintetico'
  await openNiftiFile(file, { kind: 'nifti', sidecar: { SeriesDescription: 'sintético T1-like axial 4 mm (não é um cérebro real)' } })
}

// ---------------------------------------------------------------- ligações
function bind() {
  $('btnDicom').onclick = () => $('inDicom').click()
  $('btnNifti').onclick = () => $('inNifti').click()
  $('inDicom').onchange = (e) => { if (e.target.files.length) openDicomFiles(e.target.files); e.target.value = '' }
  $('inNifti').onchange = (e) => { if (e.target.files[0]) openNiftiFile(e.target.files[0]); e.target.value = '' }
  $('btnDemo').onclick = loadDemo
  $('btnRun').onclick = runSegmentation
  $('btnHippo').onclick = runHippoAnalysis
  $('modelSel').onchange = () => { $('customModelField').hidden = $('modelSel').value !== 'custom' }
  $('opacity').oninput = (e) => {
    const op = Number(e.target.value)
    let changed = false
    state.nv.volumes.forEach((v, i) => { if (v === state.labelsVol || v === state.hippo?.overlay) { state.nv.setOpacity(i, op); changed = true } })
    if (changed) state.nv.updateGLVolume()
  }
  $('layoutSel').onchange = (e) => {
    const nv = state.nv, v = e.target.value
    nv.setSliceType({ mpr: nv.sliceTypeMultiplanar, axial: nv.sliceTypeAxial, coronal: nv.sliceTypeCoronal, sagittal: nv.sliceTypeSagittal, render: nv.sliceTypeRender }[v])
  }
  for (const b of document.querySelectorAll('[data-export]')) b.onclick = () => doExport(b.dataset.export)
  $('btnAddCohort').onclick = addToCohort
  $('btnClearCohort').onclick = () => { if (confirm('Remover todos os sujeitos da coorte salva neste navegador?')) { state.cohort = []; saveCohort(); renderCohort() } }
  // drag & drop
  const view = $('view')
  view.addEventListener('dragover', (e) => { e.preventDefault(); view.classList.add('dragover') })
  view.addEventListener('dragleave', () => view.classList.remove('dragover'))
  view.addEventListener('drop', async (e) => {
    e.preventDefault(); view.classList.remove('dragover')
    const files = await readDropped(e.dataTransfer)
    if (!files.length) return
    const nii = files.find((f) => /\.(nii|nii\.gz|mgz|mgh|nrrd)$/i.test(f.name))
    if (files.length === 1 && nii) openNiftiFile(nii)
    else if (nii && files.length < 4) openNiftiFile(nii)
    else openDicomFiles(files)
  })
  // rede / service worker
  const net = () => { $('dotNet').className = 'dot ' + (navigator.onLine ? 'ok' : 'warn'); $('netText').textContent = navigator.onLine ? 'online' : 'offline (ok)' }
  window.addEventListener('online', net); window.addEventListener('offline', net); net()
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      $('dotSw').className = 'dot ok'; $('swText').textContent = 'cache offline'
      reg.addEventListener('updatefound', () => { $('swText').textContent = 'atualizando…'; const nw = reg.installing; nw && nw.addEventListener('statechange', () => { if (nw.state === 'activated' || nw.state === 'installed') $('swText').textContent = 'cache offline' }) })
    }).catch(() => { $('dotSw').className = 'dot warn'; $('swText').textContent = 'sem cache' })
  } else { $('dotSw').className = 'dot warn'; $('swText').textContent = 'sem cache (file://)' }
}

// ---------------------------------------------------------------- início
;(async () => {
  try {
    await initViewer()
    bind()
    loadCohort()
    window.morfo = { openDicomFiles, openNiftiFile, state } // acesso programático / testes
    // API para scripts/console: window.morfo.state, openNiftiFile(File), runSegmentation(), finishSegmentation({conf, labels, modelSel, backend, t0}), doExport(kind)
    window.morfo = { state, openNiftiFile, openDicomFiles, runSegmentation, cancelSegmentation, finishSegmentation, currentModelEntry, doExport, addToCohort, computeStats, runHippoAnalysis, VERSION }
    log('pronto — abra uma pasta DICOM ou um NIfTI')
  } catch (e) {
    console.error(e)
    log('Falha ao iniciar o visualizador: ' + e.message)
  }
})()
