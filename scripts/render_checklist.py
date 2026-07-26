"""Compose a compact, pen-checkable checklist into one 1-bit PNG.

Real open-square checkboxes + bold text; short-item sections (e.g. groceries)
can flow into 2 columns. Input spec (--spec file):

  { "width":384, "title":"FERRIX CHECKLIST", "date":"Fri, Jul 10",
    "sections":[
      {"name":"TASKS","columns":1,"items":[{"text":"...","checked":false}, ...]},
      {"name":"GROCERIES","columns":2,"items":[...]}
    ] }
"""
import argparse
import json
from PIL import Image, ImageDraw, ImageFont

BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FALLBACK = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FALLBACK_REG = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"

# Dense layout constants (tweak here to re-tune density).
ITEM = 17          # item font size
BOX = 22           # checkbox square size
GAP = 8            # vertical gap between items
LINE = int(ITEM * 1.18)
MARGIN = 10
DUE = 13           # due-date subline font size (non-bold)
DUE_LINE = int(DUE * 1.25)
OVERDUE_MARK = "(!) "   # prefix on past-due items

# Section header bar — kept identical to scripts/render.py style "section" so
# TASKS/GROCERIES match the WEATHER/NEWS/CALENDAR headings in the digest.
SEC_PT = 26        # section-bar font size
SEC_PAD_X = 10
SEC_PAD_Y = 5

def font(size):
    try:
        return ImageFont.truetype(BOLD, size)
    except OSError:
        return ImageFont.truetype(FALLBACK, size)

def font_regular(size):
    try:
        return ImageFont.truetype(REGULAR, size)
    except OSError:
        return ImageFont.truetype(FALLBACK_REG, size)

def section_bar(d, y, text, W):
    """Full-width white-on-black section bar (matches render.py 'section')."""
    f = font(SEC_PT)
    l, t, r, b = f.getbbox(text)
    h = (b - t) + SEC_PAD_Y * 2
    d.rectangle([0, y, W, y + h], fill=0)
    d.text((SEC_PAD_X - l, y + SEC_PAD_Y - t), text, font=f, fill=255)
    return y + h

def wrap(d, text, f, maxw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if d.textlength(t, font=f) <= maxw:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines or [""]

def render(spec, out):
    W = spec.get("width", 384)
    f_title, f_date, f_item = font(20), font(13), font(ITEM)
    f_due, f_mark = font_regular(DUE), font(DUE + 2)  # non-bold date, bold (!) marker
    img = Image.new("L", (W, 4000), 255)
    d = ImageDraw.Draw(img)
    y = 8

    # --- lean header: wordmark + date + rule (padded, not touching) ---
    if spec.get("title"):
        d.text(((W - d.textlength(spec["title"], font=f_title)) / 2, y), spec["title"], font=f_title, fill=0)
        y = d.textbbox((0, y), spec["title"], font=f_title)[3] + 4
    if spec.get("date"):
        d.text(((W - d.textlength(spec["date"], font=f_date)) / 2, y), spec["date"], font=f_date, fill=0)
        y = d.textbbox((0, y), spec["date"], font=f_date)[3] + 6
    # Rule only under a real header (standalone print). The digest embeds the
    # checklist with no header, so it goes straight to the first section bar.
    if spec.get("title") or spec.get("date"):
        d.line([12, y, W - 12, y], fill=0, width=2)
        y += 12

    def draw_box(x, yy, checked):
        d.rounded_rectangle([x, yy, x + BOX, yy + BOX], radius=4, outline=0, width=3)
        if checked:
            i = 5
            d.line([x + i, yy + i, x + BOX - i, yy + BOX - i], fill=0, width=3)
            d.line([x + i, yy + BOX - i, x + BOX - i, yy + i], fill=0, width=3)

    for sec in spec["sections"]:
        # section header: full-width white-on-black bar with a count, identical
        # to the digest's other section headings (WEATHER, NEWS, CALENDAR).
        label = f'{sec["name"]}  ({len(sec["items"])})'
        y = section_bar(d, y, label, W) + 9   # gap below bar, above items

        items = sec["items"]
        cols = max(1, sec.get("columns", 1))
        if cols == 1:
            tx = MARGIN + BOX + 12
            tw = W - tx - 12
            for it in items:
                # Reserve room on the right for an inline price estimate, so a
                # long item name wraps instead of colliding with the price.
                price = it.get("price")
                pricew = d.textlength(price, font=f_item) if price else 0
                avail = tw - (pricew + 10) if price else tw
                lines = wrap(d, it["text"], f_item, avail)
                draw_box(MARGIN, y + 1, it.get("checked"))
                oy = y + (BOX - ITEM) // 2 - 2
                for i, ln in enumerate(lines):
                    d.text((tx, oy + i * LINE), ln, font=f_item, fill=0)
                if price:
                    d.text((W - 12 - pricew, oy), price, font=f_item, fill=0)
                y += max(BOX + 2, len(lines) * LINE)
                # non-bold due-date subline; bold (!) marks past-due items
                if it.get("due"):
                    x = tx
                    if it.get("overdue"):
                        d.text((x, y - 3), OVERDUE_MARK, font=f_mark, fill=0)
                        x += d.textlength(OVERDUE_MARK, font=f_mark)
                    d.text((x, y - 2), it["due"], font=f_due, fill=0)
                    y += DUE_LINE
                y += GAP
        else:
            cw = (W - 2 * MARGIN) // cols
            rows = (len(items) + cols - 1) // cols
            for r in range(rows):
                for c in range(cols):
                    idx = r * cols + c
                    if idx >= len(items):
                        continue
                    x0 = MARGIN + c * cw
                    it = items[idx]
                    draw_box(x0, y + 1, it.get("checked"))
                    d.text((x0 + BOX + 8, y + (BOX - ITEM) // 2 - 2), it["text"], font=f_item, fill=0)
                y += BOX + GAP

        # Optional right-aligned section total (e.g. "Est. total ~$8.90 · Sioux Falls").
        total = sec.get("total")
        if total:
            y += 3
            d.text((W - 12 - d.textlength(total, font=f_mark), y), total, font=f_mark, fill=0)
            y += int((DUE + 2) * 1.25)
        y += 7

    img.crop((0, 0, W, y)).point(lambda x: 255 if x >= 128 else 0, "L").convert("1").save(out)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    with open(a.spec) as fh:
        render(json.load(fh), a.out)
