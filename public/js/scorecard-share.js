/**
 * BodyBank — scorecard PNG for native share (16:9 / 9:16).
 * Mirrors home dashboard scorecard (ring + weighted bar + pillars) + member line + FitChef credit.
 */
(function () {
  'use strict';

  var GOLD = '#c9a84c';
  var GOLD_LINE = 'rgba(200,164,78,0.35)';
  var CREAM = '#f5f0e8';
  var MUTED = '#94a3b8';
  var GREEN = '#6ee7b7';
  var RED = '#f87171';

  var DASH_SEG = {
    daily: { c0: 'rgba(200,164,78,0.25)', c1: 'rgba(200,164,78,0.95)' },
    sunday: { c0: 'rgba(245,158,11,0.25)', c1: 'rgba(245,158,11,0.92)' },
    workouts: { c0: 'rgba(110,231,183,0.28)', c1: 'rgba(16,185,129,0.92)' },
    progress: { c0: 'rgba(168,85,247,0.25)', c1: 'rgba(139,92,246,0.92)' }
  };

  var DOT_COLORS = {
    daily: '#d4af54',
    sunday: '#f59e0b',
    workouts: '#34d399',
    progress: '#a78bfa'
  };

  var DIM = {
    '16:9': { w: 1920, h: 1080 },
    '9:16': { w: 1080, h: 1920 }
  };

  function absAsset(path) {
    var o = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : '';
    if (!path) return '';
    if (/^https?:/i.test(path)) return path;
    return o + (path.charAt(0) === '/' ? path : '/' + path);
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        reject(new Error('img'));
      };
      img.src = src;
    });
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function computeScoreData(d) {
    var total =
      d.dedication_total != null
        ? Math.round(Number(d.dedication_total))
        : d.total != null
          ? Math.round(Number(d.total))
          : 0;
    var weekLabel = d.week_label || '—';
    var trendText = '';
    var trendUp = false;
    var trendDown = false;
    if (d.trend_delta != null && d.previous_total != null) {
      trendUp = d.trend_delta > 0;
      trendDown = d.trend_delta < 0;
      trendText =
        (trendUp ? '↑ ' : trendDown ? '↓ ' : '') +
        (d.trend_delta > 0 ? '+' : '') +
        Math.round(Number(d.trend_delta || 0)) +
        ' vs last week';
    }
    var pillars = d.dedication_pillars || d.pillars || {};
    var weights = d.dedication_weights || d.weights || {};
    var keys = ['daily', 'sunday', 'workouts', 'progress'];
    var labels = { daily: 'Daily', sunday: 'Sunday', workouts: 'Workouts', progress: 'Progress' };
    var wArr = keys.map(function (k) {
      return Math.max(0, Number(weights[k] || 0));
    });
    var sumW = wArr.reduce(function (a, b) {
      return a + b;
    }, 0);
    var norm = sumW > 0.0001 ? wArr.map(function (x) {
      return x / sumW;
    }) : [0.25, 0.25, 0.25, 0.25];
    return { total, weekLabel, trendText, trendUp, trendDown, pillars, keys, labels, norm };
  }

  function memberDisplayName(d) {
    var fn = d && d._share_first_name != null ? String(d._share_first_name).trim() : '';
    var ln = d && d._share_last_name != null ? String(d._share_last_name).trim() : '';
    if (!fn && typeof window !== 'undefined' && window.currentUser) {
      fn = String(window.currentUser.first_name || '').trim();
      ln = String(window.currentUser.last_name || '').trim();
    }
    var full = [fn, ln].filter(Boolean).join(' ').trim();
    return full || 'Member';
  }

  function shareBrandHost() {
    var h =
      typeof window !== 'undefined' && window.location && window.location.hostname
        ? String(window.location.hostname).replace(/^www\./, '')
        : '';
    if (!h || h === 'localhost' || h === '127.0.0.1' || /^192\.168\.\d+\.\d+$/.test(h) || /^10\.\d+\.\d+\.\d+$/.test(h)) {
      return 'bodybank.fit';
    }
    return h;
  }

  function augmentScorecardForShare(d) {
    var o = d && typeof d === 'object' ? Object.assign({}, d) : {};
    var u = typeof window !== 'undefined' ? window.currentUser : null;
    if (u) {
      o._share_first_name = u.first_name || '';
      o._share_last_name = u.last_name || '';
    }
    return o;
  }

  async function ensureFonts() {
    if (document.fonts && document.fonts.ready) {
      try {
        await document.fonts.ready;
      } catch (e) {
        /* ignore */
      }
    }
  }

  function drawBackdrop(ctx, W, H) {
    var g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#08080a');
    g.addColorStop(0.5, '#0e0e12');
    g.addColorStop(1, '#050506');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /** Dashboard-style inner card (.bb-scorecard-inner) */
  function drawScorecardPanel(ctx, x, y, w, h, r) {
    ctx.save();
    roundRectPath(ctx, x, y, w, h, r);
    var panel = ctx.createLinearGradient(x, y, x + w, y + h);
    panel.addColorStop(0, 'rgba(200,164,78,0.12)');
    panel.addColorStop(0.42, 'rgba(255,255,255,0.03)');
    panel.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = panel;
    ctx.fill();
    ctx.strokeStyle = 'rgba(200,164,78,0.22)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    var rg = ctx.createRadialGradient(x + w * 0.2, y, 0, x + w * 0.2, y, w * 0.9);
    rg.addColorStop(0, 'rgba(200,164,78,0.18)');
    rg.addColorStop(0.58, 'rgba(0,0,0,0)');
    ctx.save();
    roundRectPath(ctx, x, y, w, h, r);
    ctx.clip();
    ctx.fillStyle = rg;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    ctx.restore();
  }

  /** Static ring like dashboard — full circle, score inside (Bebas). */
  function drawDashboardRing(ctx, cx, cy, radius, scoreStr, ringPx) {
    ctx.save();
    var glow = ctx.createRadialGradient(cx, cy, radius * 0.3, cx, cy, radius * 1.35);
    glow.addColorStop(0, 'rgba(200,164,78,0.2)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    var inner = ctx.createRadialGradient(cx - radius * 0.35, cy - radius * 0.35, 0, cx, cy, radius);
    inner.addColorStop(0, 'rgba(200,164,78,0.22)');
    inner.addColorStop(0.55, 'rgba(0,0,0,0.32)');
    inner.addColorStop(1, 'rgba(0,0,0,0.38)');
    ctx.fillStyle = inner;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(200,164,78,0.5)';
    ctx.lineWidth = ringPx;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, radius - ringPx * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var fs = Math.round(radius * 0.92);
    ctx.font = "400 " + fs + "px 'Bebas Neue', 'Impact', sans-serif";
    ctx.fillStyle = GOLD;
    ctx.fillText(scoreStr, cx, cy + fs * 0.06);
    ctx.restore();
  }

  function drawDashboardBar(ctx, keys, norm, pillars, x, y, barW, barH, padInner) {
    var trackR = barH / 2;
    ctx.save();
    roundRectPath(ctx, x, y, barW, barH, trackR);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(200,164,78,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    var innerX = x + padInner;
    var innerY = y + padInner;
    var innerW = barW - padInner * 2;
    var innerH = barH - padInner * 2;
    var gap = 2;
    var totalGap = gap * (keys.length - 1);
    var avail = innerW - totalGap;
    var x0 = innerX;
    keys.forEach(function (k, i) {
      var segW = norm[i] * avail;
      var fillPct = Math.max(0, Math.min(100, Number(pillars[k] || 0)));
      var r = innerH / 2;
      var dc = DASH_SEG[k] || DASH_SEG.daily;
      ctx.save();
      roundRectPath(ctx, x0, innerY, Math.max(segW, 4), innerH, r);
      ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(x0, innerY, segW, innerH);
      var fillW = (segW * fillPct) / 100;
      if (fillW > 0.5) {
        var lg = ctx.createLinearGradient(x0, innerY, x0 + fillW, innerY);
        lg.addColorStop(0, dc.c0);
        lg.addColorStop(1, dc.c1);
        ctx.fillStyle = lg;
        ctx.fillRect(x0, innerY, fillW, innerH);
      }
      ctx.restore();
      x0 += segW + gap;
    });
  }

  function drawLegendGrid(ctx, keys, norm, pillars, labels, x, y, totalW, rowH, fsLbl, fsStrong, gapX, gapY, dotR) {
    dotR = dotR == null ? 5 : dotR;
    var colW = (totalW - gapX) / 2;
    var midY = 0;
    keys.forEach(function (k, i) {
      var col = i % 2;
      var row = Math.floor(i / 2);
      var bx = x + col * (colW + gapX);
      var by = y + row * (rowH + gapY);
      midY = by + rowH / 2;
      var score = Math.max(0, Math.min(100, Math.round(Number(pillars[k] || 0))));
      var wPct = Math.round(norm[i] * 100);
      var dot = DOT_COLORS[k] || GOLD;
      ctx.save();
      ctx.textBaseline = 'middle';
      ctx.fillStyle = dot;
      ctx.beginPath();
      ctx.arc(bx + dotR + 4, midY, dotR, 0, Math.PI * 2);
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.fillStyle = MUTED;
      ctx.font = '600 ' + fsLbl + 'px "Outfit", system-ui, sans-serif';
      ctx.fillText(labels[k], bx + dotR * 2 + 14, midY);
      var strong = score + ' · ' + wPct + '%';
      ctx.font = '700 ' + fsStrong + 'px "Outfit", system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = CREAM;
      ctx.fillText(strong, bx + colW - 4, midY);
      ctx.restore();
    });
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  function drawPillarTiles(ctx, keys, pillars, labels, x, y, totalW, tileH, gap, fsLbl, fsVal, rTile) {
    var colW = (totalW - gap) / 2;
    keys.forEach(function (k, i) {
      var col = i % 2;
      var row = Math.floor(i / 2);
      var bx = x + col * (colW + gap);
      var by = y + row * (tileH + gap);
      ctx.save();
      roundRectPath(ctx, bx, by, colW, tileH, rTile);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(200,164,78,0.22)';
      ctx.lineWidth = 1.25;
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(200,164,78,0.95)';
      ctx.font = '800 ' + fsLbl + 'px "Outfit", system-ui, sans-serif';
      ctx.letterSpacing = '0.14em';
      ctx.fillText(String(labels[k]).toUpperCase(), bx + colW / 2, by + tileH * 0.34);
      ctx.letterSpacing = '0';
      var v = pillars[k] != null ? String(Math.round(Number(pillars[k]))) : '—';
      ctx.font = "400 " + fsVal + "px 'Bebas Neue', 'Impact', sans-serif";
      ctx.fillStyle = CREAM;
      ctx.fillText(v, bx + colW / 2, by + tileH * 0.72);
      ctx.restore();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    });
  }

  async function drawFitchefFooter(ctx, W, H, yTop, maxLogoH, fsCo, fsUrl) {
    fsCo = fsCo || 16;
    fsUrl = fsUrl || 14;
    var padX = Math.round(W * 0.08);
    ctx.strokeStyle = GOLD_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, yTop);
    ctx.lineTo(W - padX, yTop);
    ctx.stroke();

    var cy = yTop + 26;
    var fitchefImg = null;
    try {
      fitchefImg = await loadImage(absAsset('img/Fitchef logo.png'));
    } catch (e) {
      /* text-only credit */
    }
    if (fitchefImg && fitchefImg.naturalWidth) {
      var lh = maxLogoH;
      var lw = (fitchefImg.naturalWidth / fitchefImg.naturalHeight) * lh;
      ctx.drawImage(fitchefImg, (W - lw) / 2, cy, lw, lh);
      cy += lh + 12;
    } else {
      cy += 6;
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = GOLD;
    ctx.font = '600 ' + fsCo + 'px "Outfit", system-ui, sans-serif';
    ctx.fillText('Co-Powered by FitChef Nutrition', W / 2, cy);
    cy += Math.round(fsCo * 1.45);
    ctx.font = '500 ' + fsUrl + 'px "Outfit", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(200,164,78,0.92)';
    ctx.fillText('www.Fitchef.fit', W / 2, cy);

    var fsHost = Math.max(14, Math.round((fsUrl || 14) * 0.95));
    ctx.font = '600 ' + fsHost + 'px "Outfit", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(200, 164, 78, 0.72)';
    ctx.fillText(shareBrandHost(), W / 2, H - Math.max(18, Math.round(fsHost * 1.15)));
  }

  async function drawScorecard169(canvas, d) {
    var W = DIM['16:9'].w;
    var H = DIM['16:9'].h;
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    canvas.width = W;
    canvas.height = H;
    await ensureFonts();

    drawBackdrop(ctx, W, H);

    var footerH = 218;
    var margin = 40;
    var cardX = margin;
    var cardY = margin;
    var cardW = W - margin * 2;
    var cardH = H - margin - footerH;
    drawScorecardPanel(ctx, cardX, cardY, cardW, cardH, 18);

    var px = cardX + 32;
    var py = cardY + 28;
    var innerW = cardW - 64;
    var logoH = 132;

    try {
      var logo = await loadImage(absAsset('img/logo.png'));
      var lh = logoH;
      var lw = (logo.naturalWidth / logo.naturalHeight) * lh;
      ctx.drawImage(logo, px, py, lw, lh);
    } catch (e) {
      /* skip */
    }

    var memberName = memberDisplayName(d);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = GOLD;
    ctx.font = '700 38px "Outfit", system-ui, sans-serif';
    ctx.fillText(memberName, cardX + cardW - 32, py + 42);
    ctx.fillStyle = 'rgba(212, 175, 55, 0.95)';
    ctx.font = '800 15px "Outfit", system-ui, sans-serif';
    ctx.letterSpacing = '0.26em';
    ctx.fillText('TRIBE ELITE MEMBER', cardX + cardW - 32, py + 78);
    ctx.letterSpacing = '0';
    ctx.textAlign = 'left';

    var S = computeScoreData(d);
    var headY = py + logoH + 32;
    var ringR = 100;
    var ringLine = 3;
    var rcx = px + ringR + 6;
    var rcy = headY + ringR;
    drawDashboardRing(ctx, rcx, rcy, ringR, String(S.total), ringLine);

    var metaX = px + ringR * 2 + 44;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(200,164,78,0.95)';
    ctx.font = '800 15px "Outfit", system-ui, sans-serif';
    ctx.letterSpacing = '0.26em';
    ctx.fillText('WEEKLY SCORE', metaX, headY + 22);
    ctx.letterSpacing = '0';
    ctx.fillStyle = MUTED;
    ctx.font = '500 30px "Outfit", system-ui, sans-serif';
    ctx.fillText(S.weekLabel, metaX, headY + 58);
    ctx.fillStyle = CREAM;
    ctx.font = '700 32px "Outfit", system-ui, sans-serif';
    ctx.fillText('BodyBank score', metaX, headY + 98);
    if (S.trendText) {
      ctx.fillStyle = S.trendUp ? GREEN : S.trendDown ? RED : MUTED;
      ctx.font = '600 24px "Outfit", system-ui, sans-serif';
      ctx.fillText(S.trendText, metaX, headY + 136);
    }

    var barY = headY + ringR * 2 + 40;
    var barH = 36;
    var barW = innerW;
    drawDashboardBar(ctx, S.keys, S.norm, S.pillars, px, barY, barW, barH, 4);

    var legRowH = 44;
    var legY = barY + barH + 22;
    drawLegendGrid(ctx, S.keys, S.norm, S.pillars, S.labels, px, legY, barW, legRowH, 18, 22, 20, 12, 7);

    var pillarY = legY + legRowH * 2 + 12 + 18;
    var tileH = 108;
    var remain = cardY + cardH - pillarY - 16;
    if (remain < tileH * 2 + 14) {
      tileH = Math.max(88, Math.floor((remain - 14) / 2));
    }
    drawPillarTiles(ctx, S.keys, S.pillars, S.labels, px, pillarY, barW, tileH, 14, 15, 48, 14);

    await drawFitchefFooter(ctx, W, H, cardY + cardH + 14, 58, 22, 18);
  }

  async function drawScorecard916(canvas, d) {
    var W = DIM['9:16'].w;
    var H = DIM['9:16'].h;
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    canvas.width = W;
    canvas.height = H;
    await ensureFonts();

    drawBackdrop(ctx, W, H);

    var footerH = 232;
    var margin = 28;
    var cardX = margin;
    var cardY = margin;
    var cardW = W - margin * 2;
    var cardH = H - margin - footerH;
    drawScorecardPanel(ctx, cardX, cardY, cardW, cardH, 16);

    var px = cardX + 24;
    var py = cardY + 22;
    var innerW = cardW - 48;
    var logoH = 92;

    try {
      var logo = await loadImage(absAsset('img/logo.png'));
      var lh = logoH;
      var lw = (logo.naturalWidth / logo.naturalHeight) * lh;
      ctx.drawImage(logo, px, py, lw, lh);
    } catch (e) {}

    var memberName = memberDisplayName(d);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = GOLD;
    ctx.font = '700 32px "Outfit", system-ui, sans-serif';
    ctx.fillText(memberName, cardX + cardW - 24, py + 36);
    ctx.fillStyle = 'rgba(212, 175, 55, 0.95)';
    ctx.font = '800 13px "Outfit", system-ui, sans-serif';
    ctx.letterSpacing = '0.22em';
    ctx.fillText('TRIBE ELITE MEMBER', cardX + cardW - 24, py + 68);
    ctx.letterSpacing = '0';
    ctx.textAlign = 'left';

    var S = computeScoreData(d);
    var headY = py + logoH + 26;
    var ringR = 92;
    var rcx = cardX + cardW / 2;
    var rcy = headY + ringR;
    drawDashboardRing(ctx, rcx, rcy, ringR, String(S.total), 3);

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(200,164,78,0.95)';
    ctx.font = '800 13px "Outfit", system-ui, sans-serif';
    ctx.letterSpacing = '0.22em';
    ctx.fillText('WEEKLY SCORE', rcx, rcy + ringR + 32);
    ctx.letterSpacing = '0';
    ctx.fillStyle = MUTED;
    ctx.font = '500 24px "Outfit", system-ui, sans-serif';
    ctx.fillText(S.weekLabel, rcx, rcy + ringR + 64);
    ctx.fillStyle = CREAM;
    ctx.font = '700 26px "Outfit", system-ui, sans-serif';
    ctx.fillText('BodyBank score', rcx, rcy + ringR + 100);
    if (S.trendText) {
      ctx.fillStyle = S.trendUp ? GREEN : S.trendDown ? RED : MUTED;
      ctx.font = '600 20px "Outfit", system-ui, sans-serif';
      ctx.fillText(S.trendText, rcx, rcy + ringR + 136);
    }
    ctx.textAlign = 'left';

    var barY = rcy + ringR + 158;
    var barH = 30;
    drawDashboardBar(ctx, S.keys, S.norm, S.pillars, px, barY, innerW, barH, 3);

    var legRowH = 40;
    var legY = barY + barH + 18;
    drawLegendGrid(ctx, S.keys, S.norm, S.pillars, S.labels, px, legY, innerW, legRowH, 16, 20, 14, 10, 6);

    var pillarY = legY + legRowH * 2 + 10 + 16;
    var tileH = 96;
    var remain = cardY + cardH - pillarY - 12;
    if (remain < tileH * 2 + 12) {
      tileH = Math.max(80, Math.floor((remain - 12) / 2));
    }
    drawPillarTiles(ctx, S.keys, S.pillars, S.labels, px, pillarY, innerW, tileH, 12, 14, 42, 12);

    await drawFitchefFooter(ctx, W, H, cardY + cardH + 12, 52, 20, 17);
  }

  async function drawScorecardShare(canvas, d, aspect) {
    aspect = aspect === '9:16' ? '9:16' : '16:9';
    if (aspect === '9:16') {
      await drawScorecard916(canvas, d);
    } else {
      await drawScorecard169(canvas, d);
    }
  }

  function fileNameForAspect(aspect) {
    return aspect === '9:16' ? 'BodyBank-weekly-score-story.png' : 'BodyBank-weekly-score-16x9.png';
  }

  function generateScorecardShareBlob(d, aspect) {
    aspect = aspect === '9:16' ? '9:16' : '16:9';
    var payload = augmentScorecardForShare(d);
    var canvas = document.createElement('canvas');
    return drawScorecardShare(canvas, payload, aspect).then(function () {
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('Could not create image.'));
        }, 'image/png', 0.95);
      });
    });
  }

  function setShareBusy(busy) {
    document.querySelectorAll('.bb-sc-share-btn').forEach(function (b) {
      b.disabled = !!busy;
      if (busy) {
        if (!b.dataset._lbl) b.dataset._lbl = b.textContent;
        b.textContent = 'Creating…';
      } else if (b.dataset._lbl) {
        b.textContent = b.dataset._lbl;
      }
    });
  }

  function fallbackDownload(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
    }, 4000);
  }

  function closeScorecardShareFormatModal() {
    var m = document.getElementById('bbScoreShareFormatModal');
    if (!m) return;
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
  }

  async function runShareWithAspect(d, aspect) {
    var fileName = fileNameForAspect(aspect);
    setShareBusy(true);
    try {
      var blob = await generateScorecardShareBlob(d, aspect);
      var file = new File([blob], fileName, { type: 'image/png' });

      if (
        navigator.share &&
        typeof navigator.canShare === 'function' &&
        navigator.canShare({ files: [file] })
      ) {
        try {
          await navigator.share({
            files: [file],
            title: 'My BodyBank weekly score',
            text: 'My weekly score on BodyBank'
          });
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          openScorecardShareModal(blob, aspect);
        }
      } else {
        openScorecardShareModal(blob, aspect);
      }
    } catch (e) {
      if (typeof showPopup === 'function') {
        showPopup(
          'Share',
          e && e.message ? e.message : 'Could not create the image. Please try again.',
          '',
          'OK',
          null,
          'error'
        );
      }
    } finally {
      setShareBusy(false);
    }
  }

  window.bbScoreSharePickFormat = function (aspect) {
    closeScorecardShareFormatModal();
    var d = window._bbScorecardCache;
    if (!d) return;
    runShareWithAspect(d, aspect === '9:16' ? '9:16' : '16:9');
  };

  async function shareScorecardImage() {
    var d = window._bbScorecardCache;
    if (!d && typeof loadScorecard === 'function') {
      await loadScorecard();
      d = window._bbScorecardCache;
    }
    if (!d) {
      if (typeof showPopup === 'function') {
        showPopup('Scorecard', 'Open Home and wait for your score to load, then try again.', '', 'OK', null, 'error');
      }
      return;
    }

    var modal = document.getElementById('bbScoreShareFormatModal');
    if (modal) {
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
    } else {
      runShareWithAspect(d, '16:9');
    }
  }

  function openScorecardShareModal(blob, aspect) {
    aspect = aspect === '9:16' ? '9:16' : '16:9';
    var modal = document.getElementById('bbScoreShareModal');
    var img = document.getElementById('bbScoreSharePreview');
    var wrap = document.getElementById('bbScoreSharePreviewWrap');
    if (!modal || !img) {
      fallbackDownload(blob, fileNameForAspect(aspect));
      return;
    }
    if (wrap) {
      wrap.classList.toggle('bb-score-share-preview-wrap--story', aspect === '9:16');
    }
    img.classList.toggle('bb-score-share-preview--story', aspect === '9:16');
    var url = URL.createObjectURL(blob);
    if (img._prevUrl) URL.revokeObjectURL(img._prevUrl);
    img._prevUrl = url;
    img.src = url;
    img.alt =
      aspect === '9:16'
        ? 'BodyBank weekly score — 9:16 story image'
        : 'BodyBank weekly score — 16:9 image';
    img.dataset.shareAspect = aspect;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');

    var fn = fileNameForAspect(aspect);
    var dl = document.getElementById('bbScoreShareDownload');
    if (dl) {
      dl.onclick = function () {
        fallbackDownload(blob, fn);
      };
    }
    var native = document.getElementById('bbScoreShareNative');
    if (native) {
      native.onclick = async function () {
        var f = new File([blob], fn, { type: 'image/png' });
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [f] })) {
          try {
            await navigator.share({ files: [f], title: 'My BodyBank weekly score' });
          } catch (err) {
            if (err && err.name !== 'AbortError') fallbackDownload(blob, fn);
          }
        } else {
          fallbackDownload(blob, fn);
        }
      };
    }
  }

  function closeScorecardShareModal() {
    var modal = document.getElementById('bbScoreShareModal');
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    var img = document.getElementById('bbScoreSharePreview');
    var wrap = document.getElementById('bbScoreSharePreviewWrap');
    if (wrap) {
      wrap.classList.remove('bb-score-share-preview-wrap--story');
    }
    if (img) {
      img.classList.remove('bb-score-share-preview--story');
      if (img._prevUrl) {
        URL.revokeObjectURL(img._prevUrl);
        img._prevUrl = null;
      }
      img.removeAttribute('src');
      delete img.dataset.shareAspect;
    }
  }

  window.shareScorecardImage = shareScorecardImage;
  window.closeScorecardShareModal = closeScorecardShareModal;
  window.closeScorecardShareFormatModal = closeScorecardShareFormatModal;
  window.openScorecardShareModal = openScorecardShareModal;
  window.generateScorecardShareBlob = generateScorecardShareBlob;
})();
