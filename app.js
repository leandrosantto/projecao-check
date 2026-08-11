(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const stage = $('stage'), video = $('video');
  const captureWrap = $('captureWrap'), canvas = $('captureCanvas');
  const btnCapture = $('btnCapture'), btnRetry = $('btnRetry'), btnMask = $('btnMask');
  const btnQuadToggle = $('btnQuadToggle'), btnSettings = $('btnSettings'), btnReport = $('btnReport');
  const modeChip = $('modeChip'), modeList = $('modeList');
  const statusEl = $('status'), zoomBadge = $('zoomBadge');
  const maskLayer = $('mask-layer'), overlaySvg = $('overlay-svg');
  const maskCutout = $('maskCutout'), imageQuadLine = $('imageQuadLine');
  const maskingQuadLine = $('maskingQuadLine'), zoneLines = $('zoneLines');
  const resultOverlay = $('result-overlay'), reportBody = $('reportBody');
  const handles = Array.from(document.querySelectorAll('.mask-handle'));

  const VB = 1000; // viewBox do SVG (coordenadas em milésimos do palco)

  /* ---------------- estado ---------------- */

  const MODES = {
    foco: {
      name: 'Foco & Scheimpflug',
      sub: 'Nitidez por região + indício de inclinação do plano focal',
      pattern: 'Exiba: padrão de foco / grade fina',
      captures: [{ id: 'main', instruction: 'Exiba o padrão de foco e capture.' }],
    },
    convergencia: {
      name: 'Convergência RGB',
      sub: 'Deslocamento sub-pixel entre os canais R, G e B',
      pattern: 'Exiba: grade branca (crosshatch)',
      captures: [{ id: 'main', instruction: 'Exiba a grade branca e capture.' }],
    },
    campoBranco: {
      name: 'Campo branco',
      sub: 'Uniformidade · Hotspot · Desvio de cor · Luminância (fL)',
      pattern: 'Exiba: branco 100%',
      captures: [{ id: 'white', instruction: 'Exiba BRANCO 100% e capture.' }],
    },
    contraste: {
      name: 'Contraste sequencial',
      sub: 'Relação branco/preto, incluindo luz ambiente da sala',
      pattern: 'Exiba: branco 100%, depois preto 0%',
      captures: [
        { id: 'white', instruction: 'Passo 1 de 2 — exiba BRANCO 100% e capture.' },
        { id: 'black', instruction: 'Passo 2 de 2 — exiba PRETO 0% e capture. Não mova o celular.' },
      ],
    },
    enquadramento: {
      name: 'Enquadramento & Geometria',
      sub: 'Quadro projetado × masking, keystone e rotação',
      pattern: 'Exiba: branco 100% ou padrão de enquadramento',
      captures: [{ id: 'main', instruction: 'Marque o QUADRO (verde) e o MASKING (amarelo), depois capture.' }],
      dualQuad: true,
    },
  };

  const DEFAULT_QUAD = () => ([
    { x: 0.10, y: 0.20 }, { x: 0.90, y: 0.20 },
    { x: 0.90, y: 0.80 }, { x: 0.10, y: 0.80 },
  ]);

  let stream = null, track = null;
  let zoomScale = 1, maskEnabled = true;
  let currentMode = 'foco';
  let captureStep = 0;
  let pendingCaptures = {};   // id -> { img, exposure }
  let quads = { image: DEFAULT_QUAD(), masking: [
    { x: 0.06, y: 0.16 }, { x: 0.94, y: 0.16 },
    { x: 0.94, y: 0.84 }, { x: 0.06, y: 0.84 },
  ] };
  let activeQuad = 'image';
  let session = {};           // modeId -> resultado renderizável
  let lastWhiteCapture = null;

  const settings = Object.assign(
    { aspect: 2.39, projRes: 2048, room: '' },
    JSON.parse(localStorage.getItem('pc.settings') || '{}')
  );
  let calib = JSON.parse(localStorage.getItem('pc.calib') || 'null');
  const saveSettings = () => localStorage.setItem('pc.settings', JSON.stringify(settings));

  /* ---------------- câmera ---------------- */

  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      video.srcObject = stream;
      track = stream.getVideoTracks()[0];
      refreshCameraStatus();
    } catch (err) {
      setStatus('Não foi possível acessar a câmera: ' + err.message);
    }
  }

  function trackSettings() {
    try { return (track && track.getSettings) ? track.getSettings() : {}; } catch (e) { return {}; }
  }

  function refreshCameraStatus() {
    const s = trackSettings();
    const caps = (track && track.getCapabilities) ? (track.getCapabilities() || {}) : {};
    const fmt = (mode, capList) => {
      if (mode === 'manual') return 'travada';
      if (!capList || !capList.includes('manual')) return 'não suportada';
      return 'automática';
    };
    $('expStatus').textContent = fmt(s.exposureMode, caps.exposureMode);
    $('expStatus').className = 'v ' + (s.exposureMode === 'manual' ? 'ok' : 'warn');
    $('wbStatus').textContent = fmt(s.whiteBalanceMode, caps.whiteBalanceMode);
    $('wbStatus').className = 'v ' + (s.whiteBalanceMode === 'manual' ? 'ok' : 'warn');
  }

  async function lockCamera() {
    if (!track) return;
    const caps = (track.getCapabilities && track.getCapabilities()) || {};
    const advanced = [];
    if (caps.exposureMode && caps.exposureMode.includes('manual')) advanced.push({ exposureMode: 'manual' });
    if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('manual')) advanced.push({ whiteBalanceMode: 'manual' });
    if (!advanced.length) {
      alert('Este aparelho/navegador não expõe controle manual de exposição pela web.\n\nFoco, convergência, uniformidade e cor relativa continuam válidos. Luminância em fL e contraste ficam como estimativa grosseira.');
      refreshCameraStatus();
      return;
    }
    try { await track.applyConstraints({ advanced }); } catch (e) { /* alguns aparelhos recusam */ }
    refreshCameraStatus();
  }

  /* ---------------- zoom por pinça ---------------- */

  function applyZoom() {
    video.style.transform = zoomScale > 1.001 ? `scale(${zoomScale})` : 'none';
    zoomBadge.textContent = zoomScale.toFixed(1) + 'x';
    zoomBadge.style.display = zoomScale > 1.02 ? 'block' : 'none';
  }

  let activeHandle = null, pinchStartDist = null, pinchStartZoom = 1;
  const touchDist = (a, b) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);

  stage.addEventListener('touchmove', (e) => {
    if (captureWrap.classList.contains('show')) return;
    if (activeHandle !== null && e.touches.length === 1) {
      e.preventDefault();
      moveHandle(activeHandle, e.touches[0]);
      return;
    }
    if (e.touches.length === 2) {
      e.preventDefault();
      const d = touchDist(e.touches[0], e.touches[1]);
      if (pinchStartDist == null) { pinchStartDist = d; pinchStartZoom = zoomScale; }
      else {
        zoomScale = Math.min(4, Math.max(1, pinchStartZoom * (d / pinchStartDist)));
        applyZoom();
      }
    }
  }, { passive: false });

  stage.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinchStartDist = null;
    if (e.touches.length === 0) activeHandle = null;
  }, { passive: true });

  /* ---------------- máscara de 4 cantos ---------------- */

  function activePts() { return quads[activeQuad]; }

  function renderMask() {
    if (!maskEnabled) { maskLayer.classList.remove('show'); return; }
    maskLayer.classList.add('show');

    const dual = !!MODES[currentMode].dualQuad;
    const toVB = p => `${p.x * VB},${p.y * VB}`;
    const img = quads.image, msk = quads.masking;

    imageQuadLine.setAttribute('points', img.map(toVB).join(' '));
    maskingQuadLine.style.display = dual ? '' : 'none';
    if (dual) maskingQuadLine.setAttribute('points', msk.map(toVB).join(' '));

    // escurece tudo fora do quadro analisado
    const d = `M0,0 H${VB} V${VB} H0 Z M` + img.map(p => `${p.x * VB},${p.y * VB}`).join(' L') + ' Z';
    maskCutout.setAttribute('d', d);

    // subdivisão 3x3 perspectiva-correta dentro do quadro
    const h = Analysis.homographyRectToQuad(1, 1, img);
    let lines = '';
    if (h) {
      for (let i = 1; i <= 2; i++) {
        const t = i / 3;
        const a = Analysis.mapPoint(h, t, 0), b = Analysis.mapPoint(h, t, 1);
        const c = Analysis.mapPoint(h, 0, t), e = Analysis.mapPoint(h, 1, t);
        lines += `<line x1="${a.x * VB}" y1="${a.y * VB}" x2="${b.x * VB}" y2="${b.y * VB}"/>`;
        lines += `<line x1="${c.x * VB}" y1="${c.y * VB}" x2="${e.x * VB}" y2="${e.y * VB}"/>`;
      }
    }
    zoneLines.innerHTML = lines;

    const pts = activePts();
    handles.forEach((el, i) => {
      el.style.left = pts[i].x * 100 + '%';
      el.style.top = pts[i].y * 100 + '%';
      el.classList.toggle('masking', dual && activeQuad === 'masking');
    });
  }

  function moveHandle(i, pt) {
    const box = stage.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (pt.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (pt.clientY - box.top) / box.height));
    activePts()[i] = { x, y };
    renderMask();
  }

  handles.forEach((el, i) => {
    el.addEventListener('touchstart', (e) => { e.stopPropagation(); activeHandle = i; }, { passive: true });
    el.addEventListener('mousedown', (e) => {
      e.stopPropagation(); e.preventDefault();
      const onMove = ev => moveHandle(i, { clientX: ev.clientX, clientY: ev.clientY });
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  });

  /* ---------------- captura + retificação ---------------- */

  // Região do frame nativo que está realmente visível no palco (crop do object-fit:cover + zoom).
  function effectiveSourceRect() {
    const box = stage.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    const coverScale = Math.max(box.width / vw, box.height / vh);
    const cw = box.width / coverScale, ch = box.height / coverScale;
    const cx = (vw - cw) / 2, cy = (vh - ch) / 2;
    const ew = cw / zoomScale, eh = ch / zoomScale;
    return { x: cx + (cw - ew) / 2, y: cy + (ch - eh) / 2, w: ew, h: eh };
  }

  const quadToSource = (pts, eff) =>
    pts.map(p => ({ x: eff.x + p.x * eff.w, y: eff.y + p.y * eff.h }));

  let workCanvas = null;
  function grabFrame() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return null;
    if (!workCanvas) workCanvas = document.createElement('canvas');
    workCanvas.width = vw; workCanvas.height = vh;
    const ctx = workCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, vw, vh);
    return ctx.getImageData(0, 0, vw, vh);
  }

  // Frame nativo -> imagem retificada da tela, no formato configurado.
  function rectifiedCapture() {
    const src = grabFrame();
    if (!src) return null;
    const eff = effectiveSourceRect();
    const quad = quadToSource(quads.image, eff);

    const avgW = (Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y) +
                  Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y)) / 2;
    const outW = Math.max(320, Math.min(1280, Math.round(avgW)));
    const outH = Math.max(180, Math.round(outW / settings.aspect));

    const img = maskEnabled ? Analysis.rectify(src, quad, outW, outH) : src;
    return { img, srcQuad: quad, eff };
  }

  function showCapture(img) {
    canvas.width = img.width; canvas.height = img.height;
    canvas.getContext('2d').putImageData(img, 0, 0);
    video.style.display = 'none';
    maskLayer.classList.remove('show');
    zoomBadge.style.display = 'none';
    captureWrap.classList.add('show');
    btnCapture.style.display = 'none';
    btnMask.style.display = 'none';
    btnQuadToggle.style.display = 'none';
    btnRetry.style.display = 'inline-block';
    statusEl.style.display = 'none';
  }

  function resetToCamera() {
    captureStep = 0; pendingCaptures = {};
    captureWrap.classList.remove('show');
    video.style.display = 'block';
    resultOverlay.classList.remove('show');
    resultOverlay.innerHTML = '';
    btnRetry.style.display = 'none';
    btnCapture.style.display = 'inline-block';
    btnMask.style.display = 'inline-block';
    btnQuadToggle.style.display = MODES[currentMode].dualQuad ? 'inline-block' : 'none';
    statusEl.style.display = 'block';
    applyModeUI();
    renderMask();
  }

  function setStatus(t) { statusEl.textContent = t; }

  /* ---------------- classificação ---------------- */

  const clsFocus = rel => rel >= 85 ? 'ok' : (rel >= 60 ? 'warn' : 'bad');
  const clsConv = px => px <= 0.5 ? 'ok' : (px <= 1.0 ? 'warn' : 'bad');
  const clsUnif = rel => rel >= 80 ? 'ok' : (rel >= 70 ? 'warn' : 'bad');

  /* ---------------- execução dos modos ---------------- */

  function capture() {
    const mode = MODES[currentMode];
    const cap = rectifiedCapture();
    if (!cap || !cap.img) { setStatus('Falha ao capturar — verifique a câmera e o quadro marcado.'); return; }

    const stepDef = mode.captures[captureStep];
    pendingCaptures[stepDef.id] = { img: cap.img, exposure: trackSettings(), srcQuad: cap.srcQuad, eff: cap.eff };
    if (stepDef.id === 'white') lastWhiteCapture = pendingCaptures[stepDef.id];

    if (captureStep < mode.captures.length - 1) {
      captureStep++;
      setStatus(mode.captures[captureStep].instruction);
      return; // mantém a câmera ativa para o próximo passo
    }

    showCapture(cap.img);
    setStatus('Analisando…');
    setTimeout(() => runAnalysis(cap), 30);
  }

  function runAnalysis(cap) {
    const img = pendingCaptures[MODES[currentMode].captures[0].id].img;
    let result;
    switch (currentMode) {
      case 'foco':          result = runFocus(img); break;
      case 'convergencia':  result = runConvergence(img); break;
      case 'campoBranco':   result = runWhiteField(img); break;
      case 'contraste':     result = runContrast(); break;
      case 'enquadramento': result = runFraming(cap); break;
    }
    session[currentMode] = result;
    renderOverlay(result);
    openSheet('sheetReport');
    renderReport();
  }

  function runFocus(img) {
    const f = Analysis.focus(img, 3);
    const s = Analysis.scheimpflug(f);
    const zones = f.zones.map(z => ({
      row: z.row, col: z.col, cls: clsFocus(z.rel),
      main: z.rel >= 85 ? 'OK' : (z.rel >= 60 ? 'Atenção' : 'Fora de foco'),
      sub: z.rel.toFixed(0) + '%',
    }));
    return {
      mode: 'foco', title: 'Foco & Scheimpflug', zones,
      rows: f.zones.map(z => ({
        k: zoneName(z.row, z.col, 3),
        v: z.rel.toFixed(0) + '% · ' + (z.rel >= 85 ? 'OK' : z.rel >= 60 ? 'Atenção' : 'Fora de foco'),
        cls: clsFocus(z.rel),
      })),
      extra: [{ title: 'Scheimpflug', rows: [{ k: 'Diagnóstico', v: s.verdict, cls: s.level, wide: true }] }],
      note: 'A nitidez é relativa: 100% é a região mais nítida desta captura. Serve para comparar regiões entre si, não para medir foco absoluto.',
    };
  }

  function runConvergence(img) {
    const c = Analysis.convergence(img, 3, 12);
    const pxToProj = settings.projRes / img.width;
    const zones = [], rows = [];
    let worst = 0, measured = 0;

    c.zones.forEach(z => {
      const name = zoneName(z.row, z.col, 3);
      if (z.weak) {
        zones.push({ row: z.row, col: z.col, cls: 'muted', main: 'sem padrão', sub: '' });
        rows.push({ k: name, v: 'sem linhas suficientes', cls: 'muted' });
        return;
      }
      measured++;
      const magR = z.magR * pxToProj, magB = z.magB * pxToProj;
      const w = Math.max(magR, magB);
      if (w > worst) worst = w;
      const cls = clsConv(w);
      zones.push({ row: z.row, col: z.col, cls, main: w.toFixed(2) + ' px', sub: 'R ' + magR.toFixed(2) + ' · B ' + magB.toFixed(2) });
      rows.push({
        k: name,
        v: `R ${fmtSigned(z.dxR, pxToProj)}/${fmtSigned(z.dyR, pxToProj)} · B ${fmtSigned(z.dxB, pxToProj)}/${fmtSigned(z.dyB, pxToProj)} px`,
        cls,
      });
    });

    const verdict = measured === 0
      ? { t: 'Nenhuma região tinha linhas suficientes — use uma grade/crosshatch.', c: 'muted' }
      : worst <= 0.5 ? { t: `Convergência dentro de meio pixel (pior caso ${worst.toFixed(2)} px). OK.`, c: 'ok' }
      : worst <= 1.0 ? { t: `Pior caso ${worst.toFixed(2)} px de projetor — aceitável, mas já visível em linhas finas.`, c: 'warn' }
      : { t: `Pior caso ${worst.toFixed(2)} px de projetor — necessário ajuste de convergência.`, c: 'bad' };

    return {
      mode: 'convergencia', title: 'Convergência RGB', zones,
      rows: [{ k: 'Veredito', v: verdict.t, cls: verdict.c, wide: true }].concat(rows),
      note: `Deslocamento horizontal/vertical de R e B em relação ao verde, convertido para pixels do projetor (${settings.projRes} px de largura). Referência usual: até 0,5 px OK, acima de 1 px exige ajuste. Atenção: a aberração cromática da lente do próprio celular cresce nas bordas do enquadramento e soma-se à medida — mantenha a tela centralizada e afastada das bordas da foto.`,
    };
  }

  function runWhiteField(img) {
    const w = Analysis.whiteField(img, 5);
    const zones = w.zones.map(z => ({
      row: z.row, col: z.col, cls: clsUnif(z.rel),
      main: z.rel.toFixed(0) + '%', sub: '',
    }));

    const rows = [
      { k: 'Uniformidade (mín/máx)', v: w.uniformityPct.toFixed(1) + '%', cls: clsUnif(w.uniformityPct) },
      { k: 'Hotspot', v: zoneName(w.hotspot.row, w.hotspot.col, w.n), cls: 'warn' },
      { k: 'Cantos vs centro', v: w.cornerVsCenter.map(v => v.toFixed(0) + '%').join(' · '),
        cls: clsUnif(Math.min.apply(null, w.cornerVsCenter)) },
      { k: 'Maior desvio de cor', v: `${zoneName(w.worstChroma.row, w.worstChroma.col, w.n)} — ${w.worstChroma.tint} (Δ ${w.worstChroma.dChroma.toFixed(1)})`,
        cls: w.worstChroma.dChroma > 12 ? 'bad' : w.worstChroma.dChroma > 6 ? 'warn' : 'ok' },
    ];

    // Luminância
    const lumaRel = w.meanLuma;
    if (calib && calib.luma > 0) {
      const est = calib.ref * (lumaRel / calib.luma);
      const band = 0.12; // ±12%: a incerteza honesta de uma câmera de celular calibrada por 1 ponto
      rows.push({
        k: 'Luminância estimada',
        v: `${(est * (1 - band)).toFixed(1)}–${(est * (1 + band)).toFixed(1)} fL (centro ~${est.toFixed(1)})`,
        cls: est >= 12 && est <= 17 ? 'ok' : 'warn',
      });
    } else {
      rows.push({ k: 'Luminância', v: lumaRel.toFixed(1) + '/255 (sem calibração)', cls: 'muted' });
    }

    const warns = [];
    if (w.clipPct > 1) warns.push(`${w.clipPct.toFixed(1)}% dos pixels estão estourados (saturados). A uniformidade e a luminância ficam inválidas — reduza a exposição ou afaste-se.`);
    if (trackSettings().exposureMode !== 'manual') warns.push('Exposição não travada: a uniformidade relativa continua válida (é uma única foto), mas a luminância em fL não é confiável.');

    return {
      mode: 'campoBranco', title: 'Campo branco', zones, rows, warns,
      note: 'Referência comum: cantos entre 70% e 80% do centro. A vinheta da própria lente do celular escurece as bordas da foto e pode se somar à queda medida — enquadre a tela centralizada, ocupando cerca de 2/3 do quadro.',
    };
  }

  function runContrast() {
    const white = pendingCaptures.white, black = pendingCaptures.black;
    if (!white || !black) return { mode: 'contraste', title: 'Contraste', rows: [{ k: 'Erro', v: 'faltou uma das capturas', cls: 'bad', wide: true }] };
    const lw = Analysis.meanLuma(white.img), lb = Analysis.meanLuma(black.img);
    const ratio = lb.luma > 0.5 ? lw.luma / lb.luma : null;

    const locked = white.exposure.exposureMode === 'manual' && black.exposure.exposureMode === 'manual';
    const warns = [];
    if (!locked) warns.push('Exposição não travada entre as duas capturas: o celular reajustou o brilho sozinho, então este número NÃO representa o contraste real. Trave a exposição em Ajustes e repita.');
    if (lw.clipPct > 1) warns.push(`Branco estourado em ${lw.clipPct.toFixed(1)}% dos pixels — o contraste real é maior que o medido.`);

    return {
      mode: 'contraste', title: 'Contraste sequencial', warns,
      rows: [
        { k: 'Branco (média)', v: lw.luma.toFixed(1) + '/255' },
        { k: 'Preto (média)', v: lb.luma.toFixed(1) + '/255' },
        { k: 'Relação medida', v: ratio ? `${ratio.toFixed(0)}:1` : 'preto abaixo do ruído da câmera', cls: locked ? (ratio && ratio > 1500 ? 'ok' : 'warn') : 'muted' },
      ],
      note: 'Contraste sequencial (on/off) medido na tela, incluindo luz ambiente e reflexão da sala — por isso costuma ficar bem abaixo do contraste de catálogo do projetor. Útil para comparar a mesma sala ao longo do tempo, não para conferir a especificação do fabricante.',
    };
  }

  function runFraming(cap) {
    const eff = cap.eff;
    const imgQ = quadToSource(quads.image, eff);
    const mskQ = quadToSource(quads.masking, eff);
    const g = Analysis.geometry(imgQ);
    const f = Analysis.framing(imgQ, mskQ);

    const rows = f.corners.map(c => ({
      k: c.name,
      v: `${c.dxPct >= 0 ? '+' : ''}${c.dxPct.toFixed(2)}% h · ${c.dyPct >= 0 ? '+' : ''}${c.dyPct.toFixed(2)}% v`,
      cls: c.magPct <= 0.5 ? 'ok' : c.magPct <= 1.5 ? 'warn' : 'bad',
    }));

    return {
      mode: 'enquadramento', title: 'Enquadramento & Geometria',
      rows: [
        { k: 'Pior canto', v: `${f.worst.name} — ${f.worst.magPct.toFixed(2)}% da largura`,
          cls: f.worst.magPct <= 0.5 ? 'ok' : f.worst.magPct <= 1.5 ? 'warn' : 'bad', wide: true },
      ].concat(rows),
      extra: [{
        title: 'Geometria do quadro projetado',
        rows: [
          { k: 'Keystone horizontal', v: g.keystoneH.toFixed(2) + '%', cls: g.keystoneH <= 0.5 ? 'ok' : g.keystoneH <= 1.5 ? 'warn' : 'bad' },
          { k: 'Keystone vertical', v: g.keystoneV.toFixed(2) + '%', cls: g.keystoneV <= 0.5 ? 'ok' : g.keystoneV <= 1.5 ? 'warn' : 'bad' },
          { k: 'Proporção medida', v: g.aspect.toFixed(2) + ':1' },
        ],
      }],
      note: 'A comparação quadro × masking é independente do ângulo da câmera — as duas marcações vêm da mesma foto. Já o keystone e a proporção absolutos só são válidos com o celular perpendicular ao centro da tela; fora do eixo, a própria perspectiva da foto vira trapézio.',
    };
  }

  const fmtSigned = (v, k) => v === null || v === undefined ? '—' : ((v * k >= 0 ? '+' : '') + (v * k).toFixed(2));

  function zoneName(r, c, n) {
    if (n !== 3) return `L${r + 1}·C${c + 1}`;
    if (r === 1 && c === 1) return 'Centro';
    return `${['Superior', 'Meio', 'Inferior'][r]} ${['Esquerda', 'Centro', 'Direita'][c]}`;
  }

  /* ---------------- overlay sobre a foto ---------------- */

  function renderOverlay(result) {
    resultOverlay.innerHTML = '';
    if (!result || !result.zones) return;
    const n = Math.sqrt(result.zones.length) | 0;
    result.zones.forEach(z => {
      const el = document.createElement('div');
      el.className = 'zone-label ' + z.cls;
      el.style.left = ((z.col + 0.5) * (100 / n)) + '%';
      el.style.top = ((z.row + 0.5) * (100 / n)) + '%';
      el.innerHTML = z.main + (z.sub ? `<small>${z.sub}</small>` : '');
      resultOverlay.appendChild(el);
    });
    resultOverlay.classList.add('show');
  }

  /* ---------------- relatório ---------------- */

  function renderReport() {
    const order = ['foco', 'convergencia', 'campoBranco', 'contraste', 'enquadramento'];
    const done = order.filter(k => session[k]);
    if (!done.length) {
      reportBody.innerHTML = '<p class="note">Nenhuma medição ainda. Escolha um modo, marque os cantos da tela e capture.</p>';
      return;
    }

    let html = '';
    if (settings.room) html += `<div class="card"><h3>Sala</h3><div class="row"><span class="k">Identificação</span><span class="v">${esc(settings.room)}</span></div></div>`;

    done.forEach(k => {
      const r = session[k];
      html += `<div class="card"><h3>${esc(r.title)}</h3>`;
      (r.warns || []).forEach(w => { html += `<div class="warnbox">${esc(w)}</div>`; });

      if (r.zones) {
        const n = Math.sqrt(r.zones.length) | 0;
        html += `<div class="grid-map" style="grid-template-columns:repeat(${n},1fr)">`;
        r.zones.forEach(z => {
          html += `<div class="grid-cell bg-${z.cls} ${z.cls}">${esc(z.main)}${z.sub ? `<br><span style="font-size:9px;opacity:.8">${esc(z.sub)}</span>` : ''}</div>`;
        });
        html += `</div>`;
      }

      (r.rows || []).forEach(row => {
        html += row.wide
          ? `<div class="row" style="display:block"><div class="k" style="margin-bottom:3px">${esc(row.k)}</div><div class="v ${row.cls || ''}" style="text-align:left">${esc(row.v)}</div></div>`
          : `<div class="row"><span class="k">${esc(row.k)}</span><span class="v ${row.cls || ''}">${esc(row.v)}</span></div>`;
      });

      (r.extra || []).forEach(ex => {
        html += `<h3 style="margin-top:12px">${esc(ex.title)}</h3>`;
        ex.rows.forEach(row => {
          html += row.wide
            ? `<div class="row" style="display:block"><div class="k" style="margin-bottom:3px">${esc(row.k)}</div><div class="v ${row.cls || ''}" style="text-align:left">${esc(row.v)}</div></div>`
            : `<div class="row"><span class="k">${esc(row.k)}</span><span class="v ${row.cls || ''}">${esc(row.v)}</span></div>`;
        });
      });

      if (r.note) html += `<div class="note">${esc(r.note)}</div>`;
      html += `</div>`;
    });

    reportBody.innerHTML = html;
  }

  function reportAsText() {
    const order = ['foco', 'convergencia', 'campoBranco', 'contraste', 'enquadramento'];
    let out = `RELATÓRIO — ${settings.room || 'sala não identificada'}\n${new Date().toLocaleString('pt-BR')}\n`;
    order.filter(k => session[k]).forEach(k => {
      const r = session[k];
      out += `\n## ${r.title}\n`;
      (r.warns || []).forEach(w => { out += `! ${w}\n`; });
      (r.rows || []).forEach(row => { out += `- ${row.k}: ${row.v}\n`; });
      (r.extra || []).forEach(ex => {
        out += `  ${ex.title}\n`;
        ex.rows.forEach(row => { out += `  - ${row.k}: ${row.v}\n`; });
      });
    });
    return out;
  }

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------------- folhas / UI ---------------- */

  const openSheet = id => $(id).classList.add('show');
  const closeSheet = id => $(id).classList.remove('show');
  document.querySelectorAll('[data-close]').forEach(b =>
    b.addEventListener('click', () => closeSheet(b.dataset.close)));

  function buildModeList() {
    modeList.innerHTML = '';
    Object.keys(MODES).forEach(k => {
      const m = MODES[k];
      const btn = document.createElement('button');
      btn.className = 'mode-item' + (k === currentMode ? ' active' : '');
      btn.innerHTML = `${esc(m.name)}<span class="sub">${esc(m.sub)}</span><span class="pat">${esc(m.pattern)}</span>`;
      btn.addEventListener('click', () => {
        currentMode = k;
        closeSheet('sheetModes');
        resetToCamera();
        buildModeList();
      });
      modeList.appendChild(btn);
    });
  }

  function applyModeUI() {
    const m = MODES[currentMode];
    modeChip.querySelector('.name').textContent = m.name;
    setStatus(m.captures[0].instruction);
    btnQuadToggle.style.display = m.dualQuad ? 'inline-block' : 'none';
    if (!m.dualQuad) activeQuad = 'image';
    updateQuadToggle();
  }

  function updateQuadToggle() {
    const editingImage = activeQuad === 'image';
    btnQuadToggle.textContent = 'Editando: ' + (editingImage ? 'quadro' : 'masking');
    btnQuadToggle.classList.toggle('masking-on', !editingImage);
  }

  /* ---------------- ligações ---------------- */

  modeChip.addEventListener('click', () => { buildModeList(); openSheet('sheetModes'); });
  btnSettings.addEventListener('click', () => { refreshCameraStatus(); openSheet('sheetSettings'); });
  btnReport.addEventListener('click', () => { renderReport(); openSheet('sheetReport'); });
  btnCapture.addEventListener('click', capture);
  btnRetry.addEventListener('click', resetToCamera);

  btnMask.addEventListener('click', () => {
    maskEnabled = !maskEnabled;
    btnMask.textContent = 'Máscara: ' + (maskEnabled ? 'ON' : 'OFF');
    btnMask.classList.toggle('toggle-on', maskEnabled);
    renderMask();
  });

  btnQuadToggle.addEventListener('click', () => {
    activeQuad = activeQuad === 'image' ? 'masking' : 'image';
    updateQuadToggle();
    renderMask();
  });

  $('btnLock').addEventListener('click', lockCamera);

  $('btnCopyReport').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(reportAsText()); $('btnCopyReport').textContent = '✓'; }
    catch (e) { alert(reportAsText()); }
    setTimeout(() => { $('btnCopyReport').textContent = '⎘'; }, 1200);
  });

  $('setAspect').addEventListener('change', e => { settings.aspect = parseFloat(e.target.value); saveSettings(); });
  $('setProjRes').addEventListener('change', e => { settings.projRes = parseInt(e.target.value, 10); saveSettings(); });
  $('setRoom').addEventListener('input', e => { settings.room = e.target.value; saveSettings(); });

  $('btnCalibrate').addEventListener('click', () => {
    const ref = parseFloat($('setCalibRef').value);
    if (!(ref > 0)) { alert('Informe a leitura do fotômetro em fL.'); return; }
    if (!lastWhiteCapture) { alert('Faça primeiro uma captura no modo "Campo branco".'); return; }
    const l = Analysis.meanLuma(lastWhiteCapture.img);
    if (l.clipPct > 1) { alert('A captura de branco está estourada — não serve para calibrar. Reduza a exposição e capture de novo.'); return; }
    calib = { ref, luma: l.luma, at: new Date().toISOString(), exposure: lastWhiteCapture.exposure };
    localStorage.setItem('pc.calib', JSON.stringify(calib));
    updateCalibStatus();
  });

  function updateCalibStatus() {
    const el = $('calibStatus');
    if (!calib) { el.textContent = 'Sem calibração. A luminância será exibida apenas como valor relativo.'; return; }
    el.textContent = `Calibrado em ${new Date(calib.at).toLocaleString('pt-BR')} com ${calib.ref} fL. Válido enquanto a exposição, a distância e o aparelho forem os mesmos.`;
  }

  /* ---------------- init ---------------- */

  $('setAspect').value = String(settings.aspect);
  $('setProjRes').value = String(settings.projRes);
  $('setRoom').value = settings.room;
  updateCalibStatus();
  buildModeList();
  applyModeUI();
  renderMask();
  window.addEventListener('resize', renderMask);
  startCamera();

  // exposto para verificação automatizada
  window.__pc = {
    get quads() { return quads; },
    setQuad(name, pts) { quads[name] = pts; renderMask(); },
    setMode(m) { currentMode = m; resetToCamera(); },
    runFocus, runConvergence, runWhiteField, runFraming,
    get session() { return session; },
    reportAsText, renderReport,
  };
})();
