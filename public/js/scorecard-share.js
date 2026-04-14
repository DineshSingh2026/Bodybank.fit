/**
 * BodyBank — ultra-luxury scorecard PNG for native share (16:9 / 9:16).
 * Editorial layout: Playfair + Bebas + Outfit, full bleed composition, statement pillar cards.
 */
(function () {
  'use strict';

  var GOLD = '#d4b968';
  var GOLD_SOFT = 'rgba(212,185,104,0.92)';
  var GOLD_LINE = 'rgba(200,164,78,0.42)';
  var GOLD_DIM = 'rgba(200,164,78,0.28)';
  var CREAM = '#f7f2ea';
  var MUTED = '#9ca8b8';
  var MUTED_SOFT = 'rgba(247,242,234,0.55)';
  var GREEN = '#5ee9b5';
  var RED = '#ff8a8a';

  var DASH_SEG = {
    daily: { c0: 'rgba(200,164,78,0.25)', c1: 'rgba(212,175,84,0.98)' },
    sunday: { c0: 'rgba(245,158,11,0.25)', c1: 'rgba(251,191,36,0.95)' },
    workouts: { c0: 'rgba(110,231,183,0.28)', c1: 'rgba(52,211,153,0.95)' },
    progress: { c0: 'rgba(167,139,250,0.28)', c1: 'rgba(167,139,250,0.95)' }
  };

  var DOT_COLORS = {
    daily: '#e8c86a',
    sunday: '#fbbf24',
    workouts: '#34d399',
    progress: '#c4b5fd'
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

  async function ensureLuxuryFonts() {
    if (!document.fonts || !document.fonts.load) {
      return;
    }
    var specs = [
      "400 28px 'Playfair Display'",
      "400 36px 'Playfair Display'",
      "italic 600 34px 'Playfair Display'",
      "italic 600 28px 'Playfair Display'",
      "600 32px 'Playfair Display'",
      "italic 600 56px 'Cormorant Garamond'",
      "italic 600 52px 'Cormorant Garamond'",
      "italic 600 42px 'Cormorant Garamond'",
      "400 220px 'Bebas Neue'",
      "400 120px 'Bebas Neue'",
      "400 80px 'Bebas Neue'",
      "400 72px 'Bebas Neue'",
      "400 58px 'Bebas Neue'",
      "500 24px 'Cormorant Garamond'",
      "600 22px 'Outfit'",
      "600 28px 'Outfit'",
      "700 34px 'Outfit'",
      "700 44px 'Outfit'",
      "700 58px 'Outfit'",
      "700 56px 'Outfit'",
      "800 17px 'Outfit'",
      "800 20px 'Outfit'"
    ];
    await Promise.all(
      specs.map(function (s) {
        return document.fonts.load(s).catch(function () {
          return null;
        });
      })
    );
    try {
      await document.fonts.ready;
    } catch (e) {
      /* ignore */
    }
  }

  function drawBackdropLuxury(ctx, W, H) {
    var g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#040406');
    g.addColorStop(0.4, '#0b0b10');
    g.addColorStop(1, '#020203');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    var r1 = ctx.createRadialGradient(W * 0.1, H * 0.06, 0, W * 0.1, H * 0.06, W * 0.65);
    r1.addColorStop(0, 'rgba(200,164,78,0.16)');
    r1.addColorStop(0.5, 'rgba(200,164,78,0.03)');
    r1.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = r1;
    ctx.fillRect(0, 0, W, H);

    var r2 = ctx.createRadialGradient(W * 0.92, H * 0.95, 0, W * 0.92, H * 0.95, H * 0.45);
    r2.addColorStop(0, 'rgba(160,120,60,0.1)');
    r2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = r2;
    ctx.fillRect(0, 0, W, H);

    var rv = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.28, W / 2, H / 2, Math.max(W, H) * 0.75);
    rv.addColorStop(0, 'rgba(0,0,0,0)');
    rv.addColorStop(1, 'rgba(0,0,0,0.52)');
    ctx.fillStyle = rv;
    ctx.fillRect(0, 0, W, H);
  }

  function drawLuxuryCardPanel(ctx, x, y, w, h, r) {
    roundRectPath(ctx, x, y, w, h, r);
    ctx.fillStyle = 'rgba(6,6,10,0.94)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(200,164,78,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    roundRectPath(ctx, x + 2, y + 2, w - 4, h - 4, Math.max(0, r - 2));
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.save();
    roundRectPath(ctx, x, y, w, h, r);
    ctx.clip();
    var lg = ctx.createLinearGradient(x, y, x, y + h * 0.5);
    lg.addColorStop(0, 'rgba(200,164,78,0.11)');
    lg.addColorStop(0.55, 'rgba(255,255,255,0.02)');
    lg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = lg;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }

  function drawCornerOrnaments(ctx, x, y, w, h, len, lw) {
    len = len || 36;
    lw = lw || 2;
    ctx.save();
    ctx.strokeStyle = GOLD_LINE;
    ctx.lineWidth = lw;
    ctx.lineCap = 'square';
    // TL
    ctx.beginPath();
    ctx.moveTo(x, y + len);
    ctx.lineTo(x, y);
    ctx.lineTo(x + len, y);
    ctx.stroke();
    // TR
    ctx.beginPath();
    ctx.moveTo(x + w - len, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + len);
    ctx.stroke();
    // BR
    ctx.beginPath();
    ctx.moveTo(x + w, y + h - len);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w - len, y + h);
    ctx.stroke();
    // BL
    ctx.beginPath();
    ctx.moveTo(x + len, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + h - len);
    ctx.stroke();
    ctx.restore();
  }

  function drawLuxuryRing(ctx, cx, cy, radius, scoreStr, ringPx, useAdvanceCenter) {
    ctx.save();
    var glow = ctx.createRadialGradient(cx, cy, radius * 0.25, cx, cy, radius * 1.45);
    glow.addColorStop(0, 'rgba(212,185,104,0.35)');
    glow.addColorStop(0.55, 'rgba(200,164,78,0.08)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 14, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    var inner = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    inner.addColorStop(0, 'rgba(200,164,78,0.24)');
    inner.addColorStop(0.48, 'rgba(10,10,14,0.88)');
    inner.addColorStop(1, 'rgba(0,0,0,0.52)');
    ctx.fillStyle = inner;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(200,164,78,0.55)';
    ctx.lineWidth = ringPx;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, radius - ringPx * 0.45, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    drawRingScoreText(ctx, cx, cy, scoreStr, radius, useAdvanceCenter);
  }

  /**
   * Center score in ring. useAdvanceCenter (16:9): geometric center via measureText.width only —
   * avoids bounding-box dx that often skews Bebas digits. Default false keeps optical dx for 9:16.
   */
  function drawRingScoreText(ctx, cx, cy, scoreStr, radius, useAdvanceCenter) {
    var digits = String(scoreStr).length;
    var mult = digits >= 3 ? 0.98 : digits === 2 ? 1.12 : 1.18;
    var fs = Math.round(radius * mult);
    fs = Math.max(fs, Math.round(radius * 0.82));
    var s = String(scoreStr);
    ctx.save();
    ctx.font = "400 " + fs + "px 'Bebas Neue', 'Impact', sans-serif";
    ctx.fillStyle = GOLD;
    ctx.letterSpacing = '0px';
    if ('fontKerning' in ctx) ctx.fontKerning = 'normal';

    var m = ctx.measureText(s);
    var ascent =
      typeof m.actualBoundingBoxAscent === 'number' && !isNaN(m.actualBoundingBoxAscent)
        ? m.actualBoundingBoxAscent
        : fs * 0.72;
    var descent =
      typeof m.actualBoundingBoxDescent === 'number' && !isNaN(m.actualBoundingBoxDescent)
        ? m.actualBoundingBoxDescent
        : fs * 0.28;
    var baselineY = cy + (ascent - descent) / 2;

    var dx = 0;
    if (!useAdvanceCenter) {
      if (typeof m.actualBoundingBoxLeft === 'number' && typeof m.actualBoundingBoxRight === 'number') {
        dx = (m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2;
      }
    }

    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(200,164,78,0.28)';
    ctx.shadowBlur = useAdvanceCenter ? 12 : 18;
    if (useAdvanceCenter) {
      ctx.textAlign = 'left';
      ctx.fillText(s, cx - m.width / 2, baselineY);
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(s, cx + dx, baselineY);
    }
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  /** Center pillar / small numeric Bebas strings (no inherited letter-spacing). */
  function drawNumericCentered(ctx, text, cx, cyMid, fs) {
    var s = String(text);
    ctx.save();
    ctx.letterSpacing = '0px';
    if ('fontKerning' in ctx) ctx.fontKerning = 'normal';
    var m = ctx.measureText(s);
    var ascent =
      typeof m.actualBoundingBoxAscent === 'number' && !isNaN(m.actualBoundingBoxAscent)
        ? m.actualBoundingBoxAscent
        : fs * 0.72;
    var descent =
      typeof m.actualBoundingBoxDescent === 'number' && !isNaN(m.actualBoundingBoxDescent)
        ? m.actualBoundingBoxDescent
        : fs * 0.28;
    var baselineY = cyMid + (ascent - descent) / 2;
    var dx = 0;
    if (typeof m.actualBoundingBoxLeft === 'number' && typeof m.actualBoundingBoxRight === 'number') {
      dx = (m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2;
    }
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    ctx.fillText(s, cx + dx, baselineY);
    ctx.restore();
  }

  function drawWeightedBar(ctx, keys, norm, pillars, x, y, barW, barH, padInner) {
    var trackR = barH / 2;
    ctx.save();
    roundRectPath(ctx, x, y, barW, barH, trackR);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fill();
    ctx.strokeStyle = GOLD_DIM;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    var innerX = x + padInner;
    var innerY = y + padInner;
    var innerW = barW - padInner * 2;
    var innerH = barH - padInner * 2;
    var gap = 1;
    var totalGap = gap * (keys.length - 1);
    var avail = innerW - totalGap;
    var x0 = innerX;
    keys.forEach(function (k, i) {
      var segW = norm[i] * avail;
      var fillPct = Math.max(0, Math.min(100, Number(pillars[k] || 0)));
      var r = innerH / 2;
      var dc = DASH_SEG[k] || DASH_SEG.daily;
      ctx.save();
      roundRectPath(ctx, x0, innerY, Math.max(segW, 5), innerH, r);
      ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
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

  /** One luxury pillar card with mini bar — full space use. */
  function drawPillarStatementCard(ctx, k, i, keys, norm, pillars, labels, bx, by, cw, ch, fsLabel, fsNum, fsMeta) {
    var score = Math.max(0, Math.min(100, Math.round(Number(pillars[k] || 0))));
    var wPct = Math.round(norm[i] * 100);
    var dot = DOT_COLORS[k] || GOLD;
    var dc = DASH_SEG[k] || DASH_SEG.daily;
    if (ch < 200) {
      var sc = Math.max(0.55, Math.min(1, ch / 200));
      fsLabel = Math.max(11, Math.round(fsLabel * sc));
      var capNum = Math.max(34, Math.min(Math.round(ch * 0.34), 92));
      fsNum = Math.max(34, Math.min(Math.round(fsNum * sc), capNum));
      fsMeta = Math.max(14, Math.min(Math.round(fsMeta * sc), Math.round(ch * 0.17)));
    }

    ctx.save();
    roundRectPath(ctx, bx, by, cw, ch, 12);
    var cardG = ctx.createLinearGradient(bx, by, bx + cw, by + ch);
    cardG.addColorStop(0, 'rgba(200,164,78,0.1)');
    cardG.addColorStop(0.35, 'rgba(255,255,255,0.03)');
    cardG.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = cardG;
    ctx.fill();
    ctx.strokeStyle = 'rgba(200,164,78,0.32)';
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx + 10, by + 3);
    ctx.lineTo(bx + cw - 10, by + 3);
    ctx.strokeStyle = dot;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();

    var cx = bx + cw / 2;
    var barH = Math.max(14, Math.round(ch * 0.11));
    var padBottom = Math.max(8, Math.round(ch * 0.035));
    var padTop = Math.max(14, Math.round(ch * 0.048));
    var gapLN = Math.max(20, Math.round(fsNum * 0.3));
    var gapNM = Math.max(14, Math.round(fsNum * 0.18));
    var gapMetaBar = Math.max(12, Math.round(fsMeta * 0.58));

    var labelCy = by + padTop + fsLabel * 0.55;
    var numberCy = labelCy + fsLabel * 0.62 + gapLN + fsNum * 0.42;
    var metaCy = numberCy + fsNum * 0.44 + gapNM + fsMeta * 0.35;
    var barY = metaCy + fsMeta * 0.62 + gapMetaBar;

    if (barY + barH > by + ch - padBottom) {
      barY = by + ch - padBottom - barH;
      metaCy = barY - gapMetaBar - fsMeta * 0.55;
      numberCy = metaCy - gapNM - fsNum * 0.48 - fsMeta * 0.2;
      labelCy = numberCy - gapLN - fsNum * 0.48 - fsLabel * 0.55;
      if (labelCy < by + padTop + fsLabel * 0.45) {
        labelCy = by + padTop + fsLabel * 0.55;
        var minMid =
          labelCy + fsLabel * 0.62 + gapLN + fsNum * 0.42;
        if (numberCy < minMid) numberCy = minMid;
        minMid = numberCy + fsNum * 0.44 + gapNM + fsMeta * 0.35;
        if (metaCy < minMid) metaCy = minMid;
        barY = metaCy + fsMeta * 0.62 + gapMetaBar;
        if (barY + barH > by + ch - padBottom) {
          barY = by + ch - padBottom - barH;
        }
      }
    }

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = GOLD_SOFT;
    ctx.font = '800 ' + fsLabel + 'px "Outfit", system-ui, sans-serif';
    ctx.letterSpacing = '0.22em';
    ctx.fillText(String(labels[k]).toUpperCase(), cx, labelCy);
    ctx.letterSpacing = '0px';
    if ('fontKerning' in ctx) ctx.fontKerning = 'normal';

    ctx.font = "400 " + fsNum + "px 'Bebas Neue', 'Impact', sans-serif";
    ctx.fillStyle = CREAM;
    drawNumericCentered(ctx, String(score), cx, numberCy, fsNum);

    ctx.font = '600 ' + fsMeta + 'px "Outfit", system-ui, sans-serif';
    ctx.fillStyle = MUTED;
    ctx.fillText('Weight · ' + wPct + '%', cx, metaCy);
    var barX = bx + 14;
    var barW = cw - 28;
    roundRectPath(ctx, barX, barY, barW, barH, barH / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fill();
    var fillW = (barW * score) / 100;
    if (fillW > 1) {
      roundRectPath(ctx, barX, barY, fillW, barH, barH / 2);
      var lg = ctx.createLinearGradient(barX, barY, barX + fillW, barY);
      lg.addColorStop(0, dc.c0);
      lg.addColorStop(1, dc.c1);
      ctx.fillStyle = lg;
      ctx.fill();
    }
    ctx.restore();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  async function drawFitchefFooter(ctx, W, H, yTop, maxLogoH, fsCo, fsUrl, fsHost) {
    fsCo = fsCo || 26;
    fsUrl = fsUrl || 22;
    fsHost = fsHost || 20;
    var padX = Math.round(W * 0.06);
    ctx.strokeStyle = GOLD_LINE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(padX, yTop);
    ctx.lineTo(W - padX, yTop);
    ctx.stroke();

    var cy = yTop + 32;
    var fitchefImg = null;
    try {
      fitchefImg = await loadImage(absAsset('img/Fitchef logo.png'));
    } catch (e) {
      /* text-only */
    }
    if (fitchefImg && fitchefImg.naturalWidth) {
      var lh = maxLogoH;
      var lw = (fitchefImg.naturalWidth / fitchefImg.naturalHeight) * lh;
      ctx.drawImage(fitchefImg, (W - lw) / 2, cy, lw, lh);
      cy += lh + 14;
    } else {
      cy += 4;
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = GOLD;
    ctx.font = '600 ' + fsCo + 'px "Outfit", system-ui, sans-serif';
    ctx.fillText('Co-Powered by FitChef Nutrition', W / 2, cy);
    cy += Math.round(fsCo * 1.55);
    ctx.font = '500 ' + fsUrl + 'px "Outfit", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(212,185,104,0.95)';
    ctx.fillText('www.Fitchef.fit', W / 2, cy);
    cy += Math.round(fsUrl * 1.55);
    ctx.font = '700 ' + fsHost + 'px "Outfit", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(200, 164, 78, 0.78)';
    ctx.fillText(shareBrandHost(), W / 2, cy);
  }

  function drawTaglineStrip(ctx, W, x0, y, wInner, fsItalic, subtleGlow) {
    var line = 'Data-led coaching · Lifestyle management · Results that compound';
    var cx = x0 + wInner / 2;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = "italic 600 " + fsItalic + "px 'Playfair Display', Georgia, serif";
    var blur = subtleGlow
      ? Math.max(5, Math.round(fsItalic * 0.2))
      : Math.max(12, Math.round(fsItalic * 0.45));
    ctx.shadowColor = subtleGlow ? 'rgba(212, 175, 100, 0.5)' : 'rgba(212, 175, 100, 0.85)';
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = '#f2e6c4';
    ctx.fillText(line, cx, y);
    ctx.shadowBlur = 0;
    ctx.fillStyle = GOLD;
    ctx.fillText(line, cx, y);
    ctx.restore();
  }

  /** Layout height for 16:9 tagline (Playfair metrics + slack so the block never touches the bar). */
  function tagline169BlockHeight(fs) {
    var lineGap = Math.round(fs * 0.36);
    return (
      Math.round(fs * 1.05) +
      Math.round(fs * 1.28) +
      lineGap +
      Math.round(fs * 0.58) +
      24
    );
  }

  function pickTagline169Fs(ctx, wInner) {
    var lines = ['Data-led coaching · Lifestyle management', 'Results that compound'];
    var maxW = Math.max(200, wInner - 56);
    var fs;
    var i;
    for (fs = 26; fs >= 17; fs--) {
      ctx.font = "italic 600 " + fs + "px 'Playfair Display', Georgia, serif";
      var ok = true;
      for (i = 0; i < lines.length; i++) {
        if (ctx.measureText(lines[i]).width > maxW) {
          ok = false;
          break;
        }
      }
      if (ok) return fs;
    }
    return 17;
  }

  function drawTagline169Block(ctx, x0, yTop, wInner, fs) {
    var lines = ['Data-led coaching · Lifestyle management', 'Results that compound'];
    var cx = x0 + wInner / 2;
    var lineGap = Math.round(fs * 0.36);
    var y = yTop + Math.round(fs * 1.02);
    var i;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (i = 0; i < lines.length; i++) {
      ctx.font = "italic 600 " + fs + "px 'Playfair Display', Georgia, serif";
      ctx.shadowBlur = 0;
      ctx.fillStyle = GOLD;
      ctx.fillText(lines[i], cx, y);
      if (i === 0) y += Math.round(fs * 1.28) + lineGap;
    }
    ctx.restore();
  }

  async function drawScorecard169(canvas, d) {
    var W = DIM['16:9'].w;
    var H = DIM['16:9'].h;
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    canvas.width = W;
    canvas.height = H;
    await ensureLuxuryFonts();

    drawBackdropLuxury(ctx, W, H);

    var footerH = 198;
    var margin = 8;
    var cardX = margin;
    var cardY = margin;
    var cardW = W - margin * 2;
    var cardH = H - margin - footerH;
    drawLuxuryCardPanel(ctx, cardX, cardY, cardW, cardH, 12);

    var padX = 28;
    var px = cardX + padX;
    var py = cardY + 22;
    var innerW = cardW - padX * 2;

    var logoH = 112;
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
    ctx.font = '700 58px "Outfit", system-ui, sans-serif';
    ctx.fillText(memberName, cardX + cardW - padX, py + 54);
    ctx.fillStyle = GOLD_SOFT;
    ctx.font = '800 19px "Outfit", system-ui, sans-serif';
    ctx.letterSpacing = '0.24em';
    ctx.fillText('TRIBE ELITE MEMBER', cardX + cardW - padX, py + 100);
    ctx.letterSpacing = '0';

    var S = computeScoreData(d);
    var yHero = py + logoH + 8;
    var wLeft = Math.floor(innerW * 0.29);
    wLeft = Math.max(360, Math.min(540, wLeft));
    var xLeft = px;
    var colGap = 36;
    var xRight = px + wLeft + colGap;
    var wRight = innerW - wLeft - colGap;

    var rcx = xLeft + wLeft / 2;
    var maxRing = Math.min(190, Math.floor((wLeft - 8) / 2));
    var ringR = maxRing;
    var minPillarH = 176;
    var gapPillarBar = 32;
    var barH = 44;
    var gapBarTagline = 56;
    var pillarBottom = cardY + cardH - 14;
    var taglineFsLayout = pickTagline169Fs(ctx, innerW);
    var rcy;
    var ringBottom;
    var heroBottom;
    var pillarY;
    var barY;
    var taglineTop;
    var planOk;
    var tries;

    for (tries = 0; tries < 48; tries++) {
      rcy = yHero + ringR + 2;
      ringBottom = rcy + ringR + 6;
      heroBottom = Math.max(ringBottom, S.trendText ? yHero + 300 : yHero + 222);
      pillarY = pillarBottom - minPillarH;
      barY = pillarY - gapPillarBar - barH;
      taglineTop = barY - gapBarTagline - tagline169BlockHeight(taglineFsLayout);
      planOk = heroBottom <= taglineTop - 10;
      if (planOk) break;
      if (ringR > 112) ringR -= 5;
      else if (taglineFsLayout > 17) taglineFsLayout -= 1;
      else if (minPillarH > 136) minPillarH -= 4;
      else break;
    }
    if (!planOk) {
      while (pillarY > cardY + 380 && heroBottom > taglineTop - 6) {
        minPillarH = Math.max(128, minPillarH - 5);
        pillarY = pillarBottom - minPillarH;
        barY = pillarY - gapPillarBar - barH;
        taglineTop = barY - gapBarTagline - tagline169BlockHeight(taglineFsLayout);
      }
    }

    drawLuxuryRing(ctx, rcx, rcy, ringR, String(S.total), 5, true);

    ctx.textAlign = 'left';
    ctx.fillStyle = GOLD;
    ctx.font = '800 22px "Outfit", system-ui, sans-serif';
    ctx.letterSpacing = '0.22em';
    ctx.fillText('WEEKLY PERFORMANCE INDEX', xRight, yHero + 44);
    ctx.letterSpacing = '0';

    ctx.font = "italic 600 56px 'Cormorant Garamond', 'Playfair Display', Georgia, serif";
    ctx.fillStyle = CREAM;
    ctx.fillText(S.weekLabel, xRight, yHero + 124);

    ctx.font = "400 80px 'Bebas Neue', Impact, sans-serif";
    ctx.fillStyle = MUTED;
    ctx.fillText('BODYBANK SCORE', xRight, yHero + 210);

    if (S.trendText) {
      ctx.font = '700 36px "Outfit", system-ui, sans-serif';
      ctx.fillStyle = S.trendUp ? GREEN : S.trendDown ? RED : MUTED;
      ctx.fillText(S.trendText, xRight, yHero + 278);
    }

    drawTagline169Block(ctx, px, taglineTop, innerW, taglineFsLayout);
    drawWeightedBar(ctx, S.keys, S.norm, S.pillars, px, barY, innerW, barH, 6);

    var pillarH = Math.max(128, pillarBottom - pillarY);
    var gapC = 14;
    var cardWi = (innerW - gapC * 3) / 4;
    S.keys.forEach(function (k, i) {
      drawPillarStatementCard(ctx, k, i, S.keys, S.norm, S.pillars, S.labels, px + i * (cardWi + gapC), pillarY, cardWi, pillarH, 17, 92, 32);
    });

    drawCornerOrnaments(ctx, cardX + 8, cardY + 8, cardW - 16, cardH - 16, 40, 2);

    await drawFitchefFooter(ctx, W, H, cardY + cardH + 6, 46, 26, 23, 20);
  }

  async function drawScorecard916(canvas, d) {
    var W = DIM['9:16'].w;
    var H = DIM['9:16'].h;
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    canvas.width = W;
    canvas.height = H;
    await ensureLuxuryFonts();

    drawBackdropLuxury(ctx, W, H);

    var footerH = 248;
    var margin = 18;
    var cardX = margin;
    var cardY = margin;
    var cardW = W - margin * 2;
    var cardH = H - margin - footerH;
    drawLuxuryCardPanel(ctx, cardX, cardY, cardW, cardH, 12);

    var px = cardX + 22;
    var py = cardY + 18;
    var innerW = cardW - 44;
    var logoH = 100;

    try {
      var logo2 = await loadImage(absAsset('img/logo.png'));
      var lh2 = logoH;
      var lw2 = (logo2.naturalWidth / logo2.naturalHeight) * lh2;
      ctx.drawImage(logo2, px, py, lw2, lh2);
    } catch (e2) {
      /* skip */
    }

    var memberName = memberDisplayName(d);
    ctx.textAlign = 'right';
    ctx.fillStyle = GOLD;
    ctx.font = '700 44px "Outfit", system-ui, sans-serif';
    ctx.fillText(memberName, cardX + cardW - 22, py + 46);
    ctx.fillStyle = GOLD_SOFT;
    ctx.font = '800 16px "Outfit", system-ui, sans-serif';
    ctx.letterSpacing = '0.26em';
    ctx.fillText('TRIBE ELITE MEMBER', cardX + cardW - 22, py + 88);
    ctx.letterSpacing = '0';
    ctx.textAlign = 'left';

    var S = computeScoreData(d);
    var y1 = py + logoH + 10;

    ctx.textAlign = 'center';
    ctx.fillStyle = GOLD;
    ctx.font = '800 18px "Outfit", system-ui, sans-serif';
    ctx.letterSpacing = '0.28em';
    ctx.fillText('WEEKLY PERFORMANCE INDEX', px + innerW / 2, y1 + 26);
    ctx.letterSpacing = '0';

    ctx.font = "italic 600 42px 'Cormorant Garamond', 'Playfair Display', Georgia, serif";
    ctx.fillStyle = CREAM;
    ctx.fillText(S.weekLabel, px + innerW / 2, y1 + 88);

    var ringR = 148;
    var rcx = px + innerW / 2;
    var rcy = y1 + 132 + ringR;
    drawLuxuryRing(ctx, rcx, rcy, ringR, String(S.total), 5);

    var ringBottom = rcy + ringR + 12;
    ctx.font = "400 58px 'Bebas Neue', Impact, sans-serif";
    ctx.fillStyle = MUTED;
    ctx.fillText('BODYBANK SCORE', rcx, ringBottom + 78);

    var barY = ringBottom + 108;
    if (S.trendText) {
      ctx.font = '700 30px "Outfit", system-ui, sans-serif';
      ctx.fillStyle = S.trendUp ? GREEN : S.trendDown ? RED : MUTED;
      ctx.fillText(S.trendText, rcx, ringBottom + 148);
      barY = ringBottom + 186;
    }

    var barH = 48;
    drawWeightedBar(ctx, S.keys, S.norm, S.pillars, px, barY, innerW, barH, 6);

    var taglineFs916 = pickTagline169Fs(ctx, innerW);
    var gapBarTag = 26;
    var taglineTop = barY + barH + gapBarTag;
    var taglineH = tagline169BlockHeight(taglineFs916);
    drawTagline169Block(ctx, px, taglineTop, innerW, taglineFs916);

    var pillarY = taglineTop + taglineH + 26;
    var gapC = 12;
    var colW = (innerW - gapC) / 2;
    var row1H = Math.floor((cardY + cardH - pillarY - gapC - 18) / 2);
    var row2Y = pillarY + row1H + gapC;
    S.keys.forEach(function (k, i) {
      var col = i % 2;
      var row = Math.floor(i / 2);
      var bx = px + col * (colW + gapC);
      var by = row === 0 ? pillarY : row2Y;
      drawPillarStatementCard(ctx, k, i, S.keys, S.norm, S.pillars, S.labels, bx, by, colW, row1H, 14, 108, 22);
    });

    drawCornerOrnaments(ctx, cardX + 8, cardY + 8, cardW - 16, cardH - 16, 34, 2);

    ctx.textAlign = 'left';
    await drawFitchefFooter(ctx, W, H, cardY + cardH + 6, 54, 26, 24, 21);
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

  function blobToDataUrl(blob) {
    return new Promise(function (resolve) {
      if (!blob) return resolve('');
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { resolve(''); };
      fr.readAsDataURL(blob);
    });
  }

  async function shareScorecardToBodybankFeed(blob, aspect) {
    var dataUrl = await blobToDataUrl(blob);
    if (!dataUrl) throw new Error('Could not prepare image for feed upload.');
    var username = '';
    if (typeof window.bbResolveFeedPostingName === 'function') {
      username = await window.bbResolveFeedPostingName({ promptIfMissing: true });
    }
    if (!username && typeof window.bbCurrentFeedUsername === 'function') {
      username = window.bbCurrentFeedUsername();
    }
    if (!username) throw new Error('Set nickname first to share on BodyBank Feed.');
    var d = window._bbScorecardCache || {};
    var caption = 'My weekly BodyBank scorecard (' + (aspect === '9:16' ? 'Story' : 'Feed') + '). ' +
      String(d.week_label || '').trim();
    var resp = await fetch('/api/feed/upload', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageData: dataUrl, caption: caption.trim(), username: username })
    });
    var res = await resp.json().catch(function () { return {}; });
    if (!resp.ok) throw new Error(res.error || 'Feed share failed.');
    if (typeof window.showPopup === 'function') {
      window.showPopup('Shared', 'Your scorecard was shared to BodyBank Feed.', '', 'OK', null, 'success');
    }
    if (typeof window.loadUserEliteFeedGrid === 'function') window.loadUserEliteFeedGrid();
    if (typeof window.loadAdminEliteFeedGrid === 'function') window.loadAdminEliteFeedGrid();
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
    var toFeed = document.getElementById('bbScoreShareToFeed');
    if (toFeed) {
      toFeed.onclick = async function () {
        toFeed.disabled = true;
        var old = toFeed.textContent;
        toFeed.textContent = 'Sharing…';
        try {
          await shareScorecardToBodybankFeed(blob, aspect);
          closeScorecardShareModal();
        } catch (err) {
          if (typeof showPopup === 'function') {
            showPopup('Share', err && err.message ? err.message : 'Could not share to BodyBank Feed.', '', 'OK', null, 'error');
          }
        } finally {
          toFeed.disabled = false;
          toFeed.textContent = old;
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
