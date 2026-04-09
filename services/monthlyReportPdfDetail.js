'use strict';

/** Paginated luxury appendix for monthly PDF — every field + pros/cons blocks. */

const C = {
  pageBg: '#E8ECF4',
  bg: '#07070A',
  panel: '#FFFFFF',
  panelSoft: '#E2E6EF',
  gold: '#D4AF37',
  goldMid: '#B8922E',
  goldDark: '#7A6220',
  text: '#0E1118',
  muted: '#5A6278',
  violet: '#6B4FC9',
  emerald: '#0D7A5F',
  danger: '#B03A32',
  grid: '#D0D6E4'
};

function F(doc, role) {
  const custom = doc._bbCustomFonts === true;
  if (!custom) {
    if (role === 'display' || role === 'semi') return 'Helvetica-Bold';
    return 'Helvetica';
  }
  if (role === 'display') return 'BBDisplay';
  if (role === 'semi') return 'BBSemi';
  return 'BBBody';
}

function num(v, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function formatDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatVal(v, maxLen = 2400) {
  if (v == null) return '—';
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v, null, 0);
      return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
    } catch (_) {
      return String(v);
    }
  }
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

function drawWatermark(doc) {
  doc.save();
  doc.opacity(0.035);
  doc.fillColor(C.gold);
  doc.font(F(doc, 'display')).fontSize(56);
  for (let i = 0; i < 4; i += 1) {
    doc.save();
    doc.rotate(-28, { origin: [120 + i * 160, 200 + i * 120] });
    doc.text('CONFIDENTIAL', 40 + i * 40, 100 + i * 180);
    doc.restore();
  }
  doc.opacity(1);
  doc.restore();
}

function sectionTitle(doc, text, y, contentW, margin) {
  doc.roundedRect(margin, y, contentW, 22, 5).fillAndStroke(C.panelSoft, '#BFC8D8');
  doc.fillColor(C.goldDark).font(F(doc, 'semi')).fontSize(8.5).text(text.toUpperCase(), margin + 10, y + 7);
}

function pageTextBottom(doc, margin) {
  return doc.page.height - margin - 22;
}

function measureBulletsHeight(doc, items, width, fontSize = 8) {
  const list = Array.isArray(items) ? items.map((v) => String(v || '').trim()).filter(Boolean) : [];
  if (!list.length) return 14;
  doc.font(F(doc, 'body')).fontSize(fontSize);
  let h = 0;
  list.forEach((item) => {
    h += doc.heightOfString(item, { width: width - 10, lineGap: 2 }) + 4;
  });
  return h;
}

/**
 * PDFKit auto-inserts pages when wrapped text exceeds the page bottom. We split manually and use
 * the paginator so logical y stays in sync (avoids blank “ghost” pages).
 */
function drawWrappedTextPaginated(doc, text, x, y, width, paginator, margin, fontSize, lineGap, color = C.text) {
  let rest = String(text || '');
  let curY = y;
  doc.font(F(doc, 'body')).fontSize(fontSize);
  doc.fillColor(color);
  while (rest.length) {
    rest = rest.replace(/^\s+/, '');
    if (!rest.length) break;
    let bottom = pageTextBottom(doc, margin);
    let maxH = bottom - curY - 2;
    if (maxH < 12) {
      curY = paginator.ensure(curY, 28);
      continue;
    }
    let lo = 1;
    let hi = rest.length;
    let best = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const h = doc.heightOfString(rest.slice(0, mid), { width, lineGap });
      if (h <= maxH) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best < 1) best = 1;
    let rawEnd = best;
    if (best < rest.length) {
      const sp = rest.slice(0, best).lastIndexOf(' ');
      if (sp > 8) rawEnd = sp;
    }
    const chunk = rest.slice(0, rawEnd).trimEnd();
    const piece = chunk.length ? chunk : rest.slice(0, 1);
    doc.text(piece, x, curY, { width, lineGap });
    rest = rest.slice(rawEnd).replace(/^\s+/, '');
    const h = doc.heightOfString(piece, { width, lineGap });
    curY += h + (rest.length ? 4 : 0);
  }
  return curY;
}

function addBulletList(doc, items, x, y, width, color, fontSize = 9, paginator = null, margin = 36) {
  const list = Array.isArray(items) ? items.map((v) => String(v || '').trim()).filter(Boolean) : [];
  let curY = y;
  if (!list.length) {
    doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(fontSize).text('—', x, curY, { width });
    return curY + 14;
  }
  const tw = width - 10;
  list.forEach((raw) => {
    let rest = raw;
    let showBullet = true;
    while (rest.length) {
      rest = rest.replace(/^\s+/, '');
      if (!rest.length) break;
      let bottom = pageTextBottom(doc, margin);
      let maxH = bottom - curY - 2;
      if (maxH < 14 && paginator) {
        curY = paginator.ensure(curY, 24);
        continue;
      }
      bottom = pageTextBottom(doc, margin);
      maxH = bottom - curY - 2;
      doc.font(F(doc, 'body')).fontSize(fontSize);
      let lo = 1;
      let hi = rest.length;
      let best = 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const h = doc.heightOfString(rest.slice(0, mid), { width: tw, lineGap: 2 });
        if (h <= maxH) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best < 1) best = 1;
      let rawEnd = best;
      if (best < rest.length) {
        const sp = rest.slice(0, best).lastIndexOf(' ');
        if (sp > 8) rawEnd = sp;
      }
      const chunk = rest.slice(0, rawEnd).trimEnd();
      const piece = chunk.length ? chunk : rest.slice(0, 1);
      if (showBullet) {
        doc.fillColor(C.goldMid).font(F(doc, 'semi')).fontSize(fontSize).text('•', x, curY);
      }
      doc.fillColor(color).font(F(doc, 'body')).fontSize(fontSize).text(piece, x + 10, curY, { width: tw, lineGap: 2 });
      rest = rest.slice(rawEnd).replace(/^\s+/, '');
      const h = doc.heightOfString(piece, { width: tw, lineGap: 2 });
      curY += h + 4;
      showBullet = false;
    }
  });
  return curY;
}

function createPaginator(doc, margin, contentW, docId) {
  let pageNum = 1;
  function drawFooter() {
    doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(7.2).text(
      `BODYBANK · Page ${pageNum} · ${docId} · CONFIDENTIAL`,
      margin,
      doc.page.height - margin - 8,
      { width: contentW, align: 'center' }
    );
  }
  const contentTop = margin + 58;
  function ensure(y, needH) {
    const bottom = doc.page.height - margin - 18;
    if (y + needH <= bottom) return y;
    /* Avoid chaining empty pages: if we're already at the top of a continuation page
       but the block is taller than one page, stay here and draw (may clip) rather than addPage again. */
    if (y <= contentTop + 8 && needH > bottom - contentTop - 10) {
      return y;
    }
    drawFooter();
    doc.addPage();
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(C.pageBg);
    drawWatermark(doc);
    doc.rect(0, 0, doc.page.width, 52).fill(C.bg);
    doc.rect(0, 50, doc.page.width, 2).fill(C.gold);
    doc.fillColor(C.goldMid).font(F(doc, 'semi')).fontSize(8).text('BODYBANK · MONTHLY DOSSIER · CONTINUED', margin, 18);
    pageNum += 1;
    doc.x = margin;
    doc.y = contentTop;
    return contentTop;
  }
  return { ensure, drawFooter, get pageNum() { return pageNum; } };
}

function drawProsConsBlock(doc, margin, y, contentW, title, block, paginator) {
  if (!block) return y;
  const pros = Array.isArray(block.pros) ? block.pros : [];
  const cons = Array.isArray(block.cons) ? block.cons : [];
  const note = String(block.note || '').trim();
  const pad = 12;
  const colGap = 10;
  const colW = (contentW - colGap) / 2 - pad;
  const prosH = pros.length ? measureBulletsHeight(doc, pros, colW, 7.4) : 14;
  const consH = cons.length ? measureBulletsHeight(doc, cons, colW, 7.4) : 14;
  doc.font(F(doc, 'body')).fontSize(7.4);
  const innerH = Math.max(prosH, consH);
  const boxH = 20 + innerH + 12;
  const noteHead = note ? Math.min(120, doc.heightOfString(note, { width: contentW - pad * 2, lineGap: 2 }) + 14) : 0;
  /* sectionTitle 22px + gap 28px + box; note flows below the box with paginated text (no PDFKit auto-pages) */
  y = paginator.ensure(y, 22 + 28 + boxH + 16 + noteHead);
  sectionTitle(doc, title, y, contentW, margin);
  y += 28;
  doc.roundedRect(margin, y, contentW, boxH, 8).fillAndStroke('#FFFCF7', '#E5D8C4');
  doc.fillColor(C.emerald).font(F(doc, 'semi')).fontSize(7.4).text('Strengths / signals', margin + pad, y + 8);
  doc.fillColor(C.danger).font(F(doc, 'semi')).fontSize(7.4).text('Gaps / risks', margin + pad + colW + colGap, y + 8);
  addBulletList(doc, pros, margin + pad, y + 18, colW, C.text, 7.4, paginator, margin);
  addBulletList(doc, cons, margin + pad + colW + colGap, y + 18, colW, C.text, 7.4, paginator, margin);
  let outY = y + boxH + 10;
  if (note) {
    outY = drawWrappedTextPaginated(doc, note, margin + pad, y + boxH + 6, contentW - pad * 2, paginator, margin, 7.3, 2, C.muted);
  }
  return outY + 12;
}

function renderKeyValueObject(doc, margin, y, contentW, obj, paginator) {
  const keys = Object.keys(obj || {}).filter((k) => k !== 'id');
  if (!keys.length) {
    y = paginator.ensure(y, 24);
    doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(8.5).text('No data on file.', margin, y, { width: contentW });
    return y + 20;
  }
  for (const k of keys) {
    const raw = obj[k];
    const label = k.replace(/_/g, ' ');
    const val = formatVal(raw, 3200);
    y = paginator.ensure(y, 36);
    doc.fillColor(C.goldDark).font(F(doc, 'semi')).fontSize(7.2).text(label, margin + 10, y + 4, { width: contentW - 20 });
    y = drawWrappedTextPaginated(doc, val, margin + 10, y + 16, contentW - 20, paginator, margin, 7.6, 2, C.text);
    y += 12;
  }
  return y;
}

function renderDailyTable(doc, margin, y, contentW, rows, paginator) {
  const header = ['Date', 'Steps', 'Water ml', 'Protein g', 'Sleep h'];
  y = paginator.ensure(y, 40);
  sectionTitle(doc, 'Daily check-ins — complete log (every row)', y, contentW, margin);
  y += 30;
  if (!rows.length) {
    doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(9).text('No daily check-ins this month.', margin, y, { width: contentW });
    return y + 20;
  }
  const cw = contentW / 5 - 4;
  const rowH0 = 14;
  y = paginator.ensure(y, rowH0 + 10);
  doc.fillColor(C.text).font(F(doc, 'semi')).fontSize(7);
  header.forEach((h, i) => doc.text(h, margin + i * (cw + 4), y, { width: cw }));
  y += rowH0;
  doc.moveTo(margin, y).lineTo(margin + contentW, y).strokeColor(C.grid).lineWidth(0.4).stroke();
  y += 6;
  rows.forEach((r) => {
    const line = [
      String(r.checkin_date || '—').slice(0, 12),
      r.steps != null ? String(r.steps) : '—',
      r.water_ml != null ? String(r.water_ml) : '—',
      r.protein_g != null ? String(r.protein_g) : '—',
      r.sleep_hours != null ? String(r.sleep_hours) : '—'
    ];
    const h = Math.max(13, doc.heightOfString(line.join(' '), { width: contentW - 8 }) / 2);
    y = paginator.ensure(y, h + 8);
    doc.fillColor(C.text).font(F(doc, 'body')).fontSize(7.2);
    line.forEach((cell, i) => doc.text(cell, margin + i * (cw + 4), y, { width: cw, lineGap: 1 }));
    y += h + 4;
  });
  return y + 8;
}

function renderProgressTable(doc, margin, y, contentW, rows, paginator) {
  y = paginator.ensure(y, 40);
  sectionTitle(doc, 'Progress logs — complete log (every field)', y, contentW, margin);
  y += 30;
  if (!rows.length) {
    doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(9).text('No progress_logs this month.', margin, y, { width: contentW });
    return y + 20;
  }
  rows.forEach((r, idx) => {
    const keys = Object.keys(r).filter((k) => !['user_id', 'id'].includes(k));
    doc.font(F(doc, 'body')).fontSize(7.2);
    let innerH = 20;
    keys.forEach((k) => {
      const val = formatVal(r[k], 1500);
      innerH += doc.heightOfString(val, { width: contentW - 140, lineGap: 1.5 }) + 5;
    });
    const blockH = innerH + 14;
    y = paginator.ensure(y, blockH + 12);
    doc.roundedRect(margin, y, contentW, blockH, 6).fillAndStroke('#F8FAFF', '#CCD6E8');
    doc.fillColor(C.goldDark).font(F(doc, 'semi')).fontSize(7.5).text(`Entry ${idx + 1}`, margin + 10, y + 6);
    let ly = y + 18;
    keys.forEach((k) => {
      const val = formatVal(r[k], 1500);
      doc.fillColor(C.muted).font(F(doc, 'semi')).fontSize(6.9).text(k.replace(/_/g, ' '), margin + 10, ly, { width: 120 });
      doc.fillColor(C.text).font(F(doc, 'body')).fontSize(7.2).text(val, margin + 128, ly, { width: contentW - 140, lineGap: 1.5 });
      ly += doc.heightOfString(val, { width: contentW - 140, lineGap: 1.5 }) + 4;
    });
    y += blockH + 8;
  });
  return y;
}

function renderSundayFull(doc, margin, y, contentW, rows, paginator) {
  y = paginator.ensure(y, 40);
  sectionTitle(doc, 'Sunday check-ins — all fields per submission', y, contentW, margin);
  y += 30;
  if (!rows.length) {
    doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(9).text('No Sunday check-ins this month.', margin, y, { width: contentW });
    return y + 20;
  }
  const fields = [
    'full_name',
    'reply_email',
    'plan',
    'current_weight_waist_week',
    'last_week_weight_waist',
    'total_weight_loss',
    'training_go',
    'nutrition_go',
    'sleep',
    'occupation_stress',
    'other_stress',
    'differences_felt',
    'achievements',
    'improve_next_week',
    'questions',
    'body_fat_percent',
    'created_at'
  ];
  rows.forEach((r, idx) => {
    let h = 22;
    fields.forEach((k) => {
      const val = formatVal(r[k], 2800);
      doc.font(F(doc, 'body')).fontSize(7.2);
      h += doc.heightOfString(`${k}: ${val}`, { width: contentW - 28, lineGap: 2 }) + 5;
    });
    y = paginator.ensure(y, h + 14);
    doc.roundedRect(margin, y, contentW, h, 7).fillAndStroke('#FFFEF8', '#E8DFC8');
    doc.fillColor(C.goldDark).font(F(doc, 'semi')).fontSize(8).text(`Sunday #${idx + 1} · ${formatDate(r.created_at)}`, margin + 10, y + 8);
    let ly = y + 22;
    fields.forEach((k) => {
      const val = formatVal(r[k], 2800);
      doc.fillColor(C.muted).font(F(doc, 'semi')).fontSize(6.8).text(k.replace(/_/g, ' '), margin + 10, ly, { width: 110 });
      doc.fillColor(C.text).font(F(doc, 'body')).fontSize(7.2).text(val, margin + 118, ly, { width: contentW - 130, lineGap: 2 });
      ly += doc.heightOfString(val, { width: contentW - 130, lineGap: 2 }) + 4;
    });
    y = ly + 10;
  });
  return y;
}

function renderWorkoutsFull(doc, margin, y, contentW, rows, paginator) {
  y = paginator.ensure(y, 40);
  sectionTitle(doc, 'My Workout sessions — complete fields (incl. session_lifts)', y, contentW, margin);
  y += 30;
  if (!rows.length) {
    doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(9).text('No My Workout rows this month.', margin, y, { width: contentW });
    return y + 20;
  }
  rows.forEach((r, idx) => {
    const keys = Object.keys(r).filter((k) => !['user_id'].includes(k));
    let h = 22;
    keys.forEach((k) => {
      const val = formatVal(r[k], 4000);
      doc.font(F(doc, 'body')).fontSize(7.1);
      h += doc.heightOfString(`${k}: ${val}`, { width: contentW - 28, lineGap: 1.5 }) + 4;
    });
    y = paginator.ensure(y, h + 14);
    doc.roundedRect(margin, y, contentW, h, 7).fillAndStroke('#F5FAF7', '#C5D9CC');
    doc.fillColor(C.goldDark).font(F(doc, 'semi')).fontSize(8).text(`Session ${idx + 1} · ${formatDate(r.created_at || r.session_date)}`, margin + 10, y + 8);
    let ly = y + 22;
    keys.forEach((k) => {
      const val = formatVal(r[k], 4000);
      doc.fillColor(C.muted).font(F(doc, 'semi')).fontSize(6.8).text(k.replace(/_/g, ' '), margin + 10, ly, { width: 104 });
      doc.fillColor(C.text).font(F(doc, 'body')).fontSize(7.1).text(val, margin + 112, ly, { width: contentW - 124, lineGap: 1.5 });
      ly += doc.heightOfString(val, { width: contentW - 124, lineGap: 1.5 }) + 3;
    });
    y = ly + 10;
  });
  return y;
}

function renderGoalsHydrationWeight(doc, margin, y, contentW, data, paginator) {
  y = paginator.ensure(y, 36);
  sectionTitle(doc, 'Platform goals · hydration · weight_logs (reporting month)', y, contentW, margin);
  y += 28;
  const goals = data.userGoals || [];
  if (goals.length) {
    goals.forEach((g, i) => {
      const txt = `Target weight: ${g.target_weight ?? '—'} · BF%: ${g.target_body_fat ?? '—'} · Weekly workouts: ${g.weekly_workout_target ?? '—'} · Set: ${formatDate(g.created_at)}`;
      const th = doc.heightOfString(txt, { width: contentW - 20, lineGap: 2 }) + 12;
      y = paginator.ensure(y, th + 8);
      doc.roundedRect(margin, y, contentW, th, 5).fillAndStroke('#F0F7FF', '#B8C2D6');
      doc.fillColor(C.text).font(F(doc, 'body')).fontSize(7.6).text(`Goal record ${i + 1}: ${txt}`, margin + 10, y + 6, { width: contentW - 20 });
      y += th + 6;
    });
  } else {
    y = paginator.ensure(y, 22);
    doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(8).text('No user_goals rows.', margin, y, { width: contentW });
    y += 18;
  }
  const hyd = data.hydrationLogs || [];
  if (hyd.length) {
    y = paginator.ensure(y, 28);
    doc.fillColor(C.goldDark).font(F(doc, 'semi')).fontSize(8).text('Hydration logs', margin, y);
    y += 14;
    hyd.forEach((hrow) => {
      const line = `${formatDate(hrow.created_at)} · ${hrow.amount_ml ?? '—'} ml · glasses: ${hrow.glasses ?? '—'}`;
      const hh = doc.heightOfString(line, { width: contentW - 16 }) + 8;
      y = paginator.ensure(y, hh);
      doc.fillColor(C.text).font(F(doc, 'body')).fontSize(7.4).text(line, margin + 8, y, { width: contentW - 16 });
      y += hh;
    });
  }
  const wl = data.weightLogs || [];
  if (wl.length) {
    y = paginator.ensure(y, 26);
    doc.fillColor(C.goldDark).font(F(doc, 'semi')).fontSize(8).text('Dedicated weight_logs', margin, y);
    y += 14;
    wl.forEach((wrow) => {
      const line = `${formatDate(wrow.created_at)} · ${wrow.weight_kg != null ? wrow.weight_kg + ' kg' : '—'}`;
      y = paginator.ensure(y, 16);
      doc.fillColor(C.text).font(F(doc, 'body')).fontSize(7.4).text(line, margin + 8, y, { width: contentW - 16 });
      y += 14;
    });
  }
  return y + 8;
}

function renderMeetingsOnly(doc, margin, y, contentW, data, paginator) {
  y = paginator.ensure(y, 36);
  sectionTitle(doc, 'Meetings (month window)', y, contentW, margin);
  y += 28;
  const mtg = data.meetings || [];
  if (mtg.length) {
    mtg.forEach((m) => {
      const line = `${m.meeting_date || '—'} ${m.time_slot || ''} · ${m.status || ''}${m.notes ? ' · ' + formatVal(m.notes, 1200) : ''}`;
      const hh = doc.heightOfString(line, { width: contentW - 16, lineGap: 2 }) + 10;
      y = paginator.ensure(y, hh + 4);
      doc.roundedRect(margin, y, contentW, hh, 5).fillAndStroke('#F7F5FF', '#D4CCE8');
      doc.fillColor(C.text).font(F(doc, 'body')).fontSize(7.4).text(line, margin + 8, y + 5, { width: contentW - 16, lineGap: 2 });
      y += hh + 4;
    });
  } else {
    doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(8).text('No meetings in this month.', margin, y, { width: contentW });
    y += 16;
  }
  return y;
}

function renderProgramsTribe(doc, margin, y, contentW, data, paginator) {
  y = paginator.ensure(y, 36);
  sectionTitle(doc, 'Assigned programs & tribe snapshot', y, contentW, margin);
  y += 28;
  const programs = data.programs || [];
  programs.forEach((p, i) => {
    const line = `${i === 0 ? '★ CURRENT · ' : ''}${p.program_name || '—'} · assigned ${p.assigned_at ? formatDate(p.assigned_at) : '—'}`;
    y = paginator.ensure(y, 18);
    doc.fillColor(C.text).font(F(doc, 'body')).fontSize(7.8).text(line, margin, y, { width: contentW });
    y += 16;
  });
  const t = data.tribeMember;
  if (t) {
    y = paginator.ensure(y, 60);
    doc.roundedRect(margin, y, contentW, 52, 7).fillAndStroke('#F2FFF6', '#9DCDB8');
    doc.fillColor(C.text).font(F(doc, 'body')).fontSize(7.6).text(
      `Tribe · ${t.status || '—'} · Phase ${t.phase ?? '—'} · Started ${t.start_date || '—'} · Activity/wk: ${t.activity_per_week ?? '—'}`,
      margin + 10,
      y + 8,
      { width: contentW - 20 }
    );
    doc.text(
      `Weight ${t.starting_weight ?? '—'} → ${t.current_weight ?? '—'} (target ${t.target_weight ?? '—'}) · Next check-in: ${t.next_checkin || '—'}`,
      margin + 10,
      y + 22,
      { width: contentW - 20 }
    );
    if (t.notes) doc.text(`Notes: ${formatVal(t.notes, 1500)}`, margin + 10, y + 34, { width: contentW - 20, lineGap: 2 });
    y += 58;
  }
  return y + 8;
}

/**
 * @param {object} aiNarrative — { executive_summary, sections: { onboarding_audit, ... } }
 */
function renderLuxuryDetailSections(doc, ctx) {
  const {
    margin,
    contentW,
    user,
    monthKeyText,
    data,
    aiNarrative,
    performanceLines,
    insightTags,
    docId,
    startY
  } = ctx;

  const paginator = createPaginator(doc, margin, contentW, docId);
  let y = startY;
  const secRaw = (aiNarrative && aiNarrative.sections) || {};
  const sec = {
    ...secRaw,
    meetings: secRaw.meetings || secRaw.meetings_messages
  };

  /* Engine snapshot (lifetime) */
  y = paginator.ensure(y, 50);
  sectionTitle(doc, 'Progress engine — cumulative signals', y, contentW, margin);
  y += 28;
  const metricsTextW = contentW - 24;
  const perfH = measureBulletsHeight(doc, (performanceLines || []).slice(0, 12), metricsTextW, 7.6);
  const tagH = (insightTags || []).length ? measureBulletsHeight(doc, insightTags.slice(0, 12), metricsTextW, 7.6) + 16 : 0;
  const metricsBoxH = 28 + perfH + tagH + 12;
  y = paginator.ensure(y, metricsBoxH + 20);
  doc.roundedRect(margin, y, contentW, metricsBoxH, 8).fillAndStroke(C.panel, '#B8C2D6');
  doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(7.4).text(
    'Lifetime / merged analytics (not limited to this month).',
    margin + 12,
    y + 8,
    { width: metricsTextW }
  );
  addBulletList(doc, (performanceLines || []).slice(0, 12), margin + 12, y + 20, metricsTextW, C.text, 7.6, paginator, margin);
  if ((insightTags || []).length) {
    doc.fillColor(C.goldDark).font(F(doc, 'semi')).fontSize(7.8).text('Engine insight tags', margin + 12, y + 22 + perfH);
    addBulletList(doc, insightTags.slice(0, 12), margin + 12, y + 32 + perfH, metricsTextW, C.emerald, 7.6, paginator, margin);
  }
  y += metricsBoxH + 12;

  /* Onboarding audit */
  y = drawProsConsBlock(doc, margin, y, contentW, 'Section 1 · Onboarding audit', sec.onboarding_audit, paginator);
  y = paginator.ensure(y, 40);
  sectionTitle(doc, 'Onboarding audit — all submitted fields', y, contentW, margin);
  y += 28;
  if (data.audit) {
    y = renderKeyValueObject(doc, margin, y, contentW, data.audit, paginator);
  } else {
    y = paginator.ensure(y, 22);
    doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(8.5).text('No onboarding audit on file.', margin, y, { width: contentW });
    y += 20;
  }

  /* Part 2 */
  y = drawProsConsBlock(doc, margin, y, contentW, 'Section 2 · Part-2 deep intake', sec.part2_intake, paginator);
  y = paginator.ensure(y, 36);
  sectionTitle(doc, 'Part-2 intake — all fields', y, contentW, margin);
  y += 28;
  if (data.part2) {
    y = renderKeyValueObject(doc, margin, y, contentW, data.part2, paginator);
  } else {
    y = paginator.ensure(y, 22);
    doc.fillColor(C.muted).font(F(doc, 'body')).fontSize(8.5).text('No Part-2 submission.', margin, y, { width: contentW });
    y += 20;
  }

  /* Tribe + programs early */
  y = drawProsConsBlock(doc, margin, y, contentW, 'Section 3 · Tribe & programs', sec.tribe_programs, paginator);
  y = renderProgramsTribe(doc, margin, y, contentW, data, paginator);

  y = drawProsConsBlock(doc, margin, y, contentW, 'Section 4 · Daily telemetry', sec.daily_checkins, paginator);
  y = renderDailyTable(doc, margin, y, contentW, data.dailyCheckins || [], paginator);

  y = drawProsConsBlock(doc, margin, y, contentW, 'Section 5 · Progress logs', sec.progress_logs, paginator);
  y = renderProgressTable(doc, margin, y, contentW, data.progressLogs || [], paginator);

  y = drawProsConsBlock(doc, margin, y, contentW, 'Section 6 · Sunday check-ins', sec.sunday_checkins, paginator);
  y = renderSundayFull(doc, margin, y, contentW, data.sundayCheckins || [], paginator);

  y = drawProsConsBlock(doc, margin, y, contentW, 'Section 7 · My Workout', sec.workouts, paginator);
  y = renderWorkoutsFull(doc, margin, y, contentW, data.workouts || [], paginator);

  y = drawProsConsBlock(doc, margin, y, contentW, 'Section 8 · Goals · hydration · weight', sec.hydration_weight_goals, paginator);
  y = renderGoalsHydrationWeight(doc, margin, y, contentW, data, paginator);

  y = drawProsConsBlock(doc, margin, y, contentW, 'Section 9 · Meetings', sec.meetings, paginator);
  y = renderMeetingsOnly(doc, margin, y, contentW, data, paginator);

  paginator.drawFooter();
}

module.exports = { renderLuxuryDetailSections, createPaginator };
