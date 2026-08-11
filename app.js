(() => {
  const video = document.getElementById('video');
  const canvas = document.getElementById('captureCanvas');
  const btnCapture = document.getElementById('btnCapture');
  const btnRetry = document.getElementById('btnRetry');
  const statusEl = document.getElementById('status');
  const resultOverlay = document.getElementById('result-overlay');
  const report = document.getElementById('report');
  const modeBadge = document.getElementById('modeBadge');

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

  let stream = null;

  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
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

  function resetToCamera() {
    canvas.style.display = 'none';
    video.style.display = 'block';
    resultOverlay.classList.remove('show');
    resultOverlay.innerHTML = '';
    report.classList.remove('show');
    report.innerHTML = '';
    btnRetry.style.display = 'none';
    btnCapture.style.display = 'inline-block';
    statusEl.style.display = 'block';
    statusEl.textContent = 'Aponte para a tela cheia com o padrão de foco e capture.';
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

    const MAX_W = 1280;
    const scale = Math.min(1, MAX_W / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);

    video.style.display = 'none';
    canvas.style.display = 'block';
    btnCapture.style.display = 'none';
    btnRetry.style.display = 'inline-block';
    statusEl.style.display = 'none';

    const imageData = ctx.getImageData(0, 0, w, h);
    const scores = analyzeFocus(imageData, w, h);
    renderResults(scores);
  }

  btnCapture.addEventListener('click', capture);
  btnRetry.addEventListener('click', resetToCamera);

  startCamera();
})();
