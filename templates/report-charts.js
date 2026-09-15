/* global Chart */
/**
 * BodyBank Reports — chart builders. Runs INSIDE headless Chrome (services/reportCharts.js
 * loads Chart.js, then this file, then calls BBReportCharts.renderAll(specs)).
 *
 * Every chart is drawn at the exact CSS size of its slot in the A4 template and
 * exported at 3x device pixels (≈288 dpi on paper), so tick labels stay legible
 * in print. Titles and captions are NOT drawn here — they are vector text in the
 * HTML template; the canvas carries the plot, axes, axis titles and legend only.
 *
 * Mark specs (dataviz method): 2px lines, >=8px end markers with a 2px surface
 * ring, bars <=18px with a 4px rounded data end and square baseline, a 2px
 * surface gap between stacked segments, hairline solid gridlines, one y-axis.
 */
(function () {
  'use strict';

  var INK = '#1d1c1a';
  var TEXT2 = '#57554f';
  var MUTED = '#8a877f';
  var GRID = '#ebe7de';
  var SURFACE = '#ffffff';
  var FONT = "'Inter', 'Helvetica Neue', Arial, sans-serif";
  var DPR = 3;

  Chart.defaults.font.family = FONT;
  Chart.defaults.font.size = 10;
  Chart.defaults.color = TEXT2;
  Chart.defaults.animation = false;
  Chart.defaults.responsive = false;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.devicePixelRatio = DPR;

  function hexA(hex, a) {
    var h = String(hex || '#000000').replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function fmt(v, dec) {
    if (v == null || !isFinite(v)) return '';
    var d = dec == null ? (Math.abs(v) < 10 && v % 1 ? 1 : 0) : dec;
    return Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  // -------------------------------------------------------------------------
  // Plugins: reference band + lines, value labels, end labels
  // -------------------------------------------------------------------------

  var refPlugin = {
    id: 'bbRefs',
    beforeDatasetsDraw: function (chart, _args, o) {
      if (!o) return;
      var ctx = chart.ctx; var area = chart.chartArea;
      var yScale = chart.scales.y; var xScale = chart.scales.x;
      var horizontal = chart.options.indexAxis === 'y';
      ctx.save();
      (o.bands || []).forEach(function (b) {
        if (horizontal) return;
        var y1 = b.high == null ? area.top : yScale.getPixelForValue(b.high);
        var y2 = b.low == null ? area.bottom : yScale.getPixelForValue(b.low);
        var top = Math.max(area.top, Math.min(y1, y2));
        var bottom = Math.min(area.bottom, Math.max(y1, y2));
        if (bottom <= top) return;
        ctx.fillStyle = hexA(b.color || '#16a34a', b.alpha == null ? 0.10 : b.alpha);
        ctx.fillRect(area.left, top, area.right - area.left, bottom - top);
      });
      (o.lines || []).forEach(function (l) {
        if (l.value == null) return;
        ctx.strokeStyle = l.color || MUTED;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([]);
        ctx.beginPath();
        if (horizontal) {
          var x = xScale.getPixelForValue(l.value);
          ctx.moveTo(x, area.top); ctx.lineTo(x, area.bottom);
        } else {
          var y = yScale.getPixelForValue(l.value);
          if (y < area.top - 1 || y > area.bottom + 1) return;
          ctx.moveTo(area.left, y); ctx.lineTo(area.right, y);
        }
        ctx.stroke();
      });
      ctx.restore();
    },
    afterDatasetsDraw: function (chart, _args, o) {
      if (!o || !o.lines) return;
      var ctx = chart.ctx; var area = chart.chartArea; var yScale = chart.scales.y;
      if (chart.options.indexAxis === 'y') return;
      ctx.save();
      ctx.font = '600 9px ' + FONT;
      ctx.textBaseline = 'bottom';
      o.lines.forEach(function (l) {
        if (l.value == null || !l.label) return;
        var y = yScale.getPixelForValue(l.value);
        if (y < area.top - 1 || y > area.bottom + 1) return;
        var w = ctx.measureText(l.label).width;
        var x = area.right - w - 4;
        var ty = y - 2 < area.top + 10 ? y + 12 : y - 2;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(x - 2, ty - 10, w + 4, 11);
        ctx.fillStyle = TEXT2;
        ctx.fillText(l.label, x, ty);
      });
      ctx.restore();
    }
  };

  var labelPlugin = {
    id: 'bbLabels',
    afterDatasetsDraw: function (chart, _args, o) {
      if (!o || !o.mode) return;
      var ctx = chart.ctx;
      ctx.save();
      ctx.font = '600 9px ' + FONT;
      ctx.fillStyle = INK;
      var horizontal = chart.options.indexAxis === 'y';
      if (o.mode === 'barEnd') {
        var metaIdx = o.datasetIndex == null ? chart.data.datasets.length - 1 : o.datasetIndex;
        var meta = chart.getDatasetMeta(metaIdx);
        var ds = chart.data.datasets[metaIdx];
        meta.data.forEach(function (el, i) {
          var v = o.totals ? o.totals[i] : ds.data[i];
          if (v == null || (!o.showZero && v === 0)) return;
          var text = (o.prefixSign && v > 0 ? '+' : '') + fmt(v, o.decimals) + (o.suffix || '');
          var w = ctx.measureText(text).width;
          if (horizontal) {
            ctx.textBaseline = 'middle';
            var right = v >= 0;
            var x = right ? el.x + 4 : el.x - 4 - w;
            x = Math.max(chart.chartArea.left + 2, Math.min(x, chart.chartArea.right - w - 2));
            ctx.fillText(text, x, el.y);
          } else {
            ctx.textBaseline = 'bottom';
            var y = Math.max(chart.chartArea.top + 10, el.y - 3);
            ctx.fillText(text, el.x - w / 2, y);
          }
        });
      }
      if (o.mode === 'lineEnd') {
        chart.data.datasets.forEach(function (ds, di) {
          if (ds.bbNoEndLabel) return;
          var meta = chart.getDatasetMeta(di);
          var last = -1;
          for (var i = ds.data.length - 1; i >= 0; i -= 1) { if (ds.data[i] != null) { last = i; break; } }
          if (last < 0) return;
          var el = meta.data[last];
          var text = fmt(ds.data[last], o.decimals) + (o.suffix || '');
          var w = ctx.measureText(text).width;
          ctx.textBaseline = 'bottom';
          var x = Math.min(el.x - w / 2, chart.chartArea.right - w);
          x = Math.max(x, chart.chartArea.left);
          var y = el.y - 7 < chart.chartArea.top + 10 ? el.y + 17 : el.y - 7;
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.fillRect(x - 2, y - 10, w + 4, 11);
          ctx.fillStyle = INK;
          ctx.fillText(text, x, y);
        });
      }
      ctx.restore();
    }
  };

  Chart.register(refPlugin, labelPlugin);

  // -------------------------------------------------------------------------
  // Common option blocks
  // -------------------------------------------------------------------------

  function axisTitle(text) {
    return { display: !!text, text: text || '', color: MUTED, font: { size: 9, weight: '600' }, padding: { top: 2, bottom: 2 } };
  }
  function scales(d, stacked) {
    var y = {
      stacked: !!stacked,
      beginAtZero: d.yBeginAtZero !== false,
      grid: { color: GRID, lineWidth: 1, drawTicks: false },
      border: { display: false },
      ticks: { padding: 6, maxTicksLimit: d.yTicks || 5, color: TEXT2, callback: function (v) { return fmt(v, d.yDecimals == null ? (Math.abs(v) < 10 && v % 1 ? 1 : 0) : d.yDecimals); } },
      title: axisTitle(d.yTitle)
    };
    if (d.yMin != null) y.min = d.yMin;
    if (d.yMax != null) y.max = d.yMax;
    if (d.ySuggestedMax != null) y.suggestedMax = d.ySuggestedMax;
    if (d.ySuggestedMin != null) y.suggestedMin = d.ySuggestedMin;
    var x = {
      stacked: !!stacked,
      grid: { display: false },
      border: { color: GRID },
      ticks: { color: TEXT2, maxRotation: 0, autoSkip: true, autoSkipPadding: 6, padding: 4, maxTicksLimit: d.xTicks || 14 },
      title: axisTitle(d.xTitle)
    };
    return { x: x, y: y };
  }
  function legend(show) {
    return {
      display: !!show,
      position: 'top',
      align: 'end',
      labels: {
        boxWidth: 10, boxHeight: 8, usePointStyle: true, padding: 10, color: TEXT2, font: { size: 9, weight: '600' },
        // Bars/areas show a rounded swatch; reference lines show a line key.
        generateLabels: function (chart) {
          // Doughnuts label their slices, not datasets: keep Chart.js's own labels.
          if (chart.config.type === 'doughnut') return Chart.overrides.doughnut.plugins.legend.labels.generateLabels(chart);
          var items = Chart.defaults.plugins.legend.labels.generateLabels(chart);
          items.forEach(function (it) {
            var ds = chart.data.datasets[it.datasetIndex] || {};
            it.pointStyle = ds.pointStyle === 'line' ? 'line' : 'rectRounded';
            if (ds.pointStyle === 'line') { it.lineWidth = 2; it.strokeStyle = ds.borderColor; }
            it.fillStyle = Array.isArray(ds.backgroundColor) ? ds.backgroundColor[0] : (ds.type === 'line' || chart.config.type === 'line' ? ds.borderColor : ds.backgroundColor);
          });
          return items;
        }
      }
    };
  }
  var LAYOUT = { padding: { top: 4, right: 8, bottom: 2, left: 2 } };

  // -------------------------------------------------------------------------
  // Builders
  // -------------------------------------------------------------------------

  function gauge(d) {
    var v = Math.max(0, Math.min(100, Number(d.value) || 0));
    return {
      type: 'doughnut',
      data: { datasets: [{ data: [v, 100 - v], backgroundColor: [d.color, d.track || '#efece5'], borderWidth: 0, borderRadius: v > 0 && v < 100 ? [8, 0] : 0 }] },
      options: {
        rotation: -120, circumference: 240, cutout: d.cutout || '80%',
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        layout: { padding: 2 }
      }
    };
  }

  function donut(d) {
    var parts = d.parts || [];
    return {
      type: 'doughnut',
      data: {
        labels: parts.map(function (p) { return p.label; }),
        datasets: [{ data: parts.map(function (p) { return p.value; }), backgroundColor: parts.map(function (p) { return p.color; }), borderColor: SURFACE, borderWidth: 2 }]
      },
      options: {
        cutout: '72%',
        plugins: { legend: legend(parts.length > 1 && d.legend !== false), tooltip: { enabled: false } },
        layout: { padding: 4 }
      }
    };
  }

  function bars(d) {
    var stacked = !!d.stacked;
    var n = d.datasets.length;
    var datasets = d.datasets.map(function (ds, i) {
      if (ds.type === 'line') {
        // A reference line (target) drawn across the bars; named in the legend.
        return {
          type: 'line', label: ds.label, data: ds.data, borderColor: ds.color, backgroundColor: ds.color,
          borderWidth: 1.5, pointRadius: 0, pointStyle: 'line', tension: 0, order: -1, spanGaps: true
        };
      }
      var topOfStack = !stacked || i === lastBarIndex(d.datasets);
      return {
        type: 'bar', label: ds.label, data: ds.data,
        backgroundColor: ds.colors || ds.color,
        borderColor: SURFACE,
        borderWidth: stacked ? { top: i === 0 ? 0 : 2, bottom: 0, left: 0, right: 0 } : 0,
        borderSkipped: stacked ? false : 'start',
        borderRadius: topOfStack ? { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 } : 0,
        maxBarThickness: d.barMax || (n > 1 && !stacked ? 12 : 18),
        categoryPercentage: d.categoryPercentage || 0.72,
        barPercentage: d.barPercentage || 0.86,
        stack: stacked ? 's' : undefined
      };
    });
    var legendShow = d.legend != null ? d.legend : d.datasets.filter(function (x) { return x.label; }).length > 1;
    return {
      type: 'bar',
      data: { labels: d.labels, datasets: datasets },
      options: {
        layout: LAYOUT,
        scales: scales(d, stacked),
        plugins: {
          legend: legend(legendShow), tooltip: { enabled: false },
          bbRefs: { lines: d.refLines || [], bands: d.bands || [] },
          bbLabels: d.valueLabels ? { mode: 'barEnd', totals: d.totals || null, suffix: d.valueSuffix || '', decimals: d.valueDecimals, datasetIndex: d.valueDataset } : {}
        }
      }
    };
  }
  function lastBarIndex(dsList) {
    var idx = -1;
    dsList.forEach(function (ds, i) { if (ds.type !== 'line') idx = i; });
    return idx;
  }

  function lines(d) {
    var datasets = d.datasets.map(function (ds) {
      if (ds.ref) {
        // Reference line (target / previous average): thin, flat, legend-named, no end label.
        return {
          label: ds.label, data: ds.data, borderColor: ds.color, backgroundColor: ds.color,
          borderWidth: 1.5, pointRadius: 0, pointStyle: 'line', fill: false, tension: 0,
          spanGaps: true, order: 5, bbNoEndLabel: true
        };
      }
      var n = ds.data.length;
      var lastIdx = -1;
      for (var i = n - 1; i >= 0; i -= 1) { if (ds.data[i] != null) { lastIdx = i; break; } }
      var radius = ds.data.map(function (v, i) {
        if (v == null) return 0;
        if (ds.points === 'all') return 3.2;
        return i === lastIdx ? 4 : 0;
      });
      return {
        label: ds.label, data: ds.data, order: 1,
        borderColor: ds.color, backgroundColor: ds.fill ? hexA(ds.color, 0.10) : ds.color,
        fill: ds.fill ? 'origin' : false,
        showLine: ds.showLine !== false,
        borderWidth: ds.width || 2,
        borderCapStyle: 'round', borderJoinStyle: 'round',
        pointRadius: radius, pointHoverRadius: 0,
        pointBackgroundColor: ds.color, pointBorderColor: SURFACE, pointBorderWidth: 2,
        cubicInterpolationMode: 'monotone', tension: 0.3,
        spanGaps: ds.spanGaps !== false,
        bbNoEndLabel: !!ds.noEndLabel
      };
    });
    var legendShow = d.legend != null ? d.legend : d.datasets.filter(function (x) { return x.label; }).length > 1;
    return {
      type: 'line',
      data: { labels: d.labels, datasets: datasets },
      options: {
        layout: LAYOUT,
        scales: scales(d, false),
        plugins: {
          legend: legend(legendShow), tooltip: { enabled: false },
          bbRefs: { lines: d.refLines || [], bands: d.bands || [] },
          bbLabels: d.endLabels === false ? {} : { mode: 'lineEnd', suffix: d.valueSuffix || '', decimals: d.valueDecimals }
        }
      }
    };
  }

  function hbars(d) {
    var cfg = bars(Object.assign({}, d, { stacked: false }));
    cfg.options.indexAxis = 'y';
    var ds = cfg.data.datasets[0];
    ds.borderRadius = 4;
    ds.borderSkipped = false;
    ds.maxBarThickness = 14;
    var sc = cfg.options.scales;
    var x = sc.y; var y = sc.x;
    x.beginAtZero = true;
    x.grid = { color: GRID, lineWidth: 1, drawTicks: false };
    x.title = axisTitle(d.xTitle);
    y.grid = { display: false };
    y.title = axisTitle(d.yTitle);
    y.ticks = { color: INK, font: { size: 10, weight: '600' }, padding: 6, autoSkip: false };
    cfg.options.scales = { x: x, y: y };
    if (d.xMin != null) x.min = d.xMin;
    if (d.xMax != null) x.max = d.xMax;
    cfg.options.plugins.bbLabels = { mode: 'barEnd', suffix: d.valueSuffix || '', decimals: d.valueDecimals == null ? 1 : d.valueDecimals, prefixSign: true, showZero: true };
    cfg.options.plugins.bbRefs = { lines: [{ value: 0, color: '#bdb8ac' }] };
    return cfg;
  }

  var BUILDERS = { gauge: gauge, donut: donut, bars: bars, lines: lines, hbars: hbars };

  function renderOne(spec) {
    var canvas = document.createElement('canvas');
    canvas.style.width = spec.w + 'px';
    canvas.style.height = spec.h + 'px';
    canvas.width = Math.round(spec.w * DPR);
    canvas.height = Math.round(spec.h * DPR);
    document.body.appendChild(canvas);
    var build = BUILDERS[spec.kind];
    if (!build) throw new Error('Unknown chart kind: ' + spec.kind);
    var cfg = build(spec.data || {});
    cfg.options = cfg.options || {};
    cfg.options.devicePixelRatio = DPR;
    var chart = new Chart(canvas.getContext('2d'), cfg);
    chart.resize(spec.w, spec.h);
    chart.draw();
    var url = canvas.toDataURL('image/png');
    chart.destroy();
    canvas.remove();
    return url;
  }

  /** Downscale a photo to fit maxW x maxH (JPEG) so PDFs stay small. */
  function downscale(src, maxW, maxH) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var s = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * s));
        c.height = Math.max(1, Math.round(img.naturalHeight * s));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.86));
      };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }

  window.BBReportCharts = {
    renderAll: async function (specs, photos) {
      if (document.fonts && document.fonts.load) {
        try { await Promise.all([document.fonts.load('400 10px Inter'), document.fonts.load('600 10px Inter')]); } catch (_) { /* fall back to system sans */ }
      }
      var out = {}; var errors = {};
      (specs || []).forEach(function (s) {
        try { out[s.id] = renderOne(s); } catch (e) { errors[s.id] = String(e && e.message || e); }
      });
      var ph = {};
      for (var i = 0; i < (photos || []).length; i += 1) {
        var p = photos[i];
        ph[p.id] = await downscale(p.src, p.maxW || 900, p.maxH || 1200);
      }
      return { images: out, photos: ph, errors: errors };
    }
  };
})();
