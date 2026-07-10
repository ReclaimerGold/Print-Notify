"""Render a single receipt text element to a 1-bit PNG for ESC/POS raster print.

Usage:  python3 scripts/render.py --style STYLE --width W --out PATH --text "..."
Styles:
  title    large bold, black-on-white, centered
  section  bold white-on-black bar, full width (classic receipt section header)
"""
import argparse
from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
]

def load_font(size):
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()

def text_size(font, text):
    l, t, r, b = font.getbbox(text)
    return r - l, b - t, l, t

def render(style, text, width, out):
    if style == "title":
        font = load_font(34)
        pad = 6
        tw, th, ox, oy = text_size(font, text)
        h = th + pad * 2
        img = Image.new("L", (width, h), 255)
        d = ImageDraw.Draw(img)
        d.text(((width - tw) // 2 - ox, pad - oy), text, font=font, fill=0)
    elif style == "section":
        font = load_font(26)
        pad_x, pad_y = 10, 5
        tw, th, ox, oy = text_size(font, text)
        h = th + pad_y * 2
        img = Image.new("L", (width, h), 0)  # black bar
        d = ImageDraw.Draw(img)
        d.text((pad_x - ox, pad_y - oy), text, font=font, fill=255)  # white text
    else:
        raise SystemExit(f"unknown style: {style}")

    img.convert("1", dither=Image.NONE).save(out)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--style", required=True)
    ap.add_argument("--text", required=True)
    ap.add_argument("--width", type=int, default=384)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    render(a.style, a.text, a.width, a.out)
