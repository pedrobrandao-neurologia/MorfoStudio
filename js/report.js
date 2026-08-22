// report.js — relatório PDF de volumetria
import { MiniPDF, textWidth } from './pdf.js'

const INK = [30, 34, 41], BONE = [232, 227, 217], MUTED = [110, 116, 128], DARK = [28, 28, 30], LINE = [200, 200, 200]
const TIER_COLOR = { A: [63, 163, 77], B: [109, 159, 58], C: [230, 148, 34], D: [205, 62, 78] }
const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }))

export function buildReport({ meta, quality, result, snapshot, modelInfo }) {
  const pdf = new MiniPDF()
  const M = 40, W = 595.28 - 2 * M
  let page = 0
  const header = () => {
    pdf.addPage(); page++
    pdf.rect(0, 0, 595.28, 54, INK)
    pdf.text(M, 34, 'Morfo Studio', { size: 17, bold: true, color: BONE })
    pdf.text(M + 118, 34, 'relatório de volumetria cerebral', { size: 10, color: [185, 180, 170] })
    pdf.text(595.28 - M, 34, `${meta.subjectId}${meta.session ? ' · ' + meta.session : ''}`, { size: 10, bold: true, color: BONE, align: 'right' })
    return 80
  }
  const footer = () => {
    pdf.line(M, 805, 595.28 - M, 805, LINE)
    pdf.text(M, 818, `Gerado em ${meta.processedAt} · uso em pesquisa; não substitui laudo. Modelos brainchop (MeshNet), conformação 256³/1 mm.`, { size: 7.5, color: MUTED })
    pdf.text(595.28 - M, 818, `p. ${page}`, { size: 7.5, color: MUTED, align: 'right' })
  }
  const ensure = (y, need) => { if (y + need > 790) { footer(); return header() } return y }

  // ---------- página 1
  let y = header()
  // metadados
  pdf.text(M, y, 'Exame', { size: 11, bold: true }); y += 6
  const kv = [
    ['Origem', meta.sourceKind === 'dicom' ? `DICOM (${meta.nFiles} arquivos) → dcm2niix` : 'NIfTI'],
    ['Série / arquivo', meta.acquisition || meta.fileName || '—'],
    ['Dimensões', `${meta.dims.join(' × ')} voxels · ${meta.vox.map((v) => v.toFixed(2)).join(' × ')} mm`],
    ['Contraste', quality.contrast],
    ['Modelo', `${modelInfo.label} (${modelInfo.key}) · backend ${meta.backend}`],
    ['Pipeline', meta.pipeline === 'robusto' ? `robusto — ${meta.robustLog.join('; ')}` : 'padrão (conformação 256³ linear, normalização por quantis)'],
    ['Tempo', `${meta.elapsedS} s`]
  ]
  for (const [k, v] of kv) { y += 13; pdf.text(M, y, k, { size: 9, color: MUTED }); pdf.text(M + 95, y, v, { size: 9, maxWidth: W - 95 }) }
  y += 22
  // qualidade
  pdf.text(M, y, 'Qualidade da entrada', { size: 11, bold: true })
  pdf.rect(M + 130, y - 10, 22, 13, TIER_COLOR[quality.tier])
  pdf.text(M + 141, y, quality.tier, { size: 9, bold: true, color: [255, 255, 255], align: 'center' })
  pdf.text(M + 158, y, quality.tierLabel, { size: 10, bold: true })
  y += 8
  // régua
  const rx0 = M, rx1 = M + W
  const lo = Math.log(0.5), hi = Math.log(10)
  const X = (mm) => rx0 + ((Math.log(Math.max(0.5, Math.min(10, mm))) - lo) / (hi - lo)) * (rx1 - rx0)
  const bands = [[0.5, 1.25, TIER_COLOR.A, 'domínio'], [1.25, 2, TIER_COLOR.B, 'aceitável'], [2, 8, TIER_COLOR.C, 'robusto'], [8, 10, TIER_COLOR.D, '']]
  for (const [a, b, c, l] of bands) { pdf.rect(X(a), y + 4, X(b) - X(a), 8, c); if (l) pdf.text((X(a) + X(b)) / 2, y + 22, l, { size: 7, color: MUTED, align: 'center' }) }
  for (const t of [0.5, 1, 1.5, 2, 3, 5, 8, 10]) { pdf.line(X(t), y + 12, X(t), y + 15, MUTED, 0.5); pdf.text(X(t), y + 30, String(t), { size: 6.5, color: MUTED, align: 'center' }) }
  const mx = X(quality.voxMax)
  pdf.rect(mx - 0.75, y - 4, 1.5, 17, DARK)
  pdf.text(mx, y - 6, `corte ${quality.voxMax.toFixed(1)} mm`, { size: 7.5, bold: true, align: 'center' })
  y += 40
  for (const r of quality.reasons) { y = pdf.paragraph(M + 8, y, '• ' + r, { size: 8.5, width: W - 8, color: [60, 60, 60] }) }
  y += 8
  // imagem
  if (snapshot) {
    const maxW = W, maxH = 250
    const s = Math.min(maxW / snapshot.w, maxH / snapshot.h)
    const dw = snapshot.w * s, dh = snapshot.h * s
    y = ensure(y, dh + 20)
    pdf.rect(M, y, dw, dh, [20, 23, 28])
    pdf.image(snapshot.bytes, snapshot.w, snapshot.h, M, y, dw, dh)
    y += dh + 6
    pdf.text(M, y, 'Sobreposição da segmentação no volume conformado (captura do visualizador).', { size: 7.5, color: MUTED })
    y += 16
  }
  // resumo
  y = ensure(y, 120)
  pdf.text(M, y, 'Resumo volumétrico (mm³)', { size: 11, bold: true }); y += 10
  const S = result.summaries
  const cards = [
    ['Parênquima encefálico', S.brain_parenchyma_mm3], ['Substância cinzenta cortical', S.cortical_gm_mm3], ['Substância branca cerebral', S.cerebral_wm_mm3],
    ['Cinzenta subcortical', S.subcortical_gm_mm3], ['Cerebelo (total)', S.cerebellum_total_mm3], ['Tronco encefálico', S.brainstem_mm3],
    ['Ventrículos', S.ventricles_mm3], ['Corpo caloso', S.corpus_callosum_mm3], ['Razão ventrículo/encéfalo', S.ventricle_brain_ratio_pct != null ? fmt(S.ventricle_brain_ratio_pct, 2) + ' %' : null]
  ].filter(([, v]) => v != null && v !== 0)
  const cw = W / 3, chh = 30
  cards.forEach(([l, v], i) => {
    const cx = M + (i % 3) * cw, cy = y + Math.floor(i / 3) * (chh + 5)
    pdf.rect(cx, cy, cw - 5, chh, [243, 242, 240])
    pdf.text(cx + 7, cy + 11, l, { size: 7.5, color: MUTED })
    pdf.text(cx + 7, cy + 24, typeof v === 'string' ? v : fmt(v), { size: 11, bold: true })
  })
  y += Math.ceil(cards.length / 3) * (chh + 5) + 6
  const Hm = result.hemispheres
  y = pdf.paragraph(M, y, `Hemisférios (${Hm.method}): esquerdo ${fmt(Hm.left_parenchyma_mm3)} mm³ · direito ${fmt(Hm.right_parenchyma_mm3)} mm³.`, { size: 8.5, width: W, color: [60, 60, 60] })
  if (Object.keys(result.lobes).length) {
    const lob = Object.values(result.lobes).map((l) => `${l.name_pt} ${fmt(l.total_mm3)}${l.left_mm3 != null ? ` (E ${fmt(l.left_mm3)} / D ${fmt(l.right_mm3)})` : ''}`).join(' · ')
    y = pdf.paragraph(M, y, `Lobos (mm³): ${lob}.`, { size: 8.5, width: W, color: [60, 60, 60] })
  }

  // ---------- tabela de regiões
  y = ensure(y + 10, 60)
  pdf.text(M, y, 'Regiões', { size: 11, bold: true }); y += 12
  const cols = [['Região', M + 14, 'left'], ['FreeSurfer', M + 215, 'left'], ['Volume mm³', M + 395, 'right'], ['% parênq.', M + 445, 'right'], ['Méd.', M + 485, 'right'], ['DP', M + 515, 'right']]
  const tableHead = () => {
    pdf.rect(M, y - 9, W, 13, [236, 236, 236])
    for (const [l, x, al] of cols) pdf.text(x, y, l, { size: 7.5, bold: true, align: al, color: [60, 60, 60] })
    y += 12
  }
  tableHead()
  const sorted = [...result.regions].sort((a, b) => (a.cortical === b.cortical ? b.volume_mm3 - a.volume_mm3 : a.cortical ? 1 : -1))
  for (const r of sorted) {
    if (y + 11 > 790) { footer(); y = header(); tableHead() }
    pdf.rect(M + 2, y - 6.5, 7, 7, r.rgb)
    pdf.text(cols[0][1], y, r.namePT, { size: 7.5, maxWidth: 195 })
    pdf.text(cols[1][1], y, r.name, { size: 7, color: MUTED, maxWidth: 170 })
    pdf.text(cols[2][1], y, fmt(r.volume_mm3), { size: 7.5, align: 'right' })
    pdf.text(cols[3][1], y, fmt(r.pct_parenchyma, 2), { size: 7.5, align: 'right' })
    pdf.text(cols[4][1], y, fmt(r.mean_intensity, 1), { size: 7.5, align: 'right' })
    pdf.text(cols[5][1], y, fmt(r.sd_intensity, 1), { size: 7.5, align: 'right' })
    pdf.line(M, y + 3, M + W, y + 3, [232, 232, 232], 0.4)
    y += 10.5
  }
  // ---------- assimetria
  if (result.asymmetry.length) {
    y = ensure(y + 12, 50)
    pdf.text(M, y, `Índice de assimetria — 2(E−D)/(E+D) × 100 (${result.asymmetry[0].method})`, { size: 11, bold: true }); y += 12
    pdf.rect(M, y - 9, W, 13, [236, 236, 236])
    pdf.text(M + 4, y, 'Estrutura', { size: 7.5, bold: true }); pdf.text(M + 330, y, 'Esq. mm³', { size: 7.5, bold: true, align: 'right' }); pdf.text(M + 410, y, 'Dir. mm³', { size: 7.5, bold: true, align: 'right' }); pdf.text(M + 480, y, 'IA %', { size: 7.5, bold: true, align: 'right' })
    y += 12
    for (const a of [...result.asymmetry].sort((p, q) => Math.abs(q.ai_pct ?? 0) - Math.abs(p.ai_pct ?? 0))) {
      if (y + 11 > 790) { footer(); y = header() }
      const flag = Math.abs(a.ai_pct ?? 0) > 10
      pdf.text(M + 4, y, a.name_pt, { size: 7.5, maxWidth: 260 })
      pdf.text(M + 330, y, fmt(a.left_mm3), { size: 7.5, align: 'right' }); pdf.text(M + 410, y, fmt(a.right_mm3), { size: 7.5, align: 'right' })
      pdf.text(M + 480, y, fmt(a.ai_pct, 1), { size: 7.5, align: 'right', bold: flag, color: flag ? TIER_COLOR.D : DARK })
      y += 10.5
    }
  }
  // ---------- métodos e ressalvas
  y = ensure(y + 14, 140)
  pdf.text(M, y, 'Métodos e ressalvas', { size: 11, bold: true }); y += 12
  const paras = [
    `Processamento inteiramente local no navegador. ${meta.sourceKind === 'dicom' ? 'Conversão DICOM→NIfTI por dcm2niix (WebAssembly). ' : ''}O volume foi conformado ao padrão FreeSurfer (256³, 1 mm isotrópico, uint8 com normalização robusta por quantis) e segmentado por rede MeshNet do projeto brainchop (${modelInfo.label}); rótulos filtrados por componentes conexos. Volumes = nº de voxels rotulados × 1 mm³ no espaço conformado.`,
    meta.pipeline === 'robusto'
      ? 'Ramo robusto: antes da conformação, os eixos com espaçamento > 1,15 × alvo foram reamostrados por interpolação cúbica (Catmull-Rom), o campo de viés foi corrigido por filtragem homomórfica (σ ≈ 30 mm) e, se habilitado, aplicou-se suavização 3D. Isso mitiga, sem eliminar, o erro de volume parcial de cortes espessos; não equivale a SynthSR/SynthSeg, que usam redes treinadas com domain randomization.'
      : 'Ramo padrão: o exame está dentro ou próximo do domínio de treino (T1 ≈ 1 mm isotrópico).',
    `Interpretação: nível ${quality.tier} (${quality.tierLabel}). Modelos MeshNet têm acurácia inferior à do recon-all/SynthSeg em estruturas pequenas (amígdala, accumbens, corno temporal) e em córtex fino; recomenda-se uso em estudos de grupo com covariáveis de aquisição (espessura, contraste, campo) e inspeção visual de cada caso. O volume intracraniano total (eTIV) não é estimado; normalize por parênquima total ou por eTIV externo.`,
    'Referências: Masoud et al., brainchop: in-browser MRI volumetric segmentation (JOSS 2023); Fedorov et al., MeshNet (2017); Hanayik & Rorden, NiiVue; Li et al., dcm2niix (2016); Billot et al., SynthSeg (Med Image Anal 2023); Iglesias et al., SynthSR (Sci Adv 2023); Gopinath et al., recon-all-clinical (2024).'
  ]
  for (const p of paras) y = pdf.paragraph(M, y, p, { size: 8.5, width: W, color: [60, 60, 60] }) + 4
  footer()
  return pdf.build()
}
