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
| Hipocampo | `js/hippocampus.js` + `js/hippocampus-worker.js` — refinamento da máscara, coordenadas longitudinais por equação de Laplace (método do HippUnfold) e parcelamento cabeça/corpo/cauda com morfometria; ver seção abaixo |
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

## Segmentação hipocampal (cabeça · corpo · cauda)

Depois de segmentar com um modelo que rotule o hipocampo (`aseg 18`, `aparc+aseg 50/104`), o painel **Hipocampo** roda uma análise dedicada, inteiramente no navegador (`js/hippocampus-worker.js`):

1. **Localização** — caixa envolvente do rótulo *Hippocampus* por hemisfério (rótulos L/R do modelo, ou linha média quando o modelo funde os lados), com margem de 6 voxels. Análogo ao ROILoc do HSF e ao recorte inicial do HippUnfold.
2. **Refinamento da máscara** (opcional, ligado por padrão) — modelo de intensidade robusto (mediana ± k·MAD) estimado dentro do rótulo; crescimento geodésico limitado (2 iterações, 6-vizinhança) apenas sobre rótulos corticais adjacentes; remoção de outliers (> 3,5 σ, ex.: líquor do corno temporal); fechamento morfológico; preenchimento de cavidades; maior componente conexo. Versão clássica e transparente do papel que a inferência bayesiana contraste-adaptativa cumpre no FreeSurfer `segmentHA`.
3. **Coordenada longitudinal por equação de Laplace** — ∇²φ = 0 no interior da máscara, φ=0 na extremidade anterior e φ=1 na posterior (tampas definidas pelos percentis 5/95 da projeção no eixo principal por PCA), Neumann na borda. É o núcleo metodológico do HippUnfold (que resolve os três eixos AP/PD/IO por Jacobi até SSD < 1e-5); aqui usamos Gauss-Seidel com sobre-relaxação (ω = 1,7) inicializado pela projeção no eixo, e só o eixo AP.
4. **Reparametrização por comprimento de arco** — φ é harmônica, não linear em distância; o campo é convertido em fração do comprimento da polilinha de centroides (40 bins), de modo que os cortes sejam frações geométricas reais do eixo.
5. **Cabeça / corpo / cauda** — cortes em ⅓ e ⅔ do comprimento de arco. Os marcos anatômicos da convenção de Poppenk et al. (TiCS 2013) são o *uncal apex* (cabeça/corpo) e os colículos / crus do fórnice (corpo/cauda); sem contraste para identificá-los automaticamente em T1 1 mm, usamos o *fallback* proporcional em terços descrito na mesma literatura. As frações são ajustáveis (`options.headFrac/tailFrac`).
6. **Morfometria** — volumes por subregião, comprimento do eixo central, área de secção média, diâmetro equivalente, maior esfera inscrita (transformada de distância chanfrada 3-4-5), área de superfície voxelizada (superestima ~1,5× uma malha suave), esfericidade, contraste de borda (QC) e índices de assimetria E/D por subregião. Tudo exportado em CSV próprio, colunas na linha larga da coorte/SAV, JSON, PDF e NIfTI dos rótulos (códigos 1–3 esquerdo, 4–6 direito).

### Por que não subcampos (CA1–CA4, GD, subículo)?

**Em T1 ~1 mm não há contraste para delinear subcampos com segurança.** A lâmina SRLM, que define as fronteiras internas, é praticamente invisível nessa resolução; segmentações de subcampos em T1 1 mm são guiadas pelo *prior* do atlas, não pela imagem — a recomendação explícita de Wisse et al. (Hum Brain Mapp 2021, "a note of caution") é **não reportar volumes de subcampos de T1 1 mm isolado**. Por isso este módulo entrega subregiões longitudinais (validáveis geometricamente) e não subcampos.

### Como as ferramentas de referência diferem entre si

Os protocolos de rotulagem **não são intercambiáveis** (FreeSurfer ≠ ASHS ≠ HippUnfold ≠ HSF) — comparação independente em Sghirripa et al., Hum Brain Mapp 2025 (DOI 10.1002/hbm.70200):

| Ferramenta | Método | Entrada | Saída | Observações |
|---|---|---|---|---|
| [HippUnfold](https://github.com/khanlab/hippunfold) | nnU-Net (9 classes teciduais) + injeção de forma de template ex vivo + coordenadas de Laplace (AP/PD/IO) + atlas de subcampos em espaço "desdobrado" (BigBrain) | T1w ou T2w (BIDS) | Sub, CA1–CA4, GD, SRLM + espessura, curvatura, girificação | O mais moderno; topologicamente consistente; tende a **sub**segmentar a borda com a amígdala |
| [HSF](https://github.com/clementpoiret/HSF) | *Bagging* de 5 U-Nets residuais com atenção + 20 aumentações em tempo de teste + voto por pluralidade + mapa de incerteza | T1w ou T2w brutos | GD, CA1–CA3 (fusíveis), subículo | Rápido (ONNX); Dice mais variável em dados clínicos fora do domínio |
| [ASHS](https://github.com/pyushkevich/ashs) | Registro multi-atlas + *joint label fusion* + *corrective learning* (AdaBoost) | **T1w + T2w coronal fino** (~0,4×0,4×2 mm) | Subcampos + córtices do LTM (protocolo do atlas) | Padrão-ouro clássico; lento; exige protocolo de aquisição dedicado; ASHS-T1 (1 mm) entrega deliberadamente só anterior/posterior, **não** subcampos |
| FreeSurfer `segmentHA` | Inferência bayesiana com atlas probabilístico em malha tetraédrica (ex vivo 7T ~0,13 mm), verossimilhança gaussiana adaptativa ao contraste | T1 (± T2) após `recon-all` | 12+ subcampos, cabeça/corpo/cauda | Contraste-adaptativo, mas em T1 1 mm o *prior* domina (ver Wisse 2021) |

No estudo de Sghirripa (T1 1 mm, máscaras binarizadas): Dice contra manual variou de ~0,58 a 0,86 conforme ferramenta e dataset; quase todas **sobre**segmentam a fronteira anterior com a amígdala; para subcampos, FreeSurfer `segmentHA` e HippUnfold foram os mais confiáveis. Para quem precisa de subcampos de verdade, rode uma dessas ferramentas fora do navegador e importe o NIfTI resultante aqui para estatísticas e relatório.

O que o Morfo Studio implementa é o **esqueleto geométrico comum** a essas abordagens (ROI → máscara → sistema de coordenadas longitudinal → parcelamento → morfometria), com a honestidade de parar onde o contraste de T1 1 mm para.

## Modelo próprio

Selecione *Modelo próprio (tfjs, URL)* e informe `model.json` + `labels.json` hospedados com CORS (GitHub Pages serve). O modelo deve aceitar um tensor `[1, 256, 256, 256, 1]` uint8 conformado (convenção brainchop). Redes SynthSeg convertidas para tfjs se encaixam aqui.

## Estrutura

```
index.html  styles.css  manifest.json  sw.js
js/   app.js  quality.js  preprocess-worker.js  hippocampus.js  hippocampus-worker.js  stats.js  sav.js  pdf.js  report.js  zip.js  nifti-writer.js
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
