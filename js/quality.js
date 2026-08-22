// quality.js — compara o exame com o domínio de treino dos modelos (T1 isotrópico ~1 mm, cobertura total)
// e decide o ramo do pipeline. A régua é a peça central da interface: mostra onde o exame cai.

export function detectContrast({ sidecar = {}, fileName = '', description = '' }) {
  const txt = `${sidecar.SeriesDescription || ''} ${sidecar.ProtocolName || ''} ${sidecar.SequenceName || ''} ${fileName} ${description}`.toLowerCase()
  const imageType = (sidecar.ImageType || []).join(' ').toLowerCase()
  if ((sidecar.Modality || '').toUpperCase() === 'CT' || /\bct\b|tomograf/.test(txt)) return 'CT'
  if (/flair|dark.?fluid|tirm/.test(txt)) return 'FLAIR'
  if (/\bt2\b|t2w|tse|fse|space_t2/.test(txt) && !/t1/.test(txt)) return 'T2'
  if (/\bpd\b|proton/.test(txt)) return 'PD'
  if (/t1|mprage|mp2rage|spgr|bravo|tfe|fspgr|3d_t1|rage/.test(txt)) return 'T1'
  if (/swi|swan|venobold/.test(txt)) return 'SWI'
  if (/dwi|dti|diffusion|adc|trace/.test(txt)) return 'DWI'
  const te = Number(sidecar.EchoTime), tr = Number(sidecar.RepetitionTime), ti = Number(sidecar.InversionTime)
  if (Number.isFinite(te) && Number.isFinite(tr)) {
    if (te > 0.06) return 'T2'
    if (te < 0.02 && (tr < 1.0 || Number.isFinite(ti))) return 'T1'
  }
  if (/original primary m/.test(imageType) && Number.isFinite(ti)) return 'T1'
  return 'desconhecido'
}

/**
 * @param {object} p
 * @param {number[]} p.pixDims [dx,dy,dz] mm
 * @param {number[]} p.dims [nx,ny,nz]
 * @param {string} p.contrast
 * @param {object} [p.sidecar]
 */
export function assessQuality({ pixDims, dims, contrast, sidecar = {} }) {
  const vox = pixDims.slice(0, 3).map((v) => Math.abs(v) || 1)
  const voxMin = Math.min(...vox), voxMax = Math.max(...vox)
  const thickAxis = vox.indexOf(voxMax)
  const nSlices = dims[thickAxis]
  const fov = dims.map((n, i) => n * vox[i])
  const aniso = voxMax / voxMin
  const reasons = []
  let tier = 'A'
  const bump = (t) => { if ('ABCD'.indexOf(t) > 'ABCD'.indexOf(tier)) tier = t }

  if (voxMax <= 1.25) reasons.push(`Voxel ${vox.map((v) => v.toFixed(2)).join(' × ')} mm: dentro do domínio de treino (≤ 1,25 mm).`)
  else if (voxMax <= 2.0) { bump('B'); reasons.push(`Corte de ${voxMax.toFixed(1)} mm: aceitável; esperar suavização de bordas finas (hipocampo, córtex).`) }
  else if (voxMax <= 8) { bump('C'); reasons.push(`Corte de ${voxMax.toFixed(1)} mm: fora do domínio; modo robusto reamostra antes de conformar.`) }
  else { bump('D'); reasons.push(`Corte de ${voxMax.toFixed(1)} mm: volumetria inviável com segurança.`) }

  if (aniso > 3 && voxMax > 2) reasons.push(`Anisotropia ${aniso.toFixed(1)}:1 — volumes no eixo espesso terão erro de volume parcial.`)
  if (nSlices < 8) { bump('D'); reasons.push(`${nSlices} cortes: cobertura insuficiente.`) }
  else if (nSlices < 40 && voxMax > 2) reasons.push(`${nSlices} cortes no eixo ${'xyz'[thickAxis]}.`)
  const minFov = Math.min(...fov)
  if (minFov < 100) { bump('D'); reasons.push(`Campo de visão de ${minFov.toFixed(0)} mm em um eixo: provável cobertura parcial do encéfalo.`) }
  else if (minFov < 140) { bump('C'); reasons.push(`Campo de visão de ${minFov.toFixed(0)} mm: verifique se cerebelo e vértice estão incluídos.`) }

  if (contrast === 'T1') reasons.push('Contraste T1: o mesmo dos dados de treino.')
  else if (contrast === 'desconhecido') { bump('B'); reasons.push('Contraste não identificado: confirme no seletor.') }
  else if (contrast === 'CT') { bump('D'); reasons.push('Tomografia: os modelos MeshNet não foram treinados em TC.') }
  else { bump('C'); reasons.push(`Contraste ${contrast}: fora do domínio de treino (T1); resultados exploratórios.`) }

  const b0 = Number(sidecar.MagneticFieldStrength)
  if (Number.isFinite(b0) && b0 < 1.0) { bump('C'); reasons.push(`Campo de ${b0} T: relação sinal-ruído baixa; ative a suavização.`) }

  const pipeline = tier === 'A' || tier === 'B' ? 'padrao' : 'robusto'
  const tierLabel = { A: 'Domínio do modelo', B: 'Aceitável', C: 'Fora do domínio', D: 'Inviável / exploratório' }[tier]
  return { vox, voxMin, voxMax, thickAxis, nSlices, fov, aniso, contrast, tier, tierLabel, reasons, pipeline }
}

/** régua SVG: escala logarítmica 0,5–10 mm; faixas de domínio; marcador da espessura e do voxel no plano */
export function renderRuler(q) {
  const W = 340, H = 58, x0 = 8, x1 = W - 8
  const lo = Math.log(0.5), hi = Math.log(10)
  const X = (mm) => x0 + ((Math.log(Math.max(0.5, Math.min(10, mm))) - lo) / (hi - lo)) * (x1 - x0)
  const band = (a, b, color, label) => `<rect x="${X(a).toFixed(1)}" y="22" width="${(X(b) - X(a)).toFixed(1)}" height="10" fill="${color}" opacity="0.85"/>` +
    `<text x="${((X(a) + X(b)) / 2).toFixed(1)}" y="45" text-anchor="middle" font-size="9" fill="#8f95a0" font-family="JetBrains Mono, monospace">${label}</text>`
  const ticks = [0.5, 1, 1.5, 2, 3, 5, 8, 10].map((t) => `<line x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="32" y2="36" stroke="#5a6270" stroke-width="1"/><text x="${X(t).toFixed(1)}" y="56" text-anchor="middle" font-size="8.5" fill="#6b7380" font-family="JetBrains Mono, monospace">${t}</text>`).join('')
  const mark = (mm, color, label, dy) => `<g><line x1="${X(mm).toFixed(1)}" x2="${X(mm).toFixed(1)}" y1="${dy}" y2="34" stroke="${color}" stroke-width="2"/>` +
    `<polygon points="${(X(mm) - 5).toFixed(1)},${dy} ${(X(mm) + 5).toFixed(1)},${dy} ${X(mm).toFixed(1)},${dy + 6}" fill="${color}"/>` +
    `<text x="${X(mm).toFixed(1)}" y="${dy - 3}" text-anchor="middle" font-size="9.5" font-weight="600" fill="${color}" font-family="JetBrains Mono, monospace">${label} ${mm.toFixed(mm < 10 ? 1 : 0)} mm</text></g>`
  const inplane = Math.max(...q.vox.filter((_, i) => i !== q.thickAxis))
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Régua de espessura de corte">
    ${band(0.5, 1.25, '#3fa34d', 'domínio')}${band(1.25, 2, '#6d9f3a', 'aceitável')}${band(2, 8, '#e69422', 'robusto')}${band(8, 10, '#cd3e4e', '')}
    ${ticks}
    ${Math.abs(inplane - q.voxMax) > 0.05 ? mark(inplane, '#9a6fb8', 'plano', 14) : ''}
    ${mark(q.voxMax, q.tier === 'A' ? '#3fa34d' : q.tier === 'B' ? '#6d9f3a' : q.tier === 'C' ? '#e69422' : '#cd3e4e', 'corte', 14)}
  </svg>`
}
