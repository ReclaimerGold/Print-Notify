"""Compose the rich weather panel into one 1-bit PNG:

  - a 2-hourly temperature line graph for the next ~24 hours, and
  - a sun & moon row (sunrise / sunset + a drawn moon-phase disc + phase name),
  - a compact humidity / UV stats line.

Input:  --spec weather.json   --out path.png
  {
    "width": 504,
    "hourly": [{"label":"9a","temp":72}, ...],
    "hi": 82, "lo": 58,
    "sun": {"sunrise":"5:57 AM","sunset":"9:07 PM"},
    "moon": {"name":"Waxing Gibbous","illum":0.78,"waxing":true},
    "humidity": 55, "uv": 6
  }
"""
import argparse
import json
import math
from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
]
FONT_REG = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
]

def font(size, bold=True):
    for p in (FONT_CANDIDATES if bold else FONT_REG):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()

def ctext(d, cx, y, s, f, fill=0):
    d.text((cx - d.textlength(s, font=f) / 2, y), s, font=f, fill=fill)

def draw_graph(img, d, spec, x0, y0, W, H):
    pts = spec.get("hourly", [])
    f_cap = font(24)
    ctext(d, x0 + W / 2, y0, "NEXT 24 HOURS", f_cap)
    top = y0 + 34
    if len(pts) < 2:
        d.text((x0, top), "hourly data unavailable", font=font(18, False), fill=0)
        return top + 24

    f_temp = font(15)
    f_time = font(15, False)
    temps = [p["temp"] for p in pts]
    tmin, tmax = min(temps), max(temps)
    span = max(1, tmax - tmin)

    pad_l, pad_r = 20, 20
    label_top = 20          # room for temp labels above points
    axis_h = 20             # room for time labels below
    plot_top = top + label_top
    plot_h = H - 34 - label_top - axis_h
    plot_bot = plot_top + plot_h
    plot_l = x0 + pad_l
    plot_w = W - pad_l - pad_r
    n = len(pts)
    xs = [plot_l + (plot_w * i / (n - 1)) for i in range(n)]
    ys = [plot_bot - plot_h * (pts[i]["temp"] - tmin) / span for i in range(n)]

    # baseline
    d.line([plot_l, plot_bot + 1, plot_l + plot_w, plot_bot + 1], fill=0, width=1)
    # the temperature curve
    d.line(list(zip(xs, ys)), fill=0, width=3, joint="curve")
    for i in range(n):
        x, y = xs[i], ys[i]
        d.ellipse([x - 3, y - 3, x + 3, y + 3], fill=0)
        # temp value above each point
        ctext(d, x, y - 19, f"{pts[i]['temp']}", f_temp)
        # time label below every other point
        if i % 2 == 0:
            ctext(d, x, plot_bot + 3, pts[i]["label"], f_time)
    return plot_bot + axis_h + 6

def draw_moon(img, cx, cy, r, illum, waxing):
    # dark disc, then paint the lit fraction white, then a crisp outline
    dd = ImageDraw.Draw(img)
    dd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=0)
    for dy in range(-r, r + 1):
        w = math.sqrt(max(0, r * r - dy * dy))
        t = (1 - 2 * illum) * w          # terminator offset from center
        y = cy + dy
        if waxing:                        # lit on the right
            x1, x2 = cx + t, cx + w
        else:                             # lit on the left
            x1, x2 = cx - w, cx - t
        if x2 > x1:
            dd.line([x1, y, x2, y], fill=255, width=1)
    dd.ellipse([cx - r, cy - r, cx + r, cy + r], outline=0, width=2)

def draw_sun_moon(img, d, spec, x0, y, W):
    sun = spec.get("sun") or {}
    moon = spec.get("moon") or {}
    f_lbl = font(17)
    f_sub = font(15, False)

    # left: sunrise / sunset stacked
    lx = x0 + 8
    if sun.get("sunrise"):
        d.text((lx, y + 2), f"Sunrise  {sun['sunrise']}", font=f_lbl, fill=0)
    if sun.get("sunset"):
        d.text((lx, y + 26), f"Sunset   {sun['sunset']}", font=f_lbl, fill=0)

    # right: moon disc + phase name + illumination, right-aligned so the longest
    # phase name ("Waning Crescent") always fits within the paper width.
    name = moon.get("name", "")
    illum_str = f"{round(float(moon.get('illum', 0)) * 100)}% lit"
    tw = max(d.textlength(name, font=f_lbl), d.textlength(illum_str, font=f_sub))
    tx = x0 + W - 8 - tw
    r = 26
    cx = tx - 14 - r
    cy = y + 28
    draw_moon(img, cx, cy, r, float(moon.get("illum", 0)), bool(moon.get("waxing", True)))
    d.text((tx, y + 6), name, font=f_lbl, fill=0)
    d.text((tx, y + 28), illum_str, font=f_sub, fill=0)
    return y + 56

def render(spec, out):
    W = spec.get("width", 504)
    H = 150 + 70 + 26
    img = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(img)

    y = draw_graph(img, d, spec, 0, 4, W, 150)
    d.line([8, y, W - 8, y], fill=0, width=1)   # divider
    y = draw_sun_moon(img, d, spec, 0, y + 8, W)

    # humidity / UV footer
    bits = []
    if spec.get("humidity") is not None:
        bits.append(f"Humidity {spec['humidity']}%")
    if spec.get("uv") is not None:
        bits.append(f"UV {spec['uv']}")
    if bits:
        ctext(d, W / 2, y + 4, "     ·     ".join(bits), font(16, False))
        y += 26

    img.crop((0, 0, W, min(H, y + 4))).convert("1", dither=Image.NONE).save(out)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    with open(a.spec) as fh:
        render(json.load(fh), a.out)
