#!/usr/bin/env python3
"""docs/ の Markdown を Word（.docx）にする。
使い方: python3 tools/build_word.py <mmdc のパス> <puppeteer の設定 JSON>
- Mermaid の図は mmdc で PNG にして埋め込む
- 書式は tools/reference.docx（なければ作る）
- 表に罫線・見出し行の色を付け、画像は本文の幅に収める
"""
import glob, hashlib, os, re, subprocess, sys, tempfile
from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, 'docs')
OUT = os.path.join(DOCS, 'word')
MMDC, PPCONF = sys.argv[1], sys.argv[2]
NAVY, GOLD = RGBColor(0x16, 0x21, 0x3C), RGBColor(0xB8, 0x86, 0x2E)
FONT_JA, FONT_EN = '游ゴシック', 'Segoe UI'


def set_font(style, size=None, bold=None, color=None):
    style.font.name = FONT_EN
    rpr = style.element.get_or_add_rPr()
    rf = rpr.find(qn('w:rFonts'))
    if rf is None:
        rf = OxmlElement('w:rFonts'); rpr.append(rf)
    for k in ('w:ascii', 'w:hAnsi', 'w:cs'):
        rf.set(qn(k), FONT_EN)
    rf.set(qn('w:eastAsia'), FONT_JA)
    for k in ('w:asciiTheme', 'w:hAnsiTheme', 'w:eastAsiaTheme', 'w:cstheme'):
        if rf.get(qn(k)) is not None:
            del rf.attrib[qn(k)]
    if size: style.font.size = Pt(size)
    if bold is not None: style.font.bold = bold
    if color is not None: style.font.color.rgb = color


def make_reference(path):
    raw = subprocess.run(['pandoc', '-o', path, '--print-default-data-file', 'reference.docx'], check=True)
    d = Document(path)
    sec = d.sections[0]
    sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
    for m in ('left_margin', 'right_margin'): setattr(sec, m, Cm(1.8))
    for m in ('top_margin', 'bottom_margin'): setattr(sec, m, Cm(1.8))
    byname = {s.name.lower(): s for s in d.styles}
    g = lambda n: byname.get(n.lower())
    for name in ('Normal', 'Body Text', 'First Paragraph', 'Compact', 'Block Text', 'Source Code', 'TOC Heading'):
        if g(name) is not None:
            set_font(g(name), 8.5 if name == 'Source Code' else 10)
    for name, size in (('Title', 20), ('Heading 1', 15), ('Heading 2', 12.5), ('Heading 3', 11), ('Heading 4', 10.5)):
        if g(name) is not None:
            set_font(g(name), size, True, NAVY)
    d.save(path)


def render_mermaid(code, workdir):
    h = hashlib.sha1(code.encode('utf-8')).hexdigest()[:12]
    src, png = os.path.join(workdir, h + '.mmd'), os.path.join(workdir, h + '.png')
    if not os.path.exists(png):
        open(src, 'w', encoding='utf-8').write(code)
        subprocess.run([MMDC, '-p', PPCONF, '-i', src, '-o', png, '-b', 'white', '-w', '1600', '-s', '2'], check=True, capture_output=True)
    return png


def shade(cell, hex_):
    tcpr = cell._tc.get_or_add_tcPr()
    sh = OxmlElement('w:shd'); sh.set(qn('w:val'), 'clear'); sh.set(qn('w:color'), 'auto'); sh.set(qn('w:fill'), hex_); tcpr.append(sh)


def borders(table):
    tblpr = table._tbl.tblPr
    b = OxmlElement('w:tblBorders')
    for e in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        x = OxmlElement(f'w:{e}'); x.set(qn('w:val'), 'single'); x.set(qn('w:sz'), '4'); x.set(qn('w:color'), 'B9B1A0'); b.append(x)
    tblpr.append(b)


def fit_columns(table, total):
    """列の幅を中身の文字数から決め、表をページの幅いっぱいにする"""
    rows = table.rows
    ncol = max(len(r.cells) for r in rows)
    lens = [[] for _ in range(ncol)]
    for r in rows:
        for i, c in enumerate(r.cells[:ncol]):
            t = c.text.strip()
            w = sum(2 if ord(ch) > 0x2E7F else 1 for ch in t)  # 全角は2
            lens[i].append(w)
    weights = []
    for L in lens:
        L = sorted(L) or [4]
        mx, avg = L[-1], sum(L) / len(L)
        weights.append(min(max(avg * 0.7 + mx * 0.3, 6), 70))
    # 折り返せない語（英数字の続き）の長さを最低の幅にする
    tok = [0] * ncol
    for r in rows:
        for i, c in enumerate(r.cells[:ncol]):
            for t in re.findall(r'[A-Za-z0-9_./{}:\-]+', c.text):
                tok[i] = max(tok[i], len(t))
    half = Cm(0.165)  # 8.5pt の半角1文字の幅の目安
    short = [0] * ncol  # 8文字以内の短い語句（未回答・確定 など）は折り返さない
    for r in rows:
        for i, c in enumerate(r.cells[:ncol]):
            t = c.text.strip()
            if 0 < len(t) <= 8:
                short[i] = max(short[i], sum(2 if ord(ch) > 0x2E7F else 1 for ch in t))
    minw = [min(int(half * (max(tok[i], short[i]) + 1.5)), int(total * 0.35)) for i in range(ncol)]
    if sum(minw) > total * 0.9:
        minw = [int(m * total * 0.9 / sum(minw)) for m in minw]
    rest = total - sum(minw)
    sw = sum(weights)
    widths = [minw[i] + int(rest * weights[i] / sw) for i in range(ncol)]
    tblpr = table._tbl.tblPr
    for tag in ('w:tblW', 'w:tblLayout'):
        e = tblpr.find(qn(tag))
        if e is not None: tblpr.remove(e)
    tw = OxmlElement('w:tblW'); tw.set(qn('w:w'), '5000'); tw.set(qn('w:type'), 'pct'); tblpr.append(tw)
    lay = OxmlElement('w:tblLayout'); lay.set(qn('w:type'), 'fixed'); tblpr.append(lay)
    grid = table._tbl.tblGrid
    for i, gc in enumerate(grid.findall(qn('w:gridCol'))):
        if i < len(widths): gc.set(qn('w:w'), str(int(widths[i] / 635)))  # EMU → twip
    for r in rows:
        for i, c in enumerate(r.cells[:ncol]):
            c.width = widths[i]


def finish(path, title):
    d = Document(path)
    maxw = d.sections[0].page_width - d.sections[0].left_margin - d.sections[0].right_margin
    for t in d.tables:
        borders(t)
        fit_columns(t, maxw)
        t.alignment = WD_TABLE_ALIGNMENT.CENTER
        for ri, row in enumerate(t.rows):
            for c in row.cells:
                for p in c.paragraphs:
                    p.paragraph_format.space_after = Pt(0)
                    for r in p.runs:
                        r.font.size = Pt(8.5)
                        if ri == 0: r.font.bold = True; r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
                if ri == 0: shade(c, '16213C')
    for shp in d.inline_shapes:
        if shp.width > maxw:
            ratio = maxw / shp.width; shp.width = int(shp.width * ratio); shp.height = int(shp.height * ratio)
    # ヘッダー・フッター
    sec = d.sections[0]
    hp = sec.header.paragraphs[0]; hp.text = f'SoilFlow 受入・請求管理システム（freee会計連携あり）　{title}'
    for r in hp.runs: r.font.size = Pt(8); r.font.color.rgb = RGBColor(0x5F, 0x66, 0x75)
    fp = sec.footer.paragraphs[0]; fp.alignment = 1
    run = fp.add_run(); f1 = OxmlElement('w:fldSimple'); f1.set(qn('w:instr'), 'PAGE'); run._r.append(f1)
    d.core_properties.title = title; d.core_properties.author = '有馬 順史'
    st = d.settings.element  # 開いたときに目次を更新する
    if st.find(qn('w:updateFields')) is None:
        u = OxmlElement('w:updateFields'); u.set(qn('w:val'), 'true'); st.append(u)
    d.save(path)


def main():
    os.makedirs(OUT, exist_ok=True)
    ref = os.path.join(ROOT, 'tools', 'reference.docx')
    make_reference(ref)
    mmdir = tempfile.mkdtemp(prefix='sf-mmd-')
    files = sorted(glob.glob(os.path.join(DOCS, '[0-9][0-9]_*.md'))) + sorted(glob.glob(os.path.join(DOCS, 'ledger', '*.md'))) + [os.path.join(DOCS, 'spec', 'er.md')]
    for f in files:
        md = open(f, encoding='utf-8').read()
        md = re.sub(r'```mermaid\n(.*?)```', lambda m: f'![]({render_mermaid(m.group(1), mmdir)})', md, flags=re.S)
        title = re.search(r'^# (.+)$', md, re.M).group(1)
        md = re.sub(r'^# .+\n', '', md, count=1, flags=re.M)
        name = os.path.splitext(os.path.basename(f))[0]
        if name == 'er': name = '07B_ER図'
        tmp = os.path.join(mmdir, name + '.md'); open(tmp, 'w', encoding='utf-8').write(md)
        out = os.path.join(OUT, name + '.docx')
        subprocess.run(['pandoc', tmp, '-f', 'gfm+pipe_tables', '-o', out, '--reference-doc', ref, '--resource-path', os.path.dirname(f), '--toc', '--toc-depth=2', '-M', f'title={title}', '-M', 'toc-title=目次', '--columns=200'], check=True)
        finish(out, title)
        print('ok', os.path.basename(out))


if __name__ == '__main__':
    main()
