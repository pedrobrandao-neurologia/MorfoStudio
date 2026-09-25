// fusion.test.mjs — regras da fusão aseg 18 + aparc+aseg 104 num fantoma pequeno (eixo i = esquerda, como em LIA).
import { check, done, js } from '../helpers.mjs'
const { fuseAsegAparc } = await import(js('fusion.js'))

const names104 = { 0: 'BG', 1: 'ctx-lh-precentral', 2: 'ctx-rh-precentral', 3: 'ctx-lh-insula', 69: 'Left-Thalamus-Proper*', 70: 'Right-Thalamus-Proper*', 77: 'Left-Hippocampus', 78: 'Right-Hippocampus', 85: 'Left-Cerebral-White-Matter', 86: 'Right-Cerebral-White-Matter', 88: 'Left-Inf-Lat-Vent', 90: 'Right-Inf-Lat-Vent', 93: 'CSF', 94: 'Brain-Stem', 101: 'CC_Central' }
const names18 = { 0: 'Unknown', 1: 'Cerebral-White-Matter', 2: 'Cerebral-Cortex', 4: 'Inferior-Lateral-Ventricle', 7: 'Thalamus', 13: 'Brain-Stem', 14: 'Hippocampus' }
const nx = 20, ny = 6, nz = 6, n = nx * ny * nz
const idx = (i, j, k) => i + j * nx + k * nx * ny
const aparc = new Uint8Array(n), aseg = new Uint8Array(n)
// hemisférios pela substância branca do 104: i ≥ 10 esquerda, i < 10 direita
for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
  aparc[idx(i, j, k)] = i >= 10 ? 85 : 86
  aseg[idx(i, j, k)] = 1
}
// 1) aseg diz hipocampo onde o 104 diz substância branca → hipocampo do lado certo
aseg[idx(15, 2, 2)] = 14; aseg[idx(4, 2, 2)] = 14
// 2) 104 diz tálamo e o aseg diz substância branca → vira substância branca (o aseg manda no subcortical)
aparc[idx(12, 3, 3)] = 69
// 3) corpo caloso do 104 preservado sobre substância branca do aseg
aparc[idx(10, 0, 0)] = 101
// 4) LCR do 104 preservado onde o aseg diz fundo; fundo do aseg zera o resto
aparc[idx(0, 5, 5)] = 93; aseg[idx(0, 5, 5)] = 0
aseg[idx(1, 5, 5)] = 0
// 5) fita cortical: linha j=0,k=5, i=11..19 é córtex no aseg; o 104 só rotula i=19 (precentral) e i=11 (insula)
for (let i = 11; i < 20; i++) aseg[idx(i, 0, 5)] = 2
aparc[idx(19, 0, 5)] = 1; aparc[idx(11, 0, 5)] = 3
// 6) estrutura sem lado no meio sem vizinho lateralizado: tronco
aseg[idx(9, 1, 1)] = 13
// 7) ventrículo inferior: alias Inferior-Lateral-Ventricle → Inf-Lat-Vent
aseg[idx(3, 4, 4)] = 4

const { labels: out, stats } = fuseAsegAparc({ aparc, aseg, names104, names18, dims: [nx, ny, nz] })
check(out[idx(15, 2, 2)] === 77 && out[idx(4, 2, 2)] === 78, 'hipocampo do aseg recebe o lado pelos rótulos L/R do 104')
check(out[idx(12, 3, 3)] === 85, 'subcortical só do 104 (sem apoio do aseg) vira a classe do aseg')
check(out[idx(10, 0, 0)] === 101, 'corpo caloso do 104 preservado')
check(out[idx(0, 5, 5)] === 93 && out[idx(1, 5, 5)] === 0, 'LCR do 104 preservado; fundo do aseg vira fundo')
check(out[idx(19, 0, 5)] === 1 && out[idx(11, 0, 5)] === 3, 'sementes da fita mantêm a parcela do 104')
check(out[idx(18, 0, 5)] === 1 && out[idx(12, 0, 5)] === 3, 'fita sem parcela recebe a parcela mais próxima (BFS geodésico)')
check([...Array(9).keys()].every((d) => [1, 3].includes(out[idx(11 + d, 0, 5)])), 'toda a fita rotulada com parcelas ctx')
check(stats.ribbonVoxels === 9 && stats.seedVoxels === 2 && stats.orphanVoxels === 0, `estatísticas da fusão (${JSON.stringify(stats)})`)
check(out[idx(9, 1, 1)] === 94, 'estrutura de linha média (tronco) sem lado')
check(out[idx(3, 4, 4)] === 90, 'Inferior-Lateral-Ventricle → Right-Inf-Lat-Vent')
let bad = false
try { fuseAsegAparc({ aparc, aseg: new Uint8Array(3), names104, names18, dims: [nx, ny, nz] }) } catch { bad = true }
check(bad, 'tamanhos diferentes → erro')
done('fusion')
