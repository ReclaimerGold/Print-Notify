"""Render a digest section's items (news, calendar, …) to a 1-bit PNG with a
strong, scannable typographic hierarchy — proportional fonts, a bold primary
line that word-wraps, and a non-bold metadata subline — matching the checklist
look so the whole receipt reads as one system.

Generic row model (each item):
  {
    "left":    "9:00a",          # optional bold left-column label (e.g. a time)
    "primary": "Standup",        # bold, word-wrapped main text
    "sub":     "until 9:30a"     # optional non-bold metadata subline
  }

Spec (--spec file):
  { "width":504, "divider":true, "items":[ {row}, ... ] }

`divider` draws a light dashed hairline between items (good for separating news
stories). When any item has `left`, all primaries align in a shared column.
"""
import argparse
import json
from PIL import Image, ImageDraw, ImageFont

BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FB_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
FB_REG = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
SYMBOL = "/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf"  # per-row marker icons

PRIMARY = 19       # bold headline / event title
SUB = 13           # non-bold metadata subline
LEFTPT = 18        # bold left-column label (time)
MARGIN = 12
PRIMARY_LH = int(PRIMARY * 1.16)
SUB_LH = int(SUB * 1.30)
ITEM_GAP = 12      # vertical gap between items
LEFT_PAD = 16      # gap after the left column
BULLET = "▪"  # ▪ marker for left-less lists (news)

def font(path, fb, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.truetype(fb, size)

def try_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return None

def wrap(d, text, f, maxw):
    """Greedy word wrap; falls back to hard-breaking any single word too wide."""
    lines, cur = [], ""
    for w in text.split():
        t = (cur + " " + w).strip()
        if d.textlength(t, font=f) <= maxw or not cur:
            # a lone word wider than maxw is hard-split so it never overflows
            if not cur and d.textlength(w, font=f) > maxw:
                piece = ""
                for ch in w:
                    if d.textlength(piece + ch, font=f) <= maxw:
                        piece += ch
                    else:
                        lines.append(piece)
                        piece = ch
                cur = piece
            else:
                cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines or [""]

def dashed(d, x0, x1, y, seg=5, gap=5):
    x = x0
    while x < x1:
        d.line([x, y, min(x + seg, x1), y], fill=0, width=1)
        x += seg + gap

def render(spec, out):
    W = spec.get("width", 504)
    items = spec.get("items", [])
    divider = spec.get("divider", False)
    f_pri = font(BOLD, FB_BOLD, PRIMARY)
    f_sub = font(REG, FB_REG, SUB)
    f_left = font(BOLD, FB_BOLD, LEFTPT)

    # Row marker glyphs (e.g. GitHub reason icons) may live in different fonts:
    # the symbol font carries ◉ ● 🗨, DejaVu carries @ ⚙ …. Pick, per glyph, the
    # first font that actually contains it (skipping blanks and .notdef boxes).
    marker_fonts = [f for f in (try_font(SYMBOL, PRIMARY), try_font(BOLD, PRIMARY),
                                try_font(FB_BOLD, PRIMARY), try_font(REG, PRIMARY)) if f]
    REF_MISSING = ""  # private-use codepoint -> .notdef in any font

    def icon_font(ch):
        for f in marker_fonts:
            m = f.getmask(ch)
            if not m.getbbox():
                continue  # blank glyph = not present
            ref = f.getmask(REF_MISSING)
            if ref.getbbox() and (m.size, bytes(m)) == (ref.size, bytes(ref)):
                continue  # rendered as the .notdef box = not present
            return f
        return f_pri

    img = Image.new("L", (W, 8000), 255)
    d = ImageDraw.Draw(img)

    # Per-row marker: a custom icon glyph (best-covering font) or the default bullet.
    def marker(it):
        ic = it.get("icon")
        return (ic, icon_font(ic)) if ic else (BULLET, f_pri)

    has_left = any(it.get("left") for it in items)
    if has_left:
        left_w = int(max(d.textlength(it.get("left", ""), font=f_left) for it in items)) + LEFT_PAD
        x_text = MARGIN + left_w
    else:
        # Reserve the marker column from the widest marker so all primaries align.
        widths = [d.textlength(mc, font=mf) for mc, mf in (marker(it) for it in items)]
        bw = int(max(widths)) if widths else int(d.textlength(BULLET, font=f_pri))
        x_text = MARGIN + bw + 10
    tw = W - x_text - MARGIN

    y = 6
    for idx, it in enumerate(items):
        top = y
        if has_left:
            if it.get("left"):
                d.text((MARGIN, top), it["left"], font=f_left, fill=0)
        else:
            mc, mf = marker(it)
            d.text((MARGIN, top + 2), mc, font=mf, fill=0)

        lines = wrap(d, it.get("primary", ""), f_pri, tw)
        for i, ln in enumerate(lines):
            d.text((x_text, top + i * PRIMARY_LH), ln, font=f_pri, fill=0)
        y = top + len(lines) * PRIMARY_LH

        if it.get("sub"):
            d.text((x_text, y + 1), it["sub"], font=f_sub, fill=0)
            y += SUB_LH + 1

        y += ITEM_GAP
        if divider and idx < len(items) - 1:
            dashed(d, MARGIN, W - MARGIN, y - ITEM_GAP // 2)

    img = img.crop((0, 0, W, y + 2))
    img.point(lambda v: 255 if v >= 128 else 0, "L").convert("1").save(out)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    with open(a.spec) as fh:
        render(json.load(fh), a.out)
