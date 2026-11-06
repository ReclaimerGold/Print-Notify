"""Compose the rich weather panel into one 1-bit PNG:

  - a 2-hourly temperature line graph for the next ~24 hours, and
  - a sun & moon row (sunrise / sunset / day length + a drawn moon-phase disc),
  - a compact humidity / UV / air-quality / pollen stats block.

Input:  --spec weather.json   --out path.png
  {
    "width": 504,
    "heading": "NEXT 24 HOURS",
    "hourly": [{"label":"9a","temp":72}, ...],
    "hi": 82, "lo": 58,
    "sun": {"sunrise":"5:57 AM","sunset":"9:07 PM"},
    "daylight": "14h 08m  ·  2m 32s shorter",
    "moon": {"name":"Waxing Gibbous","illum":0.78,"waxing":true},
    "humidity": 55, "uv": 6,
    "aqi": 39, "aqiCategory": "Good", "pm25": 5.3,
    "pollen": {"grass": 12, "tree": 0, "ragweed": 4}
  }

Every field below "sun" is optional — the panel drops any line it has no data
for, so a point outside the pollen model's domain simply prints a shorter panel.
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
    ctext(d, x0 + W / 2, y0, spec.get("heading") or "NEXT 24 HOURS", f_cap)
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

    # left: sunrise / sunset / day length stacked
    lx = x0 + 8
    if sun.get("sunrise"):
        d.text((lx, y + 2), f"Sunrise  {sun['sunrise']}", font=f_lbl, fill=0)
    if sun.get("sunset"):
        d.text((lx, y + 26), f"Sunset   {sun['sunset']}", font=f_lbl, fill=0)
    # Day length plus how it moved since yesterday — the delta is what you feel.
    if spec.get("daylight"):
        d.text((lx, y + 51), f"Daylight  {spec['daylight']}", font=f_sub, fill=0)

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
    return y + (72 if spec.get("daylight") else 56)

def stat_lines(spec):
    """The centered footer rows: conditions, then air, then pollen. Each row is
    omitted entirely when it has nothing in it."""
    rows = []

    bits = []
    if spec.get("humidity") is not None:
        bits.append(f"Humidity {spec['humidity']}%")
    if spec.get("uv") is not None:
        bits.append(f"UV {spec['uv']}")
    if bits:
        rows.append("     ·     ".join(bits))

    air = []
    if spec.get("aqi") is not None:
        cat = spec.get("aqiCategory")
        air.append(f"AQI {spec['aqi']}" + (f" ({cat})" if cat else ""))
    if spec.get("pm25") is not None:
        air.append(f"PM2.5 {spec['pm25']}")
    if air:
        rows.append("     ·     ".join(air))

    # Pollen is a European-model product; outside its domain every count is null
    # and this row never appears. Zero counts are dropped too — "Grass 0" is noise.
    pollen = spec.get("pollen") or {}
    grains = [(lbl, pollen.get(k)) for k, lbl in
              (("tree", "Tree"), ("grass", "Grass"), ("ragweed", "Ragweed"))]
    shown = [f"{lbl} {v:g}" for lbl, v in grains if v]
    if shown:
        rows.append("Pollen   " + "     ·     ".join(shown))

    return rows


def render(spec, out):
    W = spec.get("width", 504)
    rows = stat_lines(spec)
    H = 150 + 90 + 26 * (len(rows) + 1)
    img = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(img)

    y = draw_graph(img, d, spec, 0, 4, W, 150)
    d.line([8, y, W - 8, y], fill=0, width=1)   # divider
    y = draw_sun_moon(img, d, spec, 0, y + 8, W)

    f_stat = font(16, False)
    for row in rows:
        ctext(d, W / 2, y + 4, row, f_stat)
        y += 24
    if rows:
        y += 2

    img.crop((0, 0, W, min(H, y + 4))).convert("1", dither=Image.NONE).save(out)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    with open(a.spec) as fh:
        render(json.load(fh), a.out)
