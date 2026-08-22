# Morfo Studio

Morfometria cerebral no navegador: **DICOM ou NIfTI → conformação 256³/1 mm → segmentação (aparc+aseg, cerebelo, tronco, corpo caloso) → estatísticas → CSV / JSON / SAV / PDF / NIfTI**. PWA instalável, 100 % local, funciona offline depois da primeira visita.

Arquitetura inspirada no [brain2print](https://github.com/niivue/brain2print) e no [brainchop](https://github.com/neuroneural/brainchop): mesmo visualizador (NiiVue), mesma conformação FreeSurfer-style, mesmos modelos MeshNet. O que foi acrescentado:

| Bloco | Implementação |
|---|---|
| DICOM → NIfTI | `dcm2niix` em WebAssembly (`@niivue/dcm2niix`), com seleção de série e leitura do sidecar JSON |
| Régua de qualidade | `js/quality.js` — classifica o exame em A–D (voxel, anisotropia, nº de cortes, FOV, contraste, campo) e escolhe o ramo do pipeline |
| Modo robusto | `js/preprocess-worker.js` — reamostragem cúbica (Catmull-Rom) dos eixos espessos, correção homomórfica de campo de viés, suavização opcional. Aproximação clássica do que SynthSR/SynthSeg fazem por rede |
| Segmentação | `js/brainchop-webworker.js` (MIT, brainchop) com modelos `aseg 18`, `aparc+aseg 50`, `aparc+aseg 104`, tecidos e máscara; backend WebGL ou CPU; modo baixa memória |
| Estatísticas | `js/stats.js` — volume, %, intensidade, centroide RAS, hemisférios (rótulos L/R ou linha média), lobos de Desikan, cerebelo, tronco, ventrículos, corpo caloso, índice de assimetria |
| Exportação | CSV longo, JSON completo, **SAV** (`js/sav.js`, escritor SPSS nativo), **PDF** (`js/pdf.js` + `js/report.js`, sem dependências), NIfTI da segmentação e do volume conformado, pacote ZIP |
| Coorte | uma linha por sujeito salva no navegador; exporta CSV largo e SAV para SPSS/R |

## Publicar no GitHub Pages

1. Copie a pasta inteira para um repositório (ex.: `morfo-studio`).
2. Settings → Pages → *Deploy from a branch* → `main` / `/ (root)`.
3. Abra `https://<usuário>.github.io/morfo-studio/`. O service worker (`sw.js`) pré-carrega vendor, modelos e fontes (~8 MB) para uso offline.

Funciona em qualquer servidor estático (inclusive `python -m http.server`). Não funciona via `file://` (workers ES module e service worker exigem HTTP).

Ao alterar arquivos, mude `VERSION` em `sw.js` para invalidar o cache dos usuários.

## Requisitos do navegador

- Chrome/Edge ≥ 114, Firefox ≥ 114, Safari ≥ 16.4 (workers com módulos ES, `CompressionStream`, WebGL2).
- Segmentação aparc+aseg 104 em GPU dedicada: 10–60 s. Em GPU integrada ou CPU: minutos; use **Baixa memória** se aparecer erro de textura.
- Safari limita a memória do WebGL; prefira `aseg 18` ou o modo baixa memória.

## Limites honestos

- Os modelos MeshNet foram treinados em **T1 ~1 mm isotrópico**. O modo robusto reduz o artefato de cortes espessos mas **não** é o SynthSeg/SynthSR. Para FLAIR 5 mm, TC ou baixo campo, rode `mri_synthseg --robust` / `recon-all-clinical` no FreeSurfer e importe o NIfTI de saída aqui apenas para estatísticas e relatório.
- Não há estimativa de eTIV; normalize pelo parênquima total ou por eTIV externo.
- Estruturas pequenas (amígdala, accumbens, corno temporal) têm erro maior; inspecione cada caso.
- Uso em pesquisa; não substitui laudo.

## Modelo próprio

Selecione *Modelo próprio (tfjs, URL)* e informe `model.json` + `labels.json` hospedados com CORS (GitHub Pages serve). O modelo deve aceitar um tensor `[1, 256, 256, 256, 1]` uint8 conformado (convenção brainchop). Redes SynthSeg convertidas para tfjs se encaixam aqui.

## Estrutura

```
index.html  styles.css  manifest.json  sw.js
js/   app.js  quality.js  preprocess-worker.js  stats.js  sav.js  pdf.js  report.js  zip.js  nifti-writer.js
      brainchop-webworker.js  brainchop-parameters.js  tensor-utils.js  bwlabels.js   (brainchop, MIT)
vendor/  niivue.min.js (NiiVue 0.69 ESM)  tf.fesm.min.js (TensorFlow.js 4.22)  dcm2niix/ (WASM)
models/  model5_gw_ae  model20chan3cls  model30chan18cls  model30chan50cls  model21_104class
fonts/   Archivo, Source Sans 3, JetBrains Mono (OFL)
licenses/
```

## Análise em R

```r
library(haven)
d <- read_sav("morfo_coorte_2026-08-22.sav")
# ou
d <- read.csv("morfo_coorte_2026-08-22.csv")
d$icv_proxy <- d$brain_parenchyma_mm3 + d$ventricles_mm3 + d$csf_extraventricular_mm3
d$hip_L_norm <- d$Left.Hippocampus_mm3 / d$icv_proxy
```

## Créditos

brainchop (Masoud, Hossein, Plis — MeshNet; MIT) · NiiVue (Rorden, Hanayik; BSD) · dcm2niix (Rorden; BSD) · TensorFlow.js (Apache 2.0) · fontes via Fontsource (OFL). Ver `licenses/`.
