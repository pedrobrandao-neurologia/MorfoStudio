// hippocampus.js — orquestração da análise hipocampal (ver hippocampus-worker.js para o algoritmo).
// Detecta os rótulos de hipocampo do modelo usado, roda o worker, sobrepõe as subregiões no NiiVue
// e alimenta painel, CSV, JSON, linha larga (coorte/SAV), PDF e NIfTI.

import { writeNifti, gzipBlob } from './nifti-writer.js'
import { parseName } from './stats.js'

// códigos de saída do worker (uint8): 1–3 esquerdo, 4–6 direito
export const HIPPO_LABELS = {
  1: 'Left-Hippocampus-head', 2: 'Left-Hippocampus-body', 3: 'Left-Hippocampus-tail',
  4: 'Right-Hippocampus-head', 5: 'Right-Hippocampus-body', 6: 'Right-Hippocampus-tail'
}
export const HIPPO_PT = {
  1: 'Hipocampo esquerdo — cabeça', 2: 'Hipocampo esquerdo — corpo', 3: 'Hipocampo esquerdo — cauda',
  4: 'Hipocampo direito — cabeça', 5: 'Hipocampo direito — corpo', 6: 'Hipocampo direito — cauda'
}
const HIPPO_COLORMAP = {
  R: [0, 230, 240, 245, 85, 90, 95],
  G: [0, 90, 150, 210, 120, 190, 200],
  B: [0, 105, 70, 80, 220, 230, 140],
  labels: ['BG', ...Object.values(HIPPO_LABELS)]
}
const PART_PT = { head: 'cabeça', body: 'corpo', tail: 'cauda' }

/** cor RGB do código de subregião (1–6) */
export function hippoColor(code) {
  return [HIPPO_COLORMAP.R[code], HIPPO_COLORMAP.G[code], HIPPO_COLORMAP.B[code]]
}

/** encontra ids de rótulo do hipocampo no labels.json do modelo (exclui parahippocampal) */
export function findHippoIds(labelNames) {
  const out = { left: [], right: [], merged: [] }
  for (const [k, name] of Object.entries(labelNames || {})) {
    if (!/hippocamp/i.test(name) || /parahippocamp/i.test(name)) continue
    const { hemi } = parseName(name)
    const id = Number(k)
    if (hemi === 'L') out.left.push(id)
    else if (hemi === 'R') out.right.push(id)
    else out.merged.push(id)
  }
  return out
}

/** rótulos que o refinamento pode reivindicar: córtex adjacente / cinzenta genérica */
export function findClaimableIds(labelNames) {
  const ids = []
  for (const [k, name] of Object.entries(labelNames || {})) {
    const { base, cortical } = parseName(name)
    if (cortical || /^(Cerebral-Cortex|GM|Grey Matter)$/.test(base)) ids.push(Number(k))
  }
  return ids
}

export function hasHippocampus(labelNames) {
  const ids = findHippoIds(labelNames)
  return ids.left.length + ids.right.length + ids.merged.length > 0
}

/** roda o worker; resolve {labelsOut: Uint8Array(256³), result} */
export function runHippoWorker({ labels, intensity, dims, affine, labelNames, options, onProgress }) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./hippocampus-worker.js', import.meta.url), { type: 'module' })
    w.onmessage = (e) => {
      const m = e.data
      if (m.cmd === 'progress') onProgress?.(m.message, m.frac)
      else if (m.cmd === 'error') { w.terminate(); reject(new Error(m.message)) }
      else if (m.cmd === 'done') { w.terminate(); resolve({ labelsOut: new Uint8Array(m.labelsOut), result: m.result }) }
    }
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'worker do hipocampo falhou')) }
    // cópias: o volume de rótulos e a intensidade continuam em uso na thread principal
    w.postMessage({
      labels: Uint8Array.from(labels), intensity: Uint8Array.from(intensity), dims, affine,
      hippoIds: findHippoIds(labelNames), claimableIds: findClaimableIds(labelNames), options
    })
  })
}

/** monta o volume de sobreposição NiiVue a partir dos rótulos de subregião */
export function buildHippoOverlay(conf, labelsOut, opacity = 0.85) {
  const overlay = conf.clone()
  overlay.zeroImage()
  overlay.hdr.scl_inter = 0; overlay.hdr.scl_slope = 1
  overlay.img = labelsOut
  overlay.hdr.intent_code = 1002
  overlay.setColormapLabel(HIPPO_COLORMAP)
  overlay.opacity = opacity
  overlay.name = 'hipocampo'
  return overlay
}

export async function hippoNiftiGz(conf, labelsOut) {
  const buf = writeNifti({
    dims: [256, 256, 256], pixdims: [1, 1, 1], affine: conf.hdr.affine.flat(),
    dtype: 'uint8', data: labelsOut, intent: 1002, description: 'Morfo hipocampo cabeca/corpo/cauda'
  })
  return gzipBlob(buf)
}

/** CSV longo: uma linha por hemisfério × (total, cabeça, corpo, cauda) */
export function hippoToCSV(result, meta) {
  const esc = (v) => (v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : `"${String(v).replace(/"/g, '""')}"`)
  const head = ['subject_id', 'session', 'model', 'quality_tier', 'pipeline', 'hemisphere', 'part', 'part_pt',
    'voxels', 'volume_mm3', 'length_mm', 'mean_xsec_mm2', 'eq_diameter_mm', 'mean_intensity', 'sd_intensity',
    'centroid_x', 'centroid_y', 'centroid_z', 'surface_mm2', 'sphericity', 'edge_contrast', 'qc_flags']
  const rows = [head.join(',')]
  const pre = [meta.subjectId, meta.session, meta.modelKey, meta.qualityTier, meta.pipeline]
  for (const [hemi, key] of [['L', 'left'], ['R', 'right']]) {
    const s = result[key]
    if (!s) continue
    rows.push([...pre, hemi, 'whole', 'hipocampo inteiro', s.voxels_refined, s.volume_mm3, s.axis_length_mm, s.mean_xsec_mm2,
      s.eq_diameter_mm, s.intensity_median, s.intensity_sigma, ...(s.centroid_ras_mm || ['', '', '']),
      s.surface_mm2, s.sphericity, s.edge_contrast, s.qc_flags.join('; ')].map(esc).join(','))
    for (const p of ['head', 'body', 'tail']) {
      const P = s[p]
      rows.push([...pre, hemi, p, PART_PT[p], P.voxels, P.volume_mm3, P.length_mm, P.mean_xsec_mm2, P.eq_diameter_mm,
        P.mean_intensity, P.sd_intensity, ...(P.centroid_ras_mm || ['', '', '']), '', '', '', ''].map(esc).join(','))
    }
  }
  if (result.asymmetry?.total_pct != null) {
    rows.push([...pre, '', 'asymmetry_total', 'IA total %', '', result.asymmetry.total_pct, '', '', '', '', '', '', '', '', '', '', '', ''].map(esc).join(','))
    for (const p of ['head', 'body', 'tail']) rows.push([...pre, '', `asymmetry_${p}`, `IA ${PART_PT[p]} %`, '', result.asymmetry[`${p}_pct`], '', '', '', '', '', '', '', '', '', '', '', ''].map(esc).join(','))
  }
  return '\ufeff' + rows.join('\r\n')
}

/** colunas para a linha larga (coorte / SAV) */
export function hippoWideColumns(result) {
  const row = {}
  if (!result) return row
  for (const [hemi, key] of [['L', 'left'], ['R', 'right']]) {
    const s = result[key]
    if (!s) continue
    row[`hippo_${hemi}_mm3`] = s.volume_mm3
    row[`hippo_${hemi}_head_mm3`] = s.head.volume_mm3
    row[`hippo_${hemi}_body_mm3`] = s.body.volume_mm3
    row[`hippo_${hemi}_tail_mm3`] = s.tail.volume_mm3
    row[`hippo_${hemi}_length_mm`] = s.axis_length_mm
    row[`hippo_${hemi}_eq_diameter_mm`] = s.eq_diameter_mm
    row[`hippo_${hemi}_sphericity`] = s.sphericity
  }
  if (result.asymmetry) {
    if (result.asymmetry.total_pct != null) row.AI_hippo_total_pct = result.asymmetry.total_pct
    for (const p of ['head', 'body', 'tail']) if (result.asymmetry[`${p}_pct`] != null) row[`AI_hippo_${p}_pct`] = result.asymmetry[`${p}_pct`]
  }
  return row
}
