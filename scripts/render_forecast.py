"""Compose a 3-day day/night forecast grid into one 1-bit PNG.

Input:  --spec forecast.json  (see shape below)   --out path.png
  {
    "width": 384,
    "days": [
      {"name":"Wed","dayGroup":"sun","hi":85,"nightGroup":"moon","lo":61},
      ...
    ]
  }
Icons are the pre-generated branding/weather/*.png, scaled to fit each row.
"""
import argparse
import json
from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
]

def font(size):
    for p in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()

def icon(group, target_h):
    im = Image.open(f"branding/weather/{group}.png").convert("L")
    w, h = im.size
    return im.resize((round(w * target_h / h), target_h), Image.LANCZOS)

def render(spec, out):
    W = spec.get("width", 384)
    days = spec["days"]
    f_cap, f_hdr, f_name, f_temp = font(26), font(16), font(23), font(24)

    header_h, colhdr_h, row_h, icon_h = 34, 24, 62, 44
    H = header_h + colhdr_h + row_h * len(days)
    img = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(img)

    cap = "3-DAY FORECAST"
    d.text(((W - d.textlength(cap, font=f_cap)) / 2, 4), cap, font=f_cap, fill=0)

    day_icon_x, day_temp_x = int(W * 0.30), int(W * 0.47)
    night_icon_x, night_temp_x = int(W * 0.66), int(W * 0.83)
    mid_x = int(W * 0.60)

    for label, cx in (("DAY", int(W * 0.40)), ("NIGHT", int(W * 0.78))):
        d.text((cx - d.textlength(label, font=f_hdr) / 2, header_h + 4), label, font=f_hdr, fill=0)

    y = header_h + colhdr_h
    for day in days:
        d.text((8, y + row_h / 2 - 13), day["name"], font=f_name, fill=0)

        di = icon(day["dayGroup"], icon_h)
        img.paste(di, (day_icon_x, y + (row_h - icon_h) // 2))
        d.text((day_temp_x, y + row_h / 2 - 13), f"{day['hi']}°", font=f_temp, fill=0)

        d.line([mid_x, y + 8, mid_x, y + row_h - 8], fill=0, width=1)

        ni = icon(day["nightGroup"], icon_h)
        img.paste(ni, (night_icon_x, y + (row_h - icon_h) // 2))
        d.text((night_temp_x, y + row_h / 2 - 13), f"{day['lo']}°", font=f_temp, fill=0)

        d.line([0, y + row_h - 1, W, y + row_h - 1], fill=0, width=1)
        y += row_h

    img.convert("1", dither=Image.NONE).save(out)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    with open(a.spec) as fh:
        render(json.load(fh), a.out)
