// stats.js — estatísticas regionais a partir do volume de rótulos (uint8) e da intensidade conformada.

export const PT = {
  // aseg
  'Cerebral-White-Matter': 'Substância branca cerebral', 'Cerebral-Cortex': 'Córtex cerebral',
  'Lateral-Ventricle': 'Ventrículo lateral', 'Inf-Lat-Vent': 'Corno temporal (ventrículo lateral)',
  'Inferior-Lateral-Ventricle': 'Corno temporal (ventrículo lateral)', 'Ventricle': 'Ventrículos (todos)',
  'Cerebellum-White-Matter': 'Substância branca cerebelar', 'Cerebellum-Cortex': 'Córtex cerebelar', 'Cerebellum': 'Cerebelo (córtex)',
  'Thalamus': 'Tálamo', 'Thalamus-Proper*': 'Tálamo', 'Thalamus-Proper': 'Tálamo', 'Caudate': 'Núcleo caudado', 'Putamen': 'Putâmen',
  'Pallidum': 'Globo pálido', '3rd-Ventricle': '3º ventrículo', '4th-Ventricle': '4º ventrículo', 'Brain-Stem': 'Tronco encefálico',
  'Hippocampus': 'Hipocampo', 'Amygdala': 'Amígdala', 'Accumbens-area': 'Núcleo accumbens', 'VentralDC': 'Diencéfalo ventral',
  'CSF': 'Líquor extraventricular', 'Corpus callosum': 'Corpo caloso', 'CC_Posterior': 'Corpo caloso — esplênio (posterior)',
  'CC_Mid_Posterior': 'Corpo caloso — médio-posterior', 'CC_Central': 'Corpo caloso — central', 'CC_Mid_Anterior': 'Corpo caloso — médio-anterior',
  'CC_Anterior': 'Corpo caloso — joelho (anterior)', 'GM': 'Substância cinzenta', 'WM': 'Substância branca', 'Grey Matter': 'Substância cinzenta',
  'White Matter': 'Substância branca', 'Brain': 'Encéfalo (máscara)',
  // aparc (Desikan-Killiany)
  'bankssts': 'Margens do sulco temporal superior', 'caudalanteriorcingulate': 'Cíngulo anterior caudal', 'caudalmiddlefrontal': 'Frontal médio caudal',
  'cuneus': 'Cúneo', 'entorhinal': 'Entorrinal', 'fusiform': 'Fusiforme', 'inferiorparietal': 'Parietal inferior', 'inferiortemporal': 'Temporal inferior',
  'isthmuscingulate': 'Istmo do cíngulo', 'lateraloccipital': 'Occipital lateral', 'lateralorbitofrontal': 'Orbitofrontal lateral', 'lingual': 'Lingual',
  'medialorbitofrontal': 'Orbitofrontal medial', 'middletemporal': 'Temporal médio', 'parahippocampal': 'Para-hipocampal', 'paracentral': 'Paracentral',
  'parsopercularis': 'Pars opercularis', 'parsorbitalis': 'Pars orbitalis', 'parstriangularis': 'Pars triangularis', 'pericalcarine': 'Pericalcarino',
  'postcentral': 'Pós-central', 'posteriorcingulate': 'Cíngulo posterior', 'precentral': 'Pré-central', 'precuneus': 'Pré-cúneo',
  'rostralanteriorcingulate': 'Cíngulo anterior rostral', 'rostralmiddlefrontal': 'Frontal médio rostral', 'superiorfrontal': 'Frontal superior',
  'superiorparietal': 'Parietal superior', 'superiortemporal': 'Temporal superior', 'supramarginal': 'Supramarginal', 'frontalpole': 'Polo frontal',
  'temporalpole': 'Polo temporal', 'transversetemporal': 'Temporal transverso', 'insula': 'Ínsula'
}

const LOBE = {
  frontal: ['superiorfrontal', 'rostralmiddlefrontal', 'caudalmiddlefrontal', 'parsopercularis', 'parstriangularis', 'parsorbitalis', 'lateralorbitofrontal', 'medialorbitofrontal', 'precentral', 'paracentral', 'frontalpole'],
  parietal: ['superiorparietal', 'inferiorparietal', 'supramarginal', 'postcentral', 'precuneus'],
  temporal: ['superiortemporal', 'middletemporal', 'inferiortemporal', 'bankssts', 'fusiform', 'transversetemporal', 'entorhinal', 'temporalpole', 'parahippocampal'],
  occipital: ['lateraloccipital', 'lingual', 'cuneus', 'pericalcarine'],
  cingulado: ['rostralanteriorcingulate', 'caudalanteriorcingulate', 'posteriorcingulate', 'isthmuscingulate'],
  insula: ['insula']
}
const LOBE_PT = { frontal: 'Lobo frontal', parietal: 'Lobo parietal', temporal: 'Lobo temporal', occipital: 'Lobo occipital', cingulado: 'Córtex cingulado', insula: 'Ínsula' }

/** decompõe um nome FreeSurfer em {hemi: 'L'|'R'|null, base, cortical} */
export function parseName(name) {
  let hemi = null
  let base = name
  if (/^Left-/.test(name)) { hemi = 'L'; base = name.replace(/^Left-/, '') }
  else if (/^Right-/.test(name)) { hemi = 'R'; base = name.replace(/^Right-/, '') }
  else if (/^ctx-lh-/.test(name)) { hemi = 'L'; base = name.replace(/^ctx-lh-/, '') }
  else if (/^ctx-rh-/.test(name)) { hemi = 'R'; base = name.replace(/^ctx-rh-/, '') }
  else if (/^ctx-/.test(name)) { base = name.replace(/^ctx-/, '') }
  const cortical = /^ctx-/.test(name) || name === 'Cerebral-Cortex'
  return { hemi, base, cortical }
}

export function namePT(name) {
  const { hemi, base, cortical } = parseName(name)
  const pt = PT[base] || base
  const side = hemi === 'L' ? ' esquerdo' : hemi === 'R' ? ' direito' : ''
  return cortical && PT[base] ? `Córtex ${pt.charAt(0).toLowerCase() + pt.slice(1)}${side}` : `${pt}${side}`
}

/**
 * @param {object} p
 * @param {Uint8Array} p.labels
 * @param {Uint8Array|Float32Array} p.intensity
 * @param {number[]} p.dims [nx,ny,nz]
 * @param {number[]} p.affine 16 valores row-major (voxel→mm RAS)
 * @param {number} p.voxelVolume mm³
 * @param {Object<string,string>} p.labelNames {"1": "Left-..."}
 * @param {{R:number[],G:number[],B:number[]}} [p.colormap]
 */
export function computeStats({ labels, intensity, dims, affine, voxelVolume, labelNames, colormap }) {
  const [nx, ny, nz] = dims
  const NL = 256
  const count = new Float64Array(NL), sum = new Float64Array(NL), sumsq = new Float64Array(NL)
  const sx = new Float64Array(NL), sy = new Float64Array(NL), sz = new Float64Array(NL)
  const leftN = new Float64Array(NL), rightN = new Float64Array(NL)
  const a = affine
  let idx = 0
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const xBase = a[1] * j + a[2] * k + a[3]
      for (let i = 0; i < nx; i++, idx++) {
        const l = labels[idx]
        if (l === 0) continue
        const v = intensity[idx]
        count[l]++; sum[l] += v; sumsq[l] += v * v
        sx[l] += i; sy[l] += j; sz[l] += k
        if (a[0] * i + xBase < 0) leftN[l]++; else rightN[l]++
      }
    }
  }
  const regions = []
  for (let l = 1; l < NL; l++) {
    const name = labelNames[String(l)]
    if (!name || count[l] === 0) continue
    const n = count[l]
    const mean = sum[l] / n
    const variance = Math.max(0, sumsq[l] / n - mean * mean)
    const ci = sx[l] / n, cj = sy[l] / n, ck = sz[l] / n
    const cx = a[0] * ci + a[1] * cj + a[2] * ck + a[3]
    const cy = a[4] * ci + a[5] * cj + a[6] * ck + a[7]
    const cz = a[8] * ci + a[9] * cj + a[10] * ck + a[11]
    const { hemi, base, cortical } = parseName(name)
    regions.push({
      id: l, name, namePT: namePT(name), hemi, base, cortical,
      rgb: colormap ? [colormap.R[l], colormap.G[l], colormap.B[l]] : [128, 128, 128],
      voxels: n, volume_mm3: n * voxelVolume,
      mean_intensity: mean, sd_intensity: Math.sqrt(variance),
      centroid_ras_mm: [cx, cy, cz],
      left_mm3: leftN[l] * voxelVolume, right_mm3: rightN[l] * voxelVolume
    })
  }
  // ---- compostos
  const is = (r, re) => re.test(r.base)
  const sumOf = (pred) => regions.filter(pred).reduce((s, r) => s + r.volume_mm3, 0)
  const isVentricle = (r) => /Ventricle|Inf-Lat-Vent/.test(r.base)
  const isCSF = (r) => r.base === 'CSF'
  const isCortex = (r) => r.cortical
  const isCerebralWM = (r) => /^Cerebral-White-Matter$|^WM$|^White Matter$/.test(r.base)
  const isCbCortex = (r) => /^Cerebellum-Cortex$|^Cerebellum$/.test(r.base)
  const isCbWM = (r) => /^Cerebellum-White-Matter$/.test(r.base)
  const isBrainstem = (r) => /^Brain-Stem$/.test(r.base)
  const isSubGM = (r) => /^(Thalamus|Thalamus-Proper\*?|Caudate|Putamen|Pallidum|Hippocampus|Amygdala|Accumbens-area|VentralDC)$/.test(r.base)
  const isCC = (r) => /^CC_|^Corpus callosum$/.test(r.base)
  const totalSeg = sumOf(() => true)
  const parenchyma = sumOf((r) => !isVentricle(r) && !isCSF(r))
  const summaries = {
    total_segmented_mm3: totalSeg,
    brain_parenchyma_mm3: parenchyma,
    cortical_gm_mm3: sumOf(isCortex),
    cerebral_wm_mm3: sumOf(isCerebralWM),
    subcortical_gm_mm3: sumOf(isSubGM),
    cerebellum_cortex_mm3: sumOf(isCbCortex),
    cerebellum_wm_mm3: sumOf(isCbWM),
    cerebellum_total_mm3: sumOf((r) => isCbCortex(r) || isCbWM(r)),
    brainstem_mm3: sumOf(isBrainstem),
    ventricles_mm3: sumOf(isVentricle),
    csf_extraventricular_mm3: sumOf(isCSF),
    corpus_callosum_mm3: sumOf(isCC),
    ventricle_brain_ratio_pct: parenchyma > 0 ? (100 * sumOf(isVentricle)) / (parenchyma + sumOf(isVentricle)) : null
  }
  // lobos (só quando há parcelação cortical)
  const lobes = {}
  if (regions.some((r) => r.cortical && LOBE.frontal.includes(r.base))) {
    for (const [lobe, parts] of Object.entries(LOBE)) {
      const L = sumOf((r) => r.cortical && parts.includes(r.base) && r.hemi === 'L')
      const R = sumOf((r) => r.cortical && parts.includes(r.base) && r.hemi === 'R')
      const T = sumOf((r) => r.cortical && parts.includes(r.base))
      lobes[lobe] = { name_pt: LOBE_PT[lobe], total_mm3: T, left_mm3: L || null, right_mm3: R || null }
    }
  }
  // hemisférios: por rótulo (quando há L/R) ou por linha média
  const labeledLR = regions.some((r) => r.hemi)
  const hemispheres = {
    method: labeledLR ? 'rótulos L/R do modelo' : 'divisão pela linha média (x = 0 em RAS), aproximada',
    left_parenchyma_mm3: labeledLR
      ? sumOf((r) => r.hemi === 'L' && !isVentricle(r))
      : regions.filter((r) => !isVentricle(r) && !isCSF(r)).reduce((s, r) => s + r.left_mm3, 0),
    right_parenchyma_mm3: labeledLR
      ? sumOf((r) => r.hemi === 'R' && !isVentricle(r))
      : regions.filter((r) => !isVentricle(r) && !isCSF(r)).reduce((s, r) => s + r.right_mm3, 0)
  }
  // assimetria
  const asymmetry = []
  const ai = (L, R) => (L + R > 0 ? (200 * (L - R)) / (L + R) : null)
  if (labeledLR) {
    const byBase = {}
    for (const r of regions) if (r.hemi) (byBase[r.base] ||= {})[r.hemi] = r
    for (const [base, lr] of Object.entries(byBase)) {
      if (lr.L && lr.R) asymmetry.push({ base, name_pt: namePT(lr.L.name).replace(/ esquerdo$/, ''), left_mm3: lr.L.volume_mm3, right_mm3: lr.R.volume_mm3, ai_pct: ai(lr.L.volume_mm3, lr.R.volume_mm3), method: 'rótulos' })
    }
  } else {
    for (const r of regions) {
      if (isVentricle(r) || isCSF(r) || isBrainstem(r) || isCC(r) || r.base === 'CSF') continue
      asymmetry.push({ base: r.base, name_pt: r.namePT, left_mm3: r.left_mm3, right_mm3: r.right_mm3, ai_pct: ai(r.left_mm3, r.right_mm3), method: 'linha média' })
    }
  }
  for (const r of regions) r.pct_parenchyma = parenchyma > 0 ? (100 * r.volume_mm3) / parenchyma : null
  return { regions, summaries, lobes, hemispheres, asymmetry }
}

/** tabela longa (uma linha por região) */
export function toCSV(result, meta) {
  const esc = (v) => (v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : `"${String(v).replace(/"/g, '""')}"`)
  const head = ['subject_id', 'session', 'model', 'quality_tier', 'pipeline', 'label_id', 'region', 'region_pt', 'hemisphere', 'voxels', 'volume_mm3', 'pct_parenchyma', 'mean_intensity', 'sd_intensity', 'centroid_x', 'centroid_y', 'centroid_z', 'left_mm3_midline', 'right_mm3_midline']
  const rows = [head.join(',')]
  for (const r of result.regions) {
    rows.push([meta.subjectId, meta.session, meta.modelKey, meta.qualityTier, meta.pipeline, r.id, r.name, r.namePT, r.hemi || '', r.voxels, r.volume_mm3, r.pct_parenchyma, r.mean_intensity, r.sd_intensity, ...r.centroid_ras_mm, r.left_mm3, r.right_mm3].map(esc).join(','))
  }
  for (const [k, v] of Object.entries(result.summaries)) rows.push([meta.subjectId, meta.session, meta.modelKey, meta.qualityTier, meta.pipeline, '', k, 'resumo', '', '', v].map(esc).join(','))
  for (const [k, v] of Object.entries(result.lobes)) rows.push([meta.subjectId, meta.session, meta.modelKey, meta.qualityTier, meta.pipeline, '', 'lobe_' + k, v.name_pt, '', '', v.total_mm3].map(esc).join(','))
  return '\ufeff' + rows.join('\r\n')
}

/** linha larga (uma linha por sujeito): usada para CSV de coorte e SAV */
export function toWideRow(result, meta) {
  const row = {
    subject_id: meta.subjectId, session: meta.session || '', acquisition: meta.acquisition || '', model: meta.modelKey,
    quality_tier: meta.qualityTier, pipeline: meta.pipeline, voxel_min_mm: meta.voxMin, voxel_max_mm: meta.voxMax, n_slices: meta.nSlices,
    processed_at: meta.processedAt
  }
  for (const [k, v] of Object.entries(result.summaries)) row[k] = v
  row.left_parenchyma_mm3 = result.hemispheres.left_parenchyma_mm3
  row.right_parenchyma_mm3 = result.hemispheres.right_parenchyma_mm3
  for (const [k, v] of Object.entries(result.lobes)) { row[`lobe_${k}_mm3`] = v.total_mm3; if (v.left_mm3 != null) { row[`lobe_${k}_L_mm3`] = v.left_mm3; row[`lobe_${k}_R_mm3`] = v.right_mm3 } }
  for (const r of result.regions) row[`${r.name}_mm3`] = r.volume_mm3
  for (const a of result.asymmetry) row[`AI_${a.base}_pct`] = a.ai_pct
  return row
}
