# Morfo Studio

Morfometria cerebral no navegador: **DICOM ou NIfTI → conformação 256³/1 mm → segmentação (aparc+aseg, cerebelo, tronco, corpo caloso) → estatísticas → CSV / JSON / SAV / PDF / NIfTI**. PWA instalável, 100 % local, funciona offline depois da primeira visita.

Arquitetura inspirada no [brain2print](https://github.com/niivue/brain2print) e no [brainchop](https://github.com/neuroneural/brainchop): mesmo visualizador (NiiVue), mesma conformação FreeSurfer-style, mesmos modelos MeshNet. O que foi acrescentado:

| Bloco | Implementação |
|---|---|
| DICOM → NIfTI | `dcm2niix` em WebAssembly (`@niivue/dcm2niix`), com seleção de série e leitura do sidecar JSON |
| Régua de qualidade | `js/quality.js` — classifica o exame em A–D (voxel, anisotropia, nº de cortes, FOV, contraste, campo) e escolhe o ramo do pipeline |
| Pré-processamento | `js/preprocess-worker.js` + `js/fsl-prep.js` + `js/n4.js` + `js/motion-worker.js` + `js/mask-worker.js` — reorientação RAS (≈ `fslreorient2std`), recorte de pescoço (≈ `robustfov`), viés **N4 (ANTs-like)** ou homomórfico, movimento entre volumes (≈ `antsMotionCorr`), extração cerebral com limiar f (≈ `BET`), normalização na máscara (≈ `FAST -B`), reamostragem cúbica; ver seções abaixo |
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

## Pré-processamento estilo FSL

As etapas estruturais clássicas do FSL têm equivalentes navegador na seção **Pré-processamento** do painel, encadeadas nesta ordem no pipeline (movimento → reorientação → recorte → viés → conformação → extração cerebral → normalização → segmentação):

| Etapa | Equivalente FSL | Implementação | Observações |
|---|---|---|---|
| Reorientação canônica | `fslreorient2std` | `js/fsl-prep.js reorientToRAS` — permutação/flip de eixos pela affine, **sem reamostrar**, no espaço nativo | A conformação do NiiVue já reorienta *implicitamente* ao reamostrar para 256³; esta etapa torna a orientação explícita e testável antes das demais (o N4 por eixo e o recorte dependem dela) |
| Recorte de pescoço | `robustfov` | `cropNeck` — perfil de área de primeiro plano (Otsu) no eixo inferior-superior detectado pela affine; mantém **170 mm** do topo da cabeça (o default do robustfov) | Heurística ≠ robustfov exato (que usa um modelo de FOV); no-op quando o FOV já é pequeno |
| Correção de viés | (FSL usa o FAST -B) | o **N4 já existente** (`js/n4.js`) roda **antes** da extração cerebral, e a imagem corrigida alimenta todas as etapas seguintes | ver seção ANTs abaixo |
| Extração cerebral | `BET` | modelo MeshNet "Máscara cerebral" com saída de **probabilidade** (softmax via `isScalar` do brainchop) + limiar **f configurável (0,1–0,9, default 0,5** — análogo ao `-f`; maior = máscara menor**)** + fechamento morfológico, maior componente 26-conexo e preenchimento de cavidades (`js/mask-worker.js`) | A máscara é sobreposta no NiiVue (slider de opacidade) para QC antes de confiar na segmentação; máscara e cérebro extraído exportáveis |
| Contraste SC/SB | efeito do `FAST -B` + segmentação | (a) normalização opcional `[p2,p98]→[0,255]` dentro da máscara (`normalizeWithinMask`); (b) segmentação SC/SB/líquor pelo modelo **tissue_3** existente (atlas "Tecidos"), com volumes no painel de estatísticas como sempre | Atenção: os modelos MeshNet foram treinados em **cabeça inteira** conformada — mascarar/normalizar antes muda o domínio de entrada; útil sobretudo para tecidos, use com inspeção |

Proveniência: o JSON exportado registra em `meta.preproc` quais etapas rodaram e com quais parâmetros (orientação original, cortes removidos, método de viés, f da máscara, volume da máscara, normalização). Os intermediários (pré-processado nativo, máscara, cérebro extraído) saem como `.nii.gz` nos botões de exportação e no pacote `.zip`.

### Por que não o niimath (WASM)?

Avaliamos integrar o [niimath](https://github.com/rordenlab/niimath) (clone do fslmaths em WASM, BSD-2, `@niivue/niimath`, ~723 KB somando wasm + JS): ele **tem** `-robustfov` exato e morfologia rica, mas **não tem** `fslreorient2std` sem reamostragem (só `-conform`, que reamostra) nem extração cerebral. Como a reorientação teria de ser JS puro de qualquer forma, a morfologia já existia no projeto (módulo hipocampal) e o único ganho seria o robustfov exato, optamos por ~150 linhas de JS puro testáveis em vez de +723 KB de assets e uma dependência nova no cache offline. Se o projeto vier a precisar de operações fslmaths genéricas, o niimath é a escolha natural (mesmos mantenedores do NiiVue).

## Pré-processamento inspirado no ANTs

Duas correções de artefato do [ANTs](https://github.com/ANTsX/ANTs) foram reimplementadas em JavaScript puro, a partir da leitura do código-fonte (`Examples/N4BiasFieldCorrection.cxx`, `Examples/antsMotionCorr.cxx` e os filtros ITK subjacentes):

### Campo de viés (inomogeneidade) — N4, `js/n4.js`

Reimplementação do algoritmo **N4ITK** (Tustison et al., IEEE TMI 2010; `itkN4BiasFieldCorrectionImageFilter`), o corretor de viés do ANTs:

1. log-intensidade nos voxels da máscara (Otsu), subamostragem por média de blocos;
2. a cada iteração, o histograma (200 bins, Parzen triangular) é **afiado por deconvolução de Wiener** com kernel gaussiano (FWHM 0,15, ruído 0,01 — os defaults do ANTs) e calcula-se o valor esperado E[u|v] da intensidade verdadeira;
3. o resíduo v − E[u|v] é ajustado por **B-splines cúbicas** (aproximação de dados dispersos de Lee, Wolberg & Shin 1997, a mesma do `itkBSplineScatteredDataPointSetToImageFilter`, com a fórmula exata φ = Σ w·B²·(B·z/ΣB²) / Σ w·B²), e o lattice incremental é somado ao acumulado — a marca registrada do N4 sobre o N3;
4. convergência pelo CV de exp(campo incremental); a grade de controle **dobra a cada nível** (refinamento multinível);
5. o campo suave é reconstruído na resolução original e a imagem é dividida por exp(campo).

Divergências deliberadas (validadas em fantomas sintéticos com campo conhecido — 97 % da variância de viés removida na cinzenta, correlação 0,90–0,99 com o campo verdadeiro):

* **shrink por eixo** mirando ~4 mm efetivos (o fator fixo 4 do ANTs presume 1 mm isotrópico e produziria blocos de 20 mm em exames clínicos de corte espesso);
* **filtros de pureza de bloco** (≥ 90 % acima do limiar de fundo; CV interno ≤ 12 %) — o volume parcial criado pela subamostragem contaminava o ajuste;
* **3 níveis** de ajuste em vez de 4 (grade final ~50 mm: acima da escala da anatomia, abaixo da do viés; o 4º nível ajustava estrutura de tecido como se fosse campo);
* convergência 0,001 (default do ITK; o CLI do ANTs roda todas as iterações com 0,0);
* deconvolução por FFT radix-2 própria; convolução do E[u|v] no domínio direto.

Disponível no modo robusto e, opcionalmente, no pipeline padrão ("Aplicar viés também no pipeline padrão"). O método homomórfico anterior permanece como alternativa rápida.

### Movimento — registro rígido entre volumes, `js/motion-worker.js`

No espírito do **`antsMotionCorr`**: quando a entrada é uma série 4D ou vários NIfTI do mesmo protocolo (aquisições repetidas), cada volume é registrado rigidamente (6 DOF) a uma referência e a **média dos volumes alinhados** segue para o pipeline. Fiel ao ANTs: winsorização [0,001–0,999]→[0,1] antes do registro (`PreprocessImage`), inicialização por centro de massa (`itkImageMomentsCalculator`), métrica **informação mútua de Mattes (32 bins)** em amostragem regular, escalas físicas de rotação pelo maior raio dos pontos (`RegistrationParameterScalesFromPhysicalShift`), duas passadas com referência média atualizada, reamostragem trilinear. Divergência deliberada: otimização por busca local coordenada multirresolução (shrink 4→2) em vez de gradiente conjugado com line search — dispensa o gradiente da MI e converge nos mesmos mínimos em volumes cerebrais (validado com transformações conhecidas: erro < 0,2 mm). Os parâmetros por volume (translações mm, rotações °, deslocamento resumido) vão para o JSON, a linha larga da coorte (`moco_*`) e o PDF.

**Limite honesto**: isto corrige movimento **entre** volumes. Artefato de movimento **dentro** de um único volume 3D (ghosting, anéis) não é corrigível retrospectivamente no espaço da imagem — nem pelo ANTs (`antsMotionCorr` exige série temporal; o dano intra-volume está no k-space). Para esses casos, o caminho é readquirir ou usar correção prospectiva/da própria bobina.

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
js/   app.js  quality.js  preprocess-worker.js  fsl-prep.js  mask-worker.js  n4.js  motion-worker.js  hippocampus.js  hippocampus-worker.js  stats.js  sav.js  pdf.js  report.js  zip.js  nifti-writer.js
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
