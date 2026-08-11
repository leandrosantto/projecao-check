/* analysis.js — rotinas puras de análise de imagem (sem DOM, sem estado).
   Entrada/saída em tipos simples para permitir teste sintético. */
window.Analysis = (function () {
  'use strict';

  /* ---------------- álgebra / geometria ---------------- */

  function solveLinear(A, b, n) {
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      }
      if (Math.abs(A[piv][col]) < 1e-12) return null;
      if (piv !== col) {
        const tA = A[piv]; A[piv] = A[col]; A[col] = tA;
        const tb = b[piv]; b[piv] = b[col]; b[col] = tb;
      }
      for (let r = col + 1; r < n; r++) {
        const f = A[r][col] / A[col][col];
        if (!f) continue;
        for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
        b[r] -= f * b[col];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
      x[r] = s / A[r][r];
    }
    return x;
  }

  // Homografia que leva (u,v) do retângulo WxH para (x,y) do quadrilátero [tl,tr,br,bl].
  function homographyRectToQuad(W, H, quad) {
    const dst = [[0, 0], [W, 0], [W, H], [0, H]];
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const u = dst[i][0], v = dst[i][1];
      const x = quad[i].x, y = quad[i].y;
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    return solveLinear(A, b, 8);
  }

  function mapPoint(h, u, v) {
    const w = h[6] * u + h[7] * v + 1;
    return { x: (h[0] * u + h[1] * v + h[2]) / w, y: (h[3] * u + h[4] * v + h[5]) / w };
  }

  // Reamostra o quadrilátero do frame de origem para um retângulo outW x outH.
  function rectify(src, quad, outW, outH) {
    const h = homographyRectToQuad(outW, outH, quad);
    if (!h) return null;
    const sw = src.width, sh = src.height, sd = src.data;
    const out = new Uint8ClampedArray(outW * outH * 4);
    const h0 = h[0], h1 = h[1], h2 = h[2], h3 = h[3], h4 = h[4], h5 = h[5], h6 = h[6], h7 = h[7];
    let o = 0;
    for (let v = 0; v < outH; v++) {
      const bx = h1 * v + h2, by = h4 * v + h5, bw = h7 * v + 1;
      for (let u = 0; u < outW; u++, o += 4) {
        const w = h6 * u + bw;
        const x = (h0 * u + bx) / w;
        const y = (h3 * u + by) / w;
        if (!(x >= 0 && y >= 0 && x <= sw - 1 && y <= sh - 1)) { out[o + 3] = 255; continue; }
        const x0 = x | 0, y0 = y | 0;
        const x1 = x0 + 1 < sw ? x0 + 1 : x0;
        const y1 = y0 + 1 < sh ? y0 + 1 : y0;
        const fx = x - x0, fy = y - y0;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        const i00 = (y0 * sw + x0) << 2, i10 = (y0 * sw + x1) << 2;
        const i01 = (y1 * sw + x0) << 2, i11 = (y1 * sw + x1) << 2;
        out[o]     = sd[i00]     * w00 + sd[i10]     * w10 + sd[i01]     * w01 + sd[i11]     * w11;
        out[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
        out[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
        out[o + 3] = 255;
      }
    }
    return new ImageData(out, outW, outH);
  }

  /* ---------------- utilidades ---------------- */

  const zi = (v, size, n) => {
    const i = (v * n / size) | 0;
    return i < 0 ? 0 : (i >= n ? n - 1 : i);
  };

  function grayOf(img) {
    const d = img.data, len = img.width * img.height;
    const g = new Float32Array(len);
    for (let i = 0, p = 0; p < len; i += 4, p++) {
      g[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    return g;
  }

  /* ---------------- foco ---------------- */

  // Variância do Laplaciano por zona: proxy clássico de nitidez.
  function focus(img, n) {
    n = n || 3;
    const w = img.width, h = img.height;
    const gray = grayOf(img);
    const stats = [];
    for (let i = 0; i < n * n; i++) stats.push({ sum: 0, sumSq: 0, count: 0 });

    for (let y = 1; y < h - 1; y++) {
      const row = zi(y, h, n) * n;
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        const lap = -4 * gray[idx] + gray[idx - 1] + gray[idx + 1] + gray[idx - w] + gray[idx + w];
        const s = stats[row + zi(x, w, n)];
        s.sum += lap; s.sumSq += lap * lap; s.count++;
      }
    }

    const zones = stats.map((s, i) => {
      const mean = s.sum / s.count;
      return {
        row: (i / n) | 0, col: i % n,
        score: Math.max(s.sumSq / s.count - mean * mean, 0),
      };
    });
    const max = Math.max.apply(null, zones.map(z => z.score)) || 1;
    zones.forEach(z => { z.rel = (z.score / max) * 100; });
    return { n, zones, max };
  }

  // Inclinação do plano focal (indício de Scheimpflug) a partir do gradiente de nitidez.
  function scheimpflug(focusRes) {
    const { n, zones } = focusRes;
    const at = (r, c) => zones[r * n + c].rel;
    const colMean = c => { let s = 0; for (let r = 0; r < n; r++) s += at(r, c); return s / n; };
    const rowMean = r => { let s = 0; for (let c = 0; c < n; c++) s += at(r, c); return s / n; };

    const left = colMean(0), right = colMean(n - 1);
    const top = rowMean(0), bottom = rowMean(n - 1);
    const hTilt = left - right;   // >0: lado esquerdo mais nítido
    const vTilt = top - bottom;   // >0: topo mais nítido

    // Centro muito melhor que as bordas de forma simétrica = foco geral, não inclinação.
    const center = at((n / 2) | 0, (n / 2) | 0);
    const edges = (left + right + top + bottom) / 4;
    const symmetricFalloff = center - edges;

    const TILT = 12; // pontos percentuais
    const parts = [];
    if (Math.abs(hTilt) > TILT) {
      parts.push(`plano horizontal inclinado (${hTilt > 0 ? 'direita' : 'esquerda'} mais suave, Δ ${Math.abs(hTilt).toFixed(0)} pts)`);
    }
    if (Math.abs(vTilt) > TILT) {
      parts.push(`plano vertical inclinado (${vTilt > 0 ? 'base' : 'topo'} mais suave, Δ ${Math.abs(vTilt).toFixed(0)} pts)`);
    }

    let verdict, level;
    if (parts.length) {
      verdict = 'Indício de desalinhamento do plano focal — ' + parts.join(' e ') + '. Avaliar Scheimpflug.';
      level = Math.max(Math.abs(hTilt), Math.abs(vTilt)) > TILT * 2 ? 'bad' : 'warn';
    } else if (symmetricFalloff > 25) {
      verdict = 'Queda simétrica do centro para as bordas: sugere foco geral / curvatura de campo, não inclinação.';
      level = 'warn';
    } else {
      verdict = 'Nitidez distribuída de forma uniforme — sem indício de Scheimpflug.';
      level = 'ok';
    }
    return { hTilt, vTilt, symmetricFalloff, verdict, level };
  }

  /* ---------------- convergência RGB ---------------- */

  // Perfil de energia de borda vertical (picos nas linhas verticais), normalizado por linha.
  function profileX(ch, w, x0, y0, x1, y1) {
    const len = x1 - x0, rows = y1 - y0;
    const p = new Float32Array(len);
    for (let y = y0; y < y1; y++) {
      const row = y * w;
      for (let x = x0; x < x1; x++) {
        const xm = x > x0 ? x - 1 : x0;
        const xp = x + 1 < x1 ? x + 1 : x1 - 1;
        p[x - x0] += Math.abs(ch[row + xp] - ch[row + xm]);
      }
    }
    let mean = 0;
    for (let i = 0; i < len; i++) { p[i] /= rows; mean += p[i]; }
    mean /= len;
    for (let i = 0; i < len; i++) p[i] -= mean;
    return p;
  }

  function profileY(ch, w, x0, y0, x1, y1) {
    const len = y1 - y0, cols = x1 - x0;
    const p = new Float32Array(len);
    for (let y = y0; y < y1; y++) {
      const ym = y > y0 ? y - 1 : y0;
      const yp = y + 1 < y1 ? y + 1 : y1 - 1;
      let acc = 0;
      for (let x = x0; x < x1; x++) acc += Math.abs(ch[yp * w + x] - ch[ym * w + x]);
      p[y - y0] = acc / cols;
    }
    let mean = 0;
    for (let i = 0; i < len; i++) mean += p[i];
    mean /= len;
    for (let i = 0; i < len; i++) p[i] -= mean;
    return p;
  }

  function rms(p) {
    let s = 0;
    for (let i = 0; i < p.length; i++) s += p[i] * p[i];
    return Math.sqrt(s / p.length);
  }

  // Deslocamento sub-pixel de `a` em relação a `b` (positivo = `a` deslocado para a direita/baixo).
  function bestLag(a, b, maxLag) {
    const n = a.length;
    const scores = new Float32Array(2 * maxLag + 1);
    let best = 0, bestScore = -Infinity;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let s = 0, na = 0, nb = 0;
      const i0 = Math.max(0, -lag), i1 = Math.min(n, n - lag);
      for (let i = i0; i < i1; i++) {
        const av = a[i + lag], bv = b[i];
        s += av * bv; na += av * av; nb += bv * bv;
      }
      const ncc = (na > 0 && nb > 0) ? s / Math.sqrt(na * nb) : -1;
      scores[lag + maxLag] = ncc;
      if (ncc > bestScore) { bestScore = ncc; best = lag; }
    }
    const i = best + maxLag;
    if (i > 0 && i < scores.length - 1) {
      const y0 = scores[i - 1], y1 = scores[i], y2 = scores[i + 1];
      const den = y0 - 2 * y1 + y2;
      if (Math.abs(den) > 1e-9) {
        const delta = 0.5 * (y0 - y2) / den;
        if (Math.abs(delta) <= 1) return { lag: best + delta, ncc: bestScore };
      }
    }
    return { lag: best, ncc: bestScore };
  }

  const MIN_RMS = 1.2;   // energia mínima de borda para o perfil ser confiável
  const MIN_NCC = 0.5;   // correlação mínima entre canais

  function convergence(img, n, maxLag) {
    n = n || 3; maxLag = maxLag || 12;
    const w = img.width, h = img.height, d = img.data, len = w * h;
    const R = new Float32Array(len), G = new Float32Array(len), B = new Float32Array(len);
    for (let i = 0, p = 0; p < len; i += 4, p++) { R[p] = d[i]; G[p] = d[i + 1]; B[p] = d[i + 2]; }

    const zones = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x0 = Math.floor(c * w / n), x1 = Math.floor((c + 1) * w / n);
        const y0 = Math.floor(r * h / n), y1 = Math.floor((r + 1) * h / n);

        const gx = profileX(G, w, x0, y0, x1, y1);
        const gy = profileY(G, w, x0, y0, x1, y1);
        const zone = { row: r, col: c, dxR: null, dyR: null, dxB: null, dyB: null, weak: false };

        if (rms(gx) >= MIN_RMS) {
          const rx = bestLag(profileX(R, w, x0, y0, x1, y1), gx, maxLag);
          const bx = bestLag(profileX(B, w, x0, y0, x1, y1), gx, maxLag);
          if (rx.ncc >= MIN_NCC) zone.dxR = rx.lag;
          if (bx.ncc >= MIN_NCC) zone.dxB = bx.lag;
        }
        if (rms(gy) >= MIN_RMS) {
          const ry = bestLag(profileY(R, w, x0, y0, x1, y1), gy, maxLag);
          const by = bestLag(profileY(B, w, x0, y0, x1, y1), gy, maxLag);
          if (ry.ncc >= MIN_NCC) zone.dyR = ry.lag;
          if (by.ncc >= MIN_NCC) zone.dyB = by.lag;
        }

        zone.weak = zone.dxR === null && zone.dyR === null && zone.dxB === null && zone.dyB === null;
        zone.magR = Math.hypot(zone.dxR || 0, zone.dyR || 0);
        zone.magB = Math.hypot(zone.dxB || 0, zone.dyB || 0);
        zone.worst = Math.max(zone.magR, zone.magB);
        zones.push(zone);
      }
    }
    return { n, zones };
  }

  /* ---------------- campo branco: uniformidade, hotspot, cor, luminância ---------------- */

  function whiteField(img, n) {
    n = n || 5;
    const w = img.width, h = img.height, d = img.data;
    const cells = [];
    for (let i = 0; i < n * n; i++) cells.push({ r: 0, g: 0, b: 0, y: 0, count: 0 });

    let clipped = 0, total = 0;
    for (let y = 0; y < h; y++) {
      const row = zi(y, h, n) * n;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) << 2;
        const R = d[i], G = d[i + 1], B = d[i + 2];
        const c = cells[row + zi(x, w, n)];
        c.r += R; c.g += G; c.b += B;
        c.y += 0.299 * R + 0.587 * G + 0.114 * B;
        c.count++;
        if (R >= 250 || G >= 250 || B >= 250) clipped++;
        total++;
      }
    }

    const zones = cells.map((c, i) => {
      const r = c.r / c.count, g = c.g / c.count, b = c.b / c.count;
      const sum = r + g + b || 1;
      return {
        row: (i / n) | 0, col: i % n,
        luma: c.y / c.count,
        r, g, b,
        cr: r / sum, cg: g / sum, cb: b / sum,
      };
    });

    const lumas = zones.map(z => z.luma);
    const max = Math.max.apply(null, lumas);
    const min = Math.min.apply(null, lumas);
    const mean = lumas.reduce((a, v) => a + v, 0) / lumas.length;
    zones.forEach(z => { z.rel = (z.luma / max) * 100; });

    const hotspot = zones[lumas.indexOf(max)];
    const centerIdx = ((n / 2) | 0) * n + ((n / 2) | 0);
    const center = zones[centerIdx];

    // Desvio de cor: distância de cromaticidade de cada zona em relação ao centro.
    zones.forEach(z => {
      z.dCr = z.cr - center.cr;
      z.dCb = z.cb - center.cb;
      z.dChroma = Math.hypot(z.dCr, z.dCb) * 1000; // em "milésimos" de cromaticidade
      z.tint = z.dCr > 0.004 ? 'mais quente' : (z.dCb > 0.004 ? 'mais frio' : 'neutro');
    });

    const worstChroma = zones.reduce((a, z) => z.dChroma > a.dChroma ? z : a, zones[0]);

    return {
      n, zones, center, hotspot,
      minLuma: min, maxLuma: max, meanLuma: mean,
      uniformityPct: (min / max) * 100,
      cornerVsCenter: [
        zones[0], zones[n - 1], zones[n * (n - 1)], zones[n * n - 1],
      ].map(z => (z.luma / center.luma) * 100),
      clipPct: (clipped / total) * 100,
      worstChroma,
    };
  }

  function meanLuma(img) {
    const d = img.data, len = img.width * img.height;
    let s = 0, clipped = 0;
    for (let i = 0, p = 0; p < len; i += 4, p++) {
      const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      s += y;
      if (d[i] >= 250 || d[i + 1] >= 250 || d[i + 2] >= 250) clipped++;
    }
    return { luma: s / len, clipPct: (clipped / len) * 100 };
  }

  /* ---------------- geometria / enquadramento ---------------- */

  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

  // quad = [tl, tr, br, bl]
  function geometry(quad) {
    const [tl, tr, br, bl] = quad;
    const topW = dist(tl, tr), bottomW = dist(bl, br);
    const leftH = dist(tl, bl), rightH = dist(tr, br);
    const keystoneH = Math.abs(topW - bottomW) / Math.max(topW, bottomW) * 100;
    const keystoneV = Math.abs(leftH - rightH) / Math.max(leftH, rightH) * 100;
    const rotation = Math.atan2(tr.y - tl.y, tr.x - tl.x) * 180 / Math.PI;
    const aspect = ((topW + bottomW) / 2) / ((leftH + rightH) / 2);
    return { topW, bottomW, leftH, rightH, keystoneH, keystoneV, rotation, aspect };
  }

  // Desvio do quadro projetado em relação ao masking, canto a canto.
  // Independente do ângulo da câmera: ambos os quadriláteros vêm da mesma foto.
  function framing(imageQuad, maskingQuad) {
    const names = ['Superior Esquerdo', 'Superior Direito', 'Inferior Direito', 'Inferior Esquerdo'];
    const refW = (dist(maskingQuad[0], maskingQuad[1]) + dist(maskingQuad[3], maskingQuad[2])) / 2 || 1;
    const corners = names.map((name, i) => {
      const dx = imageQuad[i].x - maskingQuad[i].x;
      const dy = imageQuad[i].y - maskingQuad[i].y;
      return {
        name,
        dxPct: dx / refW * 100,
        dyPct: dy / refW * 100,
        magPct: Math.hypot(dx, dy) / refW * 100,
      };
    });
    const worst = corners.reduce((a, c) => c.magPct > a.magPct ? c : a, corners[0]);
    return { corners, worst };
  }

  return {
    homographyRectToQuad, mapPoint, rectify,
    focus, scheimpflug, convergence, whiteField, meanLuma,
    geometry, framing,
  };
})();
