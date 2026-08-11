(() => {
  const stage = document.getElementById('stage');
  const video = document.getElementById('video');
  const captureWrap = document.getElementById('captureWrap');
  const canvas = document.getElementById('captureCanvas');
  const btnCapture = document.getElementById('btnCapture');
  const btnRetry = document.getElementById('btnRetry');
  const btnMask = document.getElementById('btnMask');
  const statusEl = document.getElementById('status');
  const resultOverlay = document.getElementById('result-overlay');
  const report = document.getElementById('report');
  const modeBadge = document.getElementById('modeBadge');
  const zoomBadge = document.getElementById('zoomBadge');
  const maskLayer = document.getElementById('mask-layer');
  const maskCutout = document.getElementById('maskCutout');
  const maskRectOutline = document.getElementById('maskRectOutline');
  const handleTL = document.getElementById('handleTL');
  const handleBR = document.getElementById('handleBR');

  const ZONES = [
    { key: 'tl', name: 'Superior Esquerda', col: 0, row: 0 },
    { key: 'tc', name: 'Superior Centro',   col: 1, row: 0 },
    { key: 'tr', name: 'Superior Direita',  col: 2, row: 0 },
    { key: 'ml', name: 'Meio Esquerda',     col: 0, row: 1 },
    { key: 'mc', name: 'Centro',            col: 1, row: 1 },
    { key: 'mr', name: 'Meio Direita',      col: 2, row: 1 },
    { key: 'bl', name: 'Inferior Esquerda', col: 0, row: 2 },
    { key: 'bc', name: 'Inferior Centro',   col: 1, row: 2 },
    { key: 'br', name: 'Inferior Direita',  col: 2, row: 2 },
  ];

  const ZOOM_MIN = 1, ZOOM_MAX = 4;
  const MASK_MIN_SIZE = 0.15;

  let stream = null;
  let zoomScale = 1;
  let maskEnabled = true;
  let maskRect = { left: 0.10, top: 0.15, right: 0.90, bottom: 0.85 };

  let activeHandle = null; // 'tl' | 'br' | null
  let pinchStartDist = null;
  let pinchStartZoom = 1;

  // ---------- camera ----------

  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      video.srcObject = stream;
      modeBadge.textContent = 'câmera pronta';
    } catch (err) {
      statusEl.textContent = 'Não foi possível acessar a câmera: ' + err.message;
      modeBadge.textContent = 'erro';
    }
  }

  // ---------- zoom (pinch) ----------

  function applyZoom() {
    video.style.transform = zoomScale > 1.001 ? `scale(${zoomScale})` : 'none';
    zoomBadge.textContent = zoomScale.toFixed(1) + 'x';
    zoomBadge.style.display = zoomScale > 1.02 ? 'block' : 'none';
  }

  function touchDist(t1, t2) {
    return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
  }

  stage.addEventListener('touchmove', (e) => {
    if (captureWrap.classList.contains('show')) return; // reviewing a photo, no gestures

    if (activeHandle && e.touches.length === 1) {
      e.preventDefault();
      moveHandle(activeHandle, e.touches[0]);
      return;
    }

    if (e.touches.length === 2) {
      e.preventDefault();
      const dist = touchDist(e.touches[0], e.touches[1]);
      if (pinchStartDist == null) {
        pinchStartDist = dist;
        pinchStartZoom = zoomScale;
      } else {
        const ratio = dist / pinchStartDist;
        zoomScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pinchStartZoom * ratio));
        applyZoom();
      }
    }
  }, { passive: false });

  stage.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinchStartDist = null;
    if (e.touches.length === 0) activeHandle = null;
  }, { passive: true });

  // ---------- manual mask (rectangle, 2 draggable corners) ----------

  function renderMask() {
    if (!maskEnabled) {
      maskLayer.classList.remove('show');
      return;
    }
    maskLayer.classList.add('show');

    const l = maskRect.left * 100, t = maskRect.top * 100;
    const r = maskRect.right * 100, b = maskRect.bottom * 100;

    maskCutout.setAttribute('d', `M0,0 H100 V100 H0 Z M${l},${t} H${r} V${b} H${l} Z`);
    maskRectOutline.setAttribute('x', l);
    maskRectOutline.setAttribute('y', t);
    maskRectOutline.setAttribute('width', r - l);
    maskRectOutline.setAttribute('height', b - t);

    handleTL.style.left = l + '%';
    handleTL.style.top = t + '%';
    handleBR.style.left = r + '%';
    handleBR.style.top = b + '%';
  }

  function moveHandle(which, touch) {
    const rect = stage.getBoundingClientRect();
    let x = (touch.clientX - rect.left) / rect.width;
    let y = (touch.clientY - rect.top) / rect.height;
    x = Math.min(1, Math.max(0, x));
    y = Math.min(1, Math.max(0, y));

    if (which === 'tl') {
      maskRect.left = Math.min(x, maskRect.right - MASK_MIN_SIZE);
      maskRect.top = Math.min(y, maskRect.bottom - MASK_MIN_SIZE);
    } else {
      maskRect.right = Math.max(x, maskRect.left + MASK_MIN_SIZE);
      maskRect.bottom = Math.max(y, maskRect.top + MASK_MIN_SIZE);
    }
    renderMask();
  }

  function bindHandle(el, which) {
    el.addEventListener('touchstart', (e) => {
      e.stopPropagation();
      activeHandle = which;
    }, { passive: true });
    // mouse support for desktop testing
    el.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      activeHandle = which;
      const onMove = (ev) => moveHandle(which, { clientX: ev.clientX, clientY: ev.clientY });
      const onUp = () => {
        activeHandle = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }
  bindHandle(handleTL, 'tl');
  bindHandle(handleBR, 'br');

  btnMask.addEventListener('click', () => {
    maskEnabled = !maskEnabled;
    btnMask.textContent = 'Máscara: ' + (maskEnabled ? 'ON' : 'OFF');
    btnMask.classList.toggle('toggle-on', maskEnabled);
    renderMask();
  });

  // ---------- capture geometry ----------

  // Maps the current pinch-zoom to the region of the intrinsic video frame actually visible
  // on screen right now (object-fit:cover base crop, further narrowed by the CSS zoom transform).
  function getEffectiveSourceRect() {
    const box = stage.getBoundingClientRect();
    const videoW = video.videoWidth, videoH = video.videoHeight;
    const coverScale = Math.max(box.width / videoW, box.height / videoH);
    const coverW = box.width / coverScale, coverH = box.height / coverScale;
    const coverX = (videoW - coverW) / 2, coverY = (videoH - coverH) / 2;
    const effW = coverW / zoomScale, effH = coverH / zoomScale;
    const effX = coverX + (coverW - effW) / 2, effY = coverY + (coverH - effH) / 2;
    return { x: effX, y: effY, w: effW, h: effH };
  }

  function resetToCamera() {
    captureWrap.classList.remove('show');
    video.style.display = 'block';
    resultOverlay.classList.remove('show');
    resultOverlay.innerHTML = '';
    report.classList.remove('show');
    report.innerHTML = '';
    btnRetry.style.display = 'none';
    btnCapture.style.display = 'inline-block';
    btnMask.style.display = 'inline-block';
    statusEl.style.display = 'block';
    statusEl.textContent = 'Aponte para a tela e ajuste a máscara verde nas bordas da projeção.';
    renderMask();
  }

  function classify(relPct) {
    if (relPct >= 85) return { label: 'OK', cls: 'ok' };
    if (relPct >= 60) return { label: 'Atenção', cls: 'warn' };
    return { label: 'Fora de foco', cls: 'bad' };
  }

  function analyzeFocus(imageData, width, height) {
    const gray = new Float32Array(width * height);
    const data = imageData.data;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }

    const zoneStats = {};
    for (const z of ZONES) zoneStats[z.key] = { sum: 0, sumSq: 0, count: 0 };

    const colBound1 = Math.floor(width / 3);
    const colBound2 = Math.floor((width * 2) / 3);
    const rowBound1 = Math.floor(height / 3);
    const rowBound2 = Math.floor((height * 2) / 3);

    const zoneGrid = [[], [], []];
    for (const z of ZONES) zoneGrid[z.row][z.col] = z.key;

    for (let y = 1; y < height - 1; y++) {
      const row = y < rowBound1 ? 0 : (y < rowBound2 ? 1 : 2);
      const zoneRow = zoneGrid[row];
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        const lap =
          -4 * gray[idx] +
          gray[idx - 1] + gray[idx + 1] +
          gray[idx - width] + gray[idx + width];
        const col = x < colBound1 ? 0 : (x < colBound2 ? 1 : 2);
        const s = zoneStats[zoneRow[col]];
        s.sum += lap;
        s.sumSq += lap * lap;
        s.count++;
      }
    }

    const scores = {};
    for (const z of ZONES) {
      const s = zoneStats[z.key];
      const mean = s.sum / s.count;
      const variance = s.sumSq / s.count - mean * mean;
      scores[z.key] = Math.max(variance, 0);
    }
    return scores;
  }

  function renderResults(scores) {
    const maxScore = Math.max(...Object.values(scores)) || 1;

    resultOverlay.innerHTML = '';
    report.innerHTML = '<h2>Relatório de foco</h2>';

    for (const z of ZONES) {
      const raw = scores[z.key];
      const relPct = (raw / maxScore) * 100;
      const { label, cls } = classify(relPct);

      const cx = (z.col + 0.5) * (100 / 3);
      const cy = (z.row + 0.5) * (100 / 3);
      const labelEl = document.createElement('div');
      labelEl.className = 'zone-label ' + cls;
      labelEl.style.left = cx + '%';
      labelEl.style.top = cy + '%';
      labelEl.textContent = label;
      resultOverlay.appendChild(labelEl);

      const row = document.createElement('div');
      row.className = 'zone-row';
      row.innerHTML = `
        <span class="zone-name">${z.name}</span>
        <span class="zone-score ${cls}">${relPct.toFixed(0)}% · ${label}</span>
      `;
      report.appendChild(row);
    }

    resultOverlay.classList.add('show');
    report.classList.add('show');
  }

  function capture() {
    if (!video.videoWidth) return;

    const eff = getEffectiveSourceRect();

    // Compose the pinch-zoom crop with the manual mask rectangle (both are fractions of
    // the same on-screen box), giving the final region of the source frame to analyze.
    let srcX, srcY, srcW, srcH;
    if (maskEnabled) {
      srcX = eff.x + maskRect.left * eff.w;
      srcY = eff.y + maskRect.top * eff.h;
      srcW = (maskRect.right - maskRect.left) * eff.w;
      srcH = (maskRect.bottom - maskRect.top) * eff.h;
    } else {
      srcX = eff.x; srcY = eff.y; srcW = eff.w; srcH = eff.h;
    }

    const MAX_W = 1280;
    const scale = Math.min(1, MAX_W / srcW);
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, w, h);

    video.style.display = 'none';
    maskLayer.classList.remove('show');
    zoomBadge.style.display = 'none';
    captureWrap.classList.add('show');
    btnCapture.style.display = 'none';
    btnMask.style.display = 'none';
    btnRetry.style.display = 'inline-block';
    statusEl.style.display = 'none';

    const imageData = ctx.getImageData(0, 0, w, h);
    const scores = analyzeFocus(imageData, w, h);
    renderResults(scores);
  }

  btnCapture.addEventListener('click', capture);
  btnRetry.addEventListener('click', resetToCamera);

  renderMask();
  startCamera();
})();
