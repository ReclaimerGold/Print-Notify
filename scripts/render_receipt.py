"""Compose a full receipt preview PNG from an ordered block spec (stdin/--spec).

Mirrors what actually prints: bitmap blocks are pasted as-is; text blocks are
rendered in a monospace font and hard-wrapped at the printer's column count, so
the preview matches the thermal output line-for-line.

Spec JSON:
  { "width":384, "margin":18, "chars":42, "blocks":[
      {"type":"image","path":"...","align":"center"},
      {"type":"text","text":"...","bold":false,"align":"left"},
      {"type":"rule"},
      {"type":"space"}
  ]}
"""
import argparse
import json
from PIL import Image, ImageDraw, ImageFont

MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONO_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
FALLBACK = "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf"

def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.truetype(FALLBACK, size)

def hard_wrap(text, n):
    """Wrap like a thermal printer: break at column n (mid-word if needed)."""
    if text == "":
        return [""]
    out = []
    for para in text.split("\n"):
        while len(para) > n:
            out.append(para[:n])
            para = para[n:]
        out.append(para)
    return out

def render(spec, out):
    W = spec.get("width", 384)
    margin = spec.get("margin", 18)
    chars = spec.get("chars", 42)
    size = max(10, round(W / chars / 0.6))  # size so `chars` glyphs ≈ W wide
    f_reg, f_bold = font(MONO, size), font(MONO_BOLD, size)
    line_h = round(size * 1.35)
    canvas_w = W + margin * 2

    # --- pass 1: build strips (each a list of (kind, payload)) and total height ---
    strips = []
    for b in spec["blocks"]:
        t = b["type"]
        if t == "image":
            im = Image.open(b["path"]).convert("L")
            if im.width > W:
                im = im.resize((W, round(im.height * W / im.width)), Image.LANCZOS)
            strips.append(("image", im, b.get("align", "center")))
        elif t == "text":
            for line in hard_wrap(b.get("text", ""), chars):
                strips.append(("text", line, b.get("bold", False), b.get("align", "left")))
        elif t == "rule":
            strips.append(("text", "-" * chars, False, "left"))
        elif t == "space":
            strips.append(("space", None))

    total_h = margin
    for s in strips:
        total_h += s[1].height + 4 if s[0] == "image" else (line_h if s[0] == "text" else line_h // 2)
    total_h += margin

    # --- pass 2: paint ---
    img = Image.new("L", (canvas_w, total_h), 255)
    d = ImageDraw.Draw(img)
    y = margin
    for s in strips:
        if s[0] == "image":
            im, align = s[1], s[2]
            x = margin + (W - im.width) // 2 if align == "center" else margin
            img.paste(im, (x, y))
            y += im.height + 4
        elif s[0] == "text":
            line, bold, align = s[1], s[2], s[3]
            fnt = f_bold if bold else f_reg
            w = d.textlength(line, font=fnt)
            x = margin + (W - w) / 2 if align == "center" else margin
            d.text((x, y), line, font=fnt, fill=0)
            y += line_h
        else:
            y += line_h // 2

    img.convert("1", dither=Image.NONE).save(out)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    with open(a.spec) as fh:
        render(json.load(fh), a.out)
