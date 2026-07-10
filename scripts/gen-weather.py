"""Pre-generate bitmap weather icons -> branding/weather/<group>.png (1-bit).

Simple filled silhouettes drawn at 4x and downsampled for smooth edges, then
thresholded for crisp thermal printing. Groups match src/weatherArt.ts.
Run:  python3 scripts/gen-weather.py
"""
import os
from PIL import Image, ImageDraw

S = 4                      # supersample factor
W, H = 176, 132            # final icon size (dots)
OUT = "branding/weather"
os.makedirs(OUT, exist_ok=True)

def canvas():
    return Image.new("L", (W * S, H * S), 255), None

def draw_cloud(d, cx, cy, scale=1.0, fill=0):
    """Classic cloud silhouette centered at (cx,cy): flat bottom + 3 bumps on top."""
    wc = int(120 * scale * S)
    hc = int(wc * 0.52)
    bottom = cy + hc // 2
    top = cy - hc // 2
    # flat rounded base
    d.rounded_rectangle([cx - wc // 2, cy, cx + wc // 2, bottom], radius=int(10 * S), fill=fill)
    # bumps
    lr = int(wc * 0.22)
    d.ellipse([cx - int(wc * 0.42), cy - lr, cx - int(wc * 0.42) + 2 * lr, cy + lr], fill=fill)
    cr = int(wc * 0.30)
    d.ellipse([cx - cr, top, cx + cr, top + 2 * cr], fill=fill)
    rr = int(wc * 0.24)
    d.ellipse([cx + int(wc * 0.18), cy - rr, cx + int(wc * 0.18) + 2 * rr, cy + rr], fill=fill)
    return bottom

def draw_sun(d, cx, cy, r, rays=True):
    if rays:
        import math
        for k in range(8):
            a = k * math.pi / 4
            x1, y1 = cx + math.cos(a) * r * 1.4, cy + math.sin(a) * r * 1.4
            x2, y2 = cx + math.cos(a) * r * 2.1, cy + math.sin(a) * r * 2.1
            d.line([x1, y1, x2, y2], fill=0, width=int(9 * S))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=0)

def draw_moon(d, cx, cy, r):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=0)
    off = int(r * 0.75)
    d.ellipse([cx - r + off, cy - r - int(r * 0.25), cx + r + off, cy + r - int(r * 0.25)], fill=255)

SHRINK = 0.85   # shrink the printed current-conditions icon ~15% (uniform, keeps margins)

def save(img, name):
    tw, th = round(W * SHRINK), round(H * SHRINK)
    img = img.resize((tw, th), Image.LANCZOS).point(lambda x: 255 if x >= 128 else 0, "L")
    img.convert("1", dither=Image.NONE).save(f"{OUT}/{name}.png")

def make(name):
    img, _ = canvas()
    d = ImageDraw.Draw(img)
    cx, cy = W * S // 2, H * S // 2

    if name == "sun":
        draw_sun(d, cx, cy, int(42 * S))
    elif name == "moon":
        draw_moon(d, cx, cy, int(52 * S))
    elif name == "cloud":
        draw_cloud(d, cx, cy)
    elif name == "partly-day":
        draw_sun(d, cx - int(34 * S), cy - int(30 * S), int(26 * S))
        draw_cloud(d, cx + int(14 * S), cy + int(12 * S), 0.78)
    elif name == "partly-night":
        draw_moon(d, cx - int(30 * S), cy - int(28 * S), int(30 * S))
        draw_cloud(d, cx + int(14 * S), cy + int(12 * S), 0.78)
    elif name == "fog":
        draw_cloud(d, cx, cy - int(20 * S), 0.82)
        for i in range(3):
            yy = cy + int((14 + i * 20) * S)
            d.rounded_rectangle([int(W * S * 0.16), yy, int(W * S * (0.84 - i * 0.05)), yy + int(9 * S)],
                                radius=int(5 * S), fill=0)
    elif name in ("drizzle", "rain"):
        bottom = draw_cloud(d, cx, cy - int(18 * S), 0.9)
        n = 3 if name == "drizzle" else 5
        for k in range(n):
            x = int(W * S * (0.28 + k * (0.44 / max(1, n - 1))))
            d.line([x, bottom + int(8 * S), x - int(12 * S), bottom + int(38 * S)],
                   fill=0, width=int(6 * S))
    elif name == "snow":
        bottom = draw_cloud(d, cx, cy - int(18 * S), 0.9)
        base = bottom + int(26 * S)
        for k in range(3):
            x = int(W * S * (0.30 + k * 0.20))
            r = int(11 * S)
            for a, b, c, e in [(-r, 0, r, 0), (0, -r, 0, r), (-r, -r, r, r), (-r, r, r, -r)]:
                d.line([x + a, base + b, x + c, base + e], fill=0, width=int(4 * S))
    elif name == "storm":
        bottom = draw_cloud(d, cx, cy - int(18 * S), 0.9)
        bx, by = cx - int(4 * S), bottom + int(4 * S)
        d.polygon([
            (bx, by), (bx + int(30 * S), by), (bx + int(8 * S), by + int(30 * S)),
            (bx + int(26 * S), by + int(30 * S)), (bx - int(14 * S), by + int(72 * S)),
            (bx, by + int(36 * S)), (bx - int(18 * S), by + int(36 * S)),
        ], fill=0)
    else:
        raise SystemExit(f"unknown group {name}")

    save(img, name)

GROUPS = ["sun", "moon", "partly-day", "partly-night", "cloud", "fog", "drizzle", "rain", "snow", "storm"]
for g in GROUPS:
    make(g)
print(f"wrote {len(GROUPS)} icons to {OUT}/")
