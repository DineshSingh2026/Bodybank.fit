"""
BodyBank.fit — Blood Report + Nutrition AI Health Report Generator
ReportLab PDF — zero alignment issues, no nested tables.
"""

import json
from datetime import datetime
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, PageBreak
)
from reportlab.lib.colors import HexColor

BG       = HexColor('#0d0f11')
SURFACE  = HexColor('#161a1e')
SURFACE2 = HexColor('#1e2328')
GREEN    = HexColor('#3dd68c')
AMBER    = HexColor('#f5a623')
BLUE     = HexColor('#4da6ff')
RED      = HexColor('#ff5c5c')
TEXT     = HexColor('#f0ede8')
MUTED    = HexColor('#8a8880')
WHITE    = HexColor('#ffffff')
DARK     = HexColor('#1a1f24')
BORDER   = HexColor('#2a2f35')
INC_BG   = HexColor('#1a2e1a')
AVD_BG   = HexColor('#2e1a1a')
INFO_BG  = HexColor('#1a1a2e')

PAGE_W, PAGE_H = A4
MARGIN = 18 * mm
CW = PAGE_W - 2 * MARGIN

_sc = [0]
def S(name='_', **kw):
    _sc[0] += 1
    base = dict(fontName='Helvetica', fontSize=10, textColor=TEXT,
                leading=15, spaceAfter=0, spaceBefore=0, alignment=TA_LEFT)
    base.update(kw)
    return ParagraphStyle(f'{name}_{_sc[0]}', **base)

STYLES = {}
def _make_styles():
    STYLES['h1']    = ParagraphStyle('h1_fixed', fontName='Helvetica-Bold', fontSize=15, textColor=GREEN, leading=20, spaceBefore=14, spaceAfter=6, alignment=TA_LEFT)
    STYLES['h2']    = ParagraphStyle('h2_fixed', fontName='Helvetica-Bold', fontSize=12, textColor=WHITE, leading=16, spaceBefore=8, spaceAfter=4, alignment=TA_LEFT)
    STYLES['body']  = ParagraphStyle('body_fixed', fontName='Helvetica', fontSize=10, textColor=TEXT, leading=15, spaceAfter=4, alignment=TA_JUSTIFY)
    STYLES['muted'] = ParagraphStyle('muted_fixed', fontName='Helvetica', fontSize=9, textColor=MUTED, leading=13, alignment=TA_LEFT)
    STYLES['label'] = ParagraphStyle('label_fixed', fontName='Helvetica-Bold', fontSize=8, textColor=MUTED, leading=11, alignment=TA_LEFT)
    STYLES['small'] = ParagraphStyle('small_fixed', fontName='Helvetica', fontSize=8, textColor=MUTED, leading=11, alignment=TA_LEFT)
    STYLES['foot']  = ParagraphStyle('foot_fixed', fontName='Helvetica', fontSize=8, textColor=MUTED, leading=11, alignment=TA_CENTER)
    STYLES['disc']  = ParagraphStyle('disc_fixed', fontName='Helvetica-Oblique', fontSize=8.5, textColor=MUTED, leading=13, alignment=TA_JUSTIFY)
    STYLES['cover_title'] = ParagraphStyle('ct_fixed', fontName='Helvetica-Bold', fontSize=26, textColor=WHITE, leading=32, alignment=TA_LEFT)
    STYLES['cover_sub']   = ParagraphStyle('cs_fixed', fontName='Helvetica', fontSize=13, textColor=MUTED, leading=18, alignment=TA_LEFT)
_make_styles()

def hr(col=BORDER, t=0.5, sb=4, sa=4):
    return HRFlowable(width='100%', thickness=t, color=col, spaceBefore=sb, spaceAfter=sa)

def p(txt, style='body', **kw):
    if kw:
        st = S(**kw)
    else:
        st = STYLES.get(style, STYLES['body'])
    return Paragraph(str(txt), st)

def sp(h=6): return Spacer(1, h)

def status_color(st):
    return GREEN if st in ('Normal','Optimal') else RED if st in ('Critical','High','Deficient') else AMBER

def page_background(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(BG)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    canvas.setFillColor(GREEN)
    canvas.rect(0, PAGE_H - 2, PAGE_W, 2, fill=1, stroke=0)
    canvas.setFillColor(SURFACE)
    canvas.rect(0, 0, PAGE_W, 18*mm, fill=1, stroke=0)
    canvas.setFillColor(BORDER)
    canvas.rect(MARGIN, 16.2*mm, CW, 0.3, fill=1, stroke=0)
    canvas.setFont('Helvetica', 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN, 7.5*mm, f'BodyBank.fit  ·  Health Report  ·  {doc._bb_name}')
    canvas.drawRightString(PAGE_W - MARGIN, 7.5*mm, f'{doc._bb_date}  ·  Page {doc.page}')
    canvas.setFont('Helvetica-Bold', 9)
    canvas.setFillColor(GREEN)
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 7.5*mm, 'BodyBank.fit')
    canvas.restoreState()

def first_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(BG)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    canvas.restoreState()

def data_table(rows, widths, header_bg=SURFACE2, row_bgs=(DARK, SURFACE),
               has_header=True, valign='MIDDLE'):
    t = Table(rows, colWidths=widths, repeatRows=1 if has_header else 0)
    style = [
        ('LEFTPADDING', (0,0), (-1,-1), 10),
        ('RIGHTPADDING', (0,0), (-1,-1), 10),
        ('TOPPADDING', (0,0), (-1,-1), 7),
        ('BOTTOMPADDING', (0,0), (-1,-1), 7),
        ('VALIGN', (0,0), (-1,-1), valign),
        ('LINEBELOW', (0,0), (-1,-2), 0.3, BORDER),
        ('BOX', (0,0), (-1,-1), 0.4, BORDER),
    ]
    if has_header:
        style += [('BACKGROUND', (0,0), (-1,0), header_bg)]
        for i in range(1, len(rows)):
            style.append(('BACKGROUND', (0,i), (-1,i), row_bgs[i % 2]))
    else:
        for i in range(len(rows)):
            style.append(('BACKGROUND', (0,i), (-1,i), row_bgs[i % 2]))
    t.setStyle(TableStyle(style))
    return t

def build_report(data, output_path):
    user      = data['user']
    blood     = data['blood_analysis']
    nutrition = data.get('nutrition_analysis', {})
    ai        = data['ai_report']
    date_str  = datetime.now().strftime('%d %B %Y')

    doc = SimpleDocTemplate(
        output_path, pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=22*mm, bottomMargin=22*mm,
        title=f'BodyBank Health Report — {user["name"]}',
    )
    doc._bb_name = user['name']
    doc._bb_date = date_str

    story = []
    add = story.append

    # COVER
    add(sp(28*mm))
    add(p('Comprehensive Health Report', 'cover_title'))
    add(sp(4))
    add(p('Blood Analysis + Nutrition Intelligence Report', 'cover_sub'))
    add(sp(12*mm))
    add(hr(GREEN, 1))
    add(sp(6))
    cov = Table([
        [p('PATIENT NAME','label'), p('DATE OF REPORT','label'), p('REPORT TYPE','label')],
        [p(user['name'], fontName='Helvetica-Bold', fontSize=14, textColor=WHITE, leading=18),
         p(date_str, fontName='Helvetica-Bold', fontSize=14, textColor=WHITE, leading=18),
         p('AI Health Analysis', fontName='Helvetica-Bold', fontSize=14, textColor=GREEN, leading=18)],
        [sp(4), sp(4), sp(4)],
        [p('AGE / GENDER','label'), p('FITNESS GOAL','label'), p('PREPARED BY','label')],
        [p(f"{user.get('age','—')} / {user.get('gender','—')}", fontName='Helvetica', fontSize=11, textColor=TEXT, leading=15),
         p(user.get('goal','—'), fontName='Helvetica', fontSize=11, textColor=TEXT, leading=15),
         p('BodyBank AI + Medical Review', 'muted')],
    ], colWidths=[CW/3]*3)
    cov.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), DARK), ('BOX', (0,0), (-1,-1), 0.5, BORDER),
        ('LEFTPADDING', (0,0), (-1,-1), 14), ('RIGHTPADDING', (0,0), (-1,-1), 14),
        ('TOPPADDING', (0,0), (-1,-1), 8), ('BOTTOMPADDING', (0,0), (-1,-1), 8),
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
    ]))
    add(cov)
    add(sp(8))
    overall = ai.get('overall_status','Fair')
    oc = GREEN if overall in ('Good','Excellent') else AMBER if overall=='Fair' else RED
    banner = Table([[
        p('OVERALL HEALTH STATUS', 'label'),
        p(overall, fontName='Helvetica-Bold', fontSize=22, textColor=oc, leading=26),
        p(ai.get('overall_summary_short',''), fontSize=10, textColor=TEXT, leading=14),
    ]], colWidths=[CW*0.23, CW*0.22, CW*0.55])
    banner.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), SURFACE), ('BOX', (0,0), (-1,-1), 1, oc),
        ('LEFTPADDING', (0,0), (-1,-1), 14), ('RIGHTPADDING', (0,0), (-1,-1), 14),
        ('TOPPADDING', (0,0), (-1,-1), 14), ('BOTTOMPADDING', (0,0), (-1,-1), 14),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ]))
    add(banner)
    add(sp(10))
    add(hr())
    add(sp(4))
    add(p('This report is generated by BodyBank.fit AI Health System. It is for informational purposes only and does not constitute a medical diagnosis. Please share this report with your physician.', 'disc'))
    add(PageBreak())

    # TABLE OF CONTENTS
    add(p('Contents', 'h1'))
    add(hr(GREEN, 1))
    add(sp(4))
    toc = [
        ('1','Blood Test Analysis','CBC, Metabolic Panel, Vitamins & Hormones'),
        ('2','Nutrition Intelligence','Dietary pattern from BodyBank meal tracker'),
        ('3','Clinical Interpretation','Doctor-level analysis of all findings'),
        ('4','Risk Assessment','Identified risks and areas of concern'),
        ('5','Foods to Include','Evidence-based food recommendations'),
        ('6','Foods to Avoid','Foods conflicting with your blood markers'),
        ('7','Weekly Meal Plan','Personalised 7-day nutrition framework'),
        ('8','Supplement Protocol','Recommended supplements for deficiencies'),
        ('9','Lifestyle Recommendations','Sleep, stress, exercise and recovery'),
        ('10','Progress Tracking','What to retest and when'),
    ]
    toc_rows = []
    for num, title, sub in toc:
        toc_rows.append([
            p(f'<b>{num}</b>', fontName='Helvetica-Bold', fontSize=10, textColor=GREEN, leading=14),
            p(f'<b>{title}</b><br/><font size="8" color="#8a8880">{sub}</font>', fontSize=10, textColor=TEXT, leading=15)
        ])
    tt = Table(toc_rows, colWidths=[14*mm, CW - 14*mm])
    tt.setStyle(TableStyle([
        ('LEFTPADDING',(0,0),(-1,-1),0), ('RIGHTPADDING',(0,0),(-1,-1),0),
        ('TOPPADDING',(0,0),(-1,-1),5), ('BOTTOMPADDING',(0,0),(-1,-1),5),
        ('LINEBELOW',(0,0),(-1,-2),0.3,BORDER), ('VALIGN',(0,0),(-1,-1),'TOP'),
    ]))
    add(tt)
    add(PageBreak())

    # SECTION 1: BLOOD TEST
    add(p('1. Blood Test Analysis', 'h1'))
    add(hr(GREEN, 1))
    for panel in blood.get('panels', []):
        add(sp(4))
        add(p(panel['name'], 'h2'))
        rows = [[p('MARKER','label'), p('VALUE','label'), p('REFERENCE RANGE','label'), p('STATUS','label')]]
        for m in panel.get('markers', []):
            sc = status_color(m.get('status','Normal'))
            flag = {'Critical':'⚠ ','High':'↑ ','Low':'↓ ','Elevated':'↑ ','Deficient':'⚠ '}.get(m.get('status',''),'')
            rows.append([
                p(m['name'], fontSize=10, textColor=TEXT, leading=14),
                p(f"<b>{m['value']} {m.get('unit','')}</b>", fontName='Helvetica-Bold', fontSize=10, textColor=WHITE, leading=14),
                p(m.get('reference','—'), 'muted'),
                p(f"{flag}{m.get('status','Normal')}", fontName='Helvetica-Bold', fontSize=9, textColor=sc, leading=12),
            ])
        add(data_table(rows, [CW*0.35, CW*0.22, CW*0.25, CW*0.18]))
    add(PageBreak())

    # SECTION 2: NUTRITION
    add(p('2. Nutrition Intelligence', 'h1'))
    add(hr(GREEN, 1))
    add(sp(4))
    if nutrition:
        avg = nutrition.get('averages', {})
        mt = Table([
            [p('AVG DAILY CALORIES','label'), p('AVG PROTEIN','label'), p('AVG CARBS','label'), p('AVG FAT','label')],
            [p(str(avg.get('calories','—')), fontName='Helvetica-Bold', fontSize=20, textColor=AMBER, leading=24),
             p(f"{avg.get('protein','—')}g", fontName='Helvetica-Bold', fontSize=20, textColor=GREEN, leading=24),
             p(f"{avg.get('carbs','—')}g", fontName='Helvetica-Bold', fontSize=20, textColor=BLUE, leading=24),
             p(f"{avg.get('fat','—')}g", fontName='Helvetica-Bold', fontSize=20, textColor=RED, leading=24)],
            [p('kcal/day','muted'), p('/day','muted'), p('/day','muted'), p('/day','muted')],
        ], colWidths=[CW/4]*4)
        mt.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,-1),DARK), ('BOX',(0,0),(-1,-1),0.5,BORDER),
            ('INNERGRID',(0,0),(-1,-1),0.3,BORDER),
            ('LEFTPADDING',(0,0),(-1,-1),12), ('RIGHTPADDING',(0,0),(-1,-1),12),
            ('TOPPADDING',(0,0),(-1,-1),10), ('BOTTOMPADDING',(0,0),(-1,-1),8),
            ('VALIGN',(0,0),(-1,-1),'TOP'),
        ]))
        add(mt)
        add(sp(8))
        mqs = nutrition.get('meal_quality_score', 0)
        mqs_c = GREEN if mqs >= 7 else AMBER if mqs >= 5 else RED
        mqs_t = Table([[
            p('MEAL QUALITY SCORE', 'label'),
            p(f'<b>{mqs}/10</b>', fontName='Helvetica-Bold', fontSize=16, textColor=mqs_c, leading=20),
            p(nutrition.get('quality_interpretation',''), 'muted'),
        ]], colWidths=[CW*0.28, CW*0.18, CW*0.54])
        mqs_t.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,-1),SURFACE), ('BOX',(0,0),(-1,-1),0.5,mqs_c),
            ('LEFTPADDING',(0,0),(-1,-1),12), ('RIGHTPADDING',(0,0),(-1,-1),12),
            ('TOPPADDING',(0,0),(-1,-1),10), ('BOTTOMPADDING',(0,0),(-1,-1),10),
            ('VALIGN',(0,0),(-1,-1),'MIDDLE'),
        ]))
        add(mqs_t)
        add(sp(8))
        if nutrition.get('top_meals'):
            add(p('Most Frequently Consumed Meals', 'h2'))
            meal_rows = [[p('MEAL','label'), p('FREQ','label'), p('AVG CAL','label'), p('ASSESSMENT','label')]]
            for m in nutrition['top_meals']:
                ac = GREEN if m.get('assessment')=='Good' else AMBER if m.get('assessment')=='Fair' else RED
                meal_rows.append([
                    p(m['name'], fontSize=10, textColor=TEXT, leading=14),
                    p(f"{m['frequency']}x/wk", 'muted'),
                    p(f"{m['avg_calories']} kcal", fontName='Helvetica-Bold', fontSize=10, textColor=AMBER, leading=14),
                    p(m.get('assessment',''), fontName='Helvetica-Bold', fontSize=9, textColor=ac, leading=12),
                ])
            add(data_table(meal_rows, [CW*0.4, CW*0.18, CW*0.22, CW*0.2]))
    else:
        add(p('No nutrition tracking data available. Begin logging meals in BodyBank to unlock this section.', 'muted'))
    add(PageBreak())

    # SECTION 3: CLINICAL INTERPRETATION
    add(p('3. Clinical Interpretation', 'h1'))
    add(hr(GREEN, 1))
    add(sp(4))
    add(p(ai.get('clinical_interpretation',''), 'body'))
    add(sp(8))
    findings = ai.get('key_findings', [])
    if findings:
        add(p('Key Findings', 'h2'))
        add(sp(3))
        for f in findings:
            sev = f.get('severity','info')
            bg_c = INC_BG if sev=='good' else AVD_BG if sev=='critical' else HexColor('#2a2410')
            bc = GREEN if sev=='good' else RED if sev=='critical' else AMBER
            tc = GREEN if sev=='good' else RED if sev=='critical' else AMBER
            ft = Table([[
                p(f.get('icon','●'), fontName='Helvetica-Bold', fontSize=13, textColor=tc, leading=16),
                p(f"<b>{f['title']}</b>  <font size='9' color='#8a8880'>{f['detail']}</font>", fontSize=10, textColor=TEXT, leading=14),
            ]], colWidths=[22, CW-22])
            ft.setStyle(TableStyle([
                ('BACKGROUND',(0,0),(-1,-1),bg_c), ('BOX',(0,0),(-1,-1),0.5,bc),
                ('LEFTPADDING',(0,0),(0,-1),6), ('LEFTPADDING',(1,0),(1,-1),8),
                ('RIGHTPADDING',(0,0),(0,-1),2), ('RIGHTPADDING',(1,0),(1,-1),10),
                ('TOPPADDING',(0,0),(-1,-1),9), ('BOTTOMPADDING',(0,0),(-1,-1),9),
                ('VALIGN',(0,0),(-1,-1),'MIDDLE'),
            ]))
            add(ft)
            add(sp(4))
    add(PageBreak())

    # SECTION 4: RISK ASSESSMENT
    add(p('4. Risk Assessment', 'h1'))
    add(hr(GREEN, 1))
    add(sp(4))
    risks = ai.get('risks', [])
    if risks:
        risk_rows = [[p('RISK AREA','label'), p('LEVEL','label'), p('CONTRIBUTING FACTORS','label')]]
        for r in risks:
            rl = r.get('level','Medium')
            rc_ = RED if rl=='High' else AMBER if rl=='Medium' else GREEN
            risk_rows.append([
                p(r['area'], fontName='Helvetica-Bold', fontSize=10, textColor=TEXT, leading=14),
                p(rl, fontName='Helvetica-Bold', fontSize=10, textColor=rc_, leading=14),
                p(r.get('factors',''), 'muted'),
            ])
        add(data_table(risk_rows, [CW*0.3, CW*0.18, CW*0.52]))
    add(PageBreak())

    # SECTION 5: FOODS TO INCLUDE
    add(p('5. Foods to Include', 'h1'))
    add(hr(GREEN, 1))
    add(sp(4))
    add(p(ai.get('foods_include_intro',''), 'body'))
    add(sp(6))
    for food in ai.get('foods_include', []):
        ft = Table([[
            p('<b>✓</b>', fontName='Helvetica-Bold', fontSize=12, textColor=GREEN, leading=14),
            p(f"<b>{food['name']}</b>  —  <font size='9' color='#8a8880'>{food.get('reason','')}</font>", fontSize=10, textColor=TEXT, leading=14),
        ]], colWidths=[24, CW-24])
        ft.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,-1),INC_BG), ('BOX',(0,0),(-1,-1),0.3,GREEN),
            ('LEFTPADDING',(0,0),(0,-1),4), ('LEFTPADDING',(1,0),(1,-1),8),
            ('RIGHTPADDING',(0,0),(0,-1),2), ('RIGHTPADDING',(1,0),(1,-1),10),
            ('TOPPADDING',(0,0),(-1,-1),8), ('BOTTOMPADDING',(0,0),(-1,-1),8),
            ('VALIGN',(0,0),(-1,-1),'MIDDLE'),
        ]))
        add(ft)
        add(sp(3))

    add(sp(8))
    add(p('6. Foods to Avoid', 'h1'))
    add(hr(RED, 1))
    add(sp(4))
    add(p(ai.get('foods_avoid_intro',''), 'body'))
    add(sp(6))
    for food in ai.get('foods_avoid', []):
        ft = Table([[
            p('<b>✗</b>', fontName='Helvetica-Bold', fontSize=12, textColor=RED, leading=14),
            p(f"<b>{food['name']}</b>  —  <font size='9' color='#8a8880'>{food.get('reason','')}</font>", fontSize=10, textColor=TEXT, leading=14),
        ]], colWidths=[20, CW-20])
        ft.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,-1),AVD_BG), ('BOX',(0,0),(-1,-1),0.3,RED),
            ('LEFTPADDING',(0,0),(0,-1),4), ('LEFTPADDING',(1,0),(1,-1),8),
            ('RIGHTPADDING',(0,0),(0,-1),2), ('RIGHTPADDING',(1,0),(1,-1),10),
            ('TOPPADDING',(0,0),(-1,-1),8), ('BOTTOMPADDING',(0,0),(-1,-1),8),
            ('VALIGN',(0,0),(-1,-1),'MIDDLE'),
        ]))
        add(ft)
        add(sp(3))
    add(PageBreak())

    # SECTION 7: WEEKLY MEAL PLAN
    add(p('7. Personalised Weekly Meal Plan', 'h1'))
    add(hr(GREEN, 1))
    add(sp(4))
    add(p(ai.get('meal_plan_intro',''), 'body'))
    add(sp(6))
    day_accents = [BLUE, GREEN, AMBER, HexColor('#a855f7'), RED, GREEN, HexColor('#a855f7')]
    day_bgs = [HexColor('#1a2030'), HexColor('#1a2820'), HexColor('#2a2410'),
               HexColor('#1a1a2e'), HexColor('#2a1a1a'), HexColor('#1a2828'), HexColor('#201a28')]
    for i, day in enumerate(ai.get('weekly_meal_plan', [])):
        da = day_accents[i % len(day_accents)]
        db = day_bgs[i % len(day_bgs)]
        dh = Table([[
            p(day['day'], fontName='Helvetica-Bold', fontSize=11, textColor=da, leading=14),
            p(f"~{day.get('total_calories','—')} kcal  ·  {day.get('total_protein','—')}g protein", fontSize=9, textColor=MUTED, leading=12),
        ]], colWidths=[CW*0.25, CW*0.75])
        dh.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,-1),db),
            ('TOPPADDING',(0,0),(-1,-1),7), ('BOTTOMPADDING',(0,0),(-1,-1),7),
            ('LEFTPADDING',(0,0),(-1,-1),10), ('RIGHTPADDING',(0,0),(-1,-1),10),
            ('LINEBELOW',(0,0),(-1,-1),1,da), ('VALIGN',(0,0),(-1,-1),'MIDDLE'),
        ]))
        add(dh)
        meal_rows = []
        for meal in day.get('meals', []):
            meal_rows.append([
                p(meal['type'].upper(), 'label'),
                p(meal['meal'], fontSize=9.5, textColor=TEXT, leading=13),
                p(f"{meal.get('calories','—')} kcal", fontName='Helvetica-Bold', fontSize=9, textColor=AMBER, leading=12),
            ])
        if meal_rows:
            mt_ = Table(meal_rows, colWidths=[CW*0.18, CW*0.62, CW*0.20])
            mt_.setStyle(TableStyle([
                ('ROWBACKGROUNDS',(0,0),(-1,-1),[DARK,SURFACE]),
                ('LINEBELOW',(0,0),(-1,-2),0.3,BORDER),
                ('LEFTPADDING',(0,0),(-1,-1),10), ('RIGHTPADDING',(0,0),(-1,-1),10),
                ('TOPPADDING',(0,0),(-1,-1),6), ('BOTTOMPADDING',(0,0),(-1,-1),6),
                ('VALIGN',(0,0),(-1,-1),'MIDDLE'), ('BOX',(0,0),(-1,-1),0.3,BORDER),
            ]))
            add(mt_)
        add(sp(5))
    add(PageBreak())

    # SECTION 8: SUPPLEMENTS
    add(p('8. Supplement Protocol', 'h1'))
    add(hr(GREEN, 1))
    add(sp(4))
    add(p(ai.get('supplement_intro',''), 'body'))
    add(sp(6))
    sups = ai.get('supplements', [])
    if sups:
        sup_rows = [[p('SUPPLEMENT','label'), p('DOSE','label'), p('TIMING','label'), p('REASON','label')]]
        for s in sups:
            sup_rows.append([
                p(f"<b>{s['name']}</b>", fontName='Helvetica-Bold', fontSize=10, textColor=BLUE, leading=14),
                p(s.get('dose',''), 'muted'),
                p(s.get('timing',''), 'muted'),
                p(s.get('reason',''), 'muted'),
            ])
        add(data_table(sup_rows, [CW*0.28, CW*0.20, CW*0.18, CW*0.34]))
    add(PageBreak())

    # SECTION 9: LIFESTYLE
    add(p('9. Lifestyle Recommendations', 'h1'))
    add(hr(GREEN, 1))
    add(sp(4))
    lifestyle = ai.get('lifestyle', {})
    cats = [
        ('Sleep', lifestyle.get('sleep',''), BLUE),
        ('Stress Management', lifestyle.get('stress',''), HexColor('#a855f7')),
        ('Exercise', lifestyle.get('exercise',''), GREEN),
        ('Hydration', lifestyle.get('hydration',''), BLUE),
        ('Recovery', lifestyle.get('recovery',''), AMBER),
    ]
    for cat_name, cat_text, cat_color in cats:
        if cat_text:
            # Label column must fit "Stress Management" on word boundaries — a
            # narrow width breaks it mid-word (Stres/s Man/agem/ent).
            lt = Table([[
                p(cat_name, fontName='Helvetica-Bold', fontSize=10, textColor=cat_color, leading=14),
                p(cat_text, fontSize=10, textColor=TEXT, leading=14, alignment=TA_JUSTIFY),
            ]], colWidths=[30*mm, CW - 30*mm])
            lt.setStyle(TableStyle([
                ('BACKGROUND',(0,0),(-1,-1),DARK), ('BOX',(0,0),(-1,-1),0.3,BORDER),
                ('LINEBEFORE',(0,0),(0,-1),3,cat_color),
                ('LEFTPADDING',(0,0),(-1,-1),10), ('RIGHTPADDING',(0,0),(-1,-1),10),
                ('TOPPADDING',(0,0),(-1,-1),10), ('BOTTOMPADDING',(0,0),(-1,-1),10),
                ('VALIGN',(0,0),(-1,-1),'TOP'),
            ]))
            add(lt)
            add(sp(5))
    add(PageBreak())

    # SECTION 10: PROGRESS
    add(p('10. Progress Tracking & Retest Schedule', 'h1'))
    add(hr(GREEN, 1))
    add(sp(4))
    add(p(ai.get('progress_intro',''), 'body'))
    add(sp(6))
    retests = ai.get('retest_schedule', [])
    if retests:
        rt_rows = [[p('TEST','label'), p('RETEST IN','label'), p('REASON','label')]]
        for rt in retests:
            rt_rows.append([
                p(rt['test'], fontName='Helvetica-Bold', fontSize=10, textColor=TEXT, leading=14),
                p(rt.get('when',''), fontName='Helvetica-Bold', fontSize=10, textColor=AMBER, leading=14),
                p(rt.get('reason',''), 'muted'),
            ])
        add(data_table(rt_rows, [CW*0.35, CW*0.18, CW*0.47]))

    add(sp(10))
    add(hr())
    add(sp(4))
    disc_t = Table([[p(
        '<b>Medical Disclaimer:</b> This report is generated by BodyBank.fit\'s AI Health System '
        'using Claude Sonnet AI. It does not constitute a medical diagnosis. All supplement and dietary '
        'recommendations must be reviewed with your physician before implementation.',
        'disc'
    )]], colWidths=[CW])
    disc_t.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,-1),HexColor('#141414')), ('BOX',(0,0),(-1,-1),0.5,BORDER),
        ('LEFTPADDING',(0,0),(-1,-1),14), ('RIGHTPADDING',(0,0),(-1,-1),14),
        ('TOPPADDING',(0,0),(-1,-1),12), ('BOTTOMPADDING',(0,0),(-1,-1),12),
    ]))
    add(disc_t)
    doc.build(story, onFirstPage=first_page, onLaterPages=page_background)
    return output_path

if __name__ == '__main__':
    import argparse
    import sys
    # Force UTF-8 on stdio so dashes/symbols in status output never corrupt,
    # regardless of the host's default locale (Windows defaults to cp1252).
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding='utf-8')
        except Exception:
            pass
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', help='Path to JSON data file')
    parser.add_argument('--output', help='Output PDF path')
    args = parser.parse_args()

    if args.data and args.output:
        # Explicit UTF-8: Node writes the payload as UTF-8, but Python's open()
        # defaults to the platform locale (cp1252 on Windows), which mangles
        # en/em-dashes (–—) and check/cross marks (✓✗) into mojibake.
        with open(args.data, 'r', encoding='utf-8') as f:
            data = json.load(f)
        build_report(data, args.output)
        print(f'PDF generated: {args.output}')
    else:
        print('Usage: python generate_health_report.py --data data.json --output report.pdf')
