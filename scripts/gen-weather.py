"""Pre-generate 3-D shaded weather icons -> branding/weather/<group>.png (1-bit).

Unlike a flat silhouette, each icon is built as volumetric grayscale artwork —
spheres/ellipsoids lit from the upper-left with highlights, core shadows, limb
darkening and surface texture — then Floyd-Steinberg dithered to 1-bit so the
shading survives as dot patterns on the thermal printer. A thin keyline is added
around the outer silhouette so light cloud tops don't dissolve on the print.
Groups match src/weatherArt.ts.
Run:  python3 scripts/gen-weather.py           (writes branding/weather/*.png)
      python3 scripts/gen-weather.py OUT --preview   (also dumps *_gray.png)
"""
import math, random, os, sys
from PIL import Image

W, H = 176, 132           # art size (pre-shrink), matches the printed icon size
SS = 3                    # supersample for smooth shading + AA edges
CW, CH = W * SS, H * SS
SHRINK = 0.85             # shrink the printed icon ~15% (keeps margins)
PREVIEW = "--preview" in sys.argv
_args = [a for a in sys.argv[1:] if not a.startswith("-")]
OUT = _args[0] if _args else "branding/weather"
os.makedirs(OUT, exist_ok=True)

# light from upper-left, slightly toward viewer
_L = (-0.50, -0.62, 0.60)
_n = math.sqrt(sum(c * c for c in _L)); LIGHT = tuple(c / _n for c in _L)

def new_buf():
    return [[255.0] * CW for _ in range(CH)]

def clamp(v, a=0.0, b=255.0):
    return a if v < a else b if v > b else v

def blend(buf, x, y, val, a):
    if 0 <= x < CW and 0 <= y < CH and a > 0:
        c = buf[y][x]
        buf[y][x] = c + (val - c) * (a if a < 1 else 1)

def ellipsoid(buf, cx, cy, rx, ry, lo, hi, spec=0.0, rim=0.30,
              texture=0.0, seed=0, light=LIGHT, ambient=0.0):
    """Shaded ellipsoid (sphere if rx==ry). lo/hi = dark/lit luminance."""
    cx *= SS; cy *= SS; rx *= SS; ry *= SS
    rnd = random.Random(seed)
    x0, x1 = int(cx - rx - 2), int(cx + rx + 3)
    y0, y1 = int(cy - ry - 2), int(cy + ry + 3)
    rmin = min(rx, ry)
    for y in range(max(0, y0), min(CH, y1)):
        for x in range(max(0, x0), min(CW, x1)):
            nx = (x + 0.5 - cx) / rx
            ny = (y + 0.5 - cy) / ry
            d2 = nx * nx + ny * ny
            if d2 > 1.0 + 3.0 / rmin:
                continue
            d = math.sqrt(d2)
            cov = clamp((1.0 - d) * rmin + 0.5, 0.0, 1.0)
            if cov <= 0:
                continue
            z = math.sqrt(max(0.0, 1.0 - min(d2, 1.0)))
            lamb = max(0.0, nx * light[0] + ny * light[1] + z * light[2])
            val = lo + (hi - lo) * (ambient + (1 - ambient) * lamb)
            val -= rim * (hi - lo) * d2               # limb darkening
            if spec:                                   # specular highlight
                val += spec * (max(0.0, lamb) ** 12)
            if texture:
                val += (rnd.random() - 0.5) * texture
            blend(buf, x, y, clamp(val), cov)

def sphere(buf, cx, cy, r, lo, hi, **kw):
    ellipsoid(buf, cx, cy, r, r, lo, hi, **kw)

def cloud(buf, cx, cy, scale=1.0, dark=False, seed=1):
    """Fluffy cumulus: shadowed base slab + overlapping lit puffs."""
    if dark:
        lo, hi, blo, bhi = 22, 120, 12, 60
    else:
        lo, hi, blo, bhi = 96, 252, 70, 175
    s = scale
    # base slab (flatter, darker underside)
    ellipsoid(buf, cx, cy + 12 * s, 60 * s, 22 * s, blo, bhi, rim=0.35,
              texture=10 if not dark else 6, seed=seed, ambient=0.15)
    # puffs back-to-front
    puffs = [
        (cx - 34 * s, cy + 2 * s, 22 * s),
        (cx + 32 * s, cy + 4 * s, 24 * s),
        (cx - 4 * s,  cy - 18 * s, 31 * s),
        (cx + 14 * s, cy + 6 * s, 21 * s),
        (cx - 20 * s, cy + 8 * s, 18 * s),
    ]
    for i, (px, py, r) in enumerate(puffs):
        sphere(buf, px, py, r, lo, hi, rim=0.40, spec=70 if not dark else 40,
               texture=14 if not dark else 8, seed=seed * 10 + i, ambient=0.12)
    return cy + 12 * s + 22 * s   # approx bottom y (art units)

def sun(buf, cx, cy, r, rays=True):
    if rays:
        for k in range(12):
            a = k * math.pi / 6
            ca, sa = math.cos(a), math.sin(a)
            r0, r1 = r * 1.12, r * 1.72
            w = r * 0.16
            # tapered ray as shaded quad (bright base near sun -> darker tip)
            bx, by = cx + ca * r0, cy + sa * r0
            tx, ty = cx + ca * r1, cy + sa * r1
            px, py = -sa, ca   # perpendicular
            _quad(buf,
                  (bx + px * w, by + py * w), (bx - px * w, by - py * w),
                  (tx - px * w * 0.35, ty - py * w * 0.35),
                  (tx + px * w * 0.35, ty + py * w * 0.35),
                  ca, sa)
    sphere(buf, cx, cy, r, 70, 252, spec=150, rim=0.22, texture=26, seed=7,
           ambient=0.25)

def _quad(buf, p1, p2, p3, p4, ca, sa):
    """Fill a quad with directional shading (lit if pointing up-left)."""
    xs = [p[0] for p in (p1, p2, p3, p4)]
    ys = [p[1] for p in (p1, p2, p3, p4)]
    x0, x1 = int(min(xs) * SS) - 1, int(max(xs) * SS) + 2
    y0, y1 = int(min(ys) * SS) - 1, int(max(ys) * SS) + 2
    poly = [(p[0] * SS, p[1] * SS) for p in (p1, p2, p3, p4)]
    # ray brightness from its direction vs light
    face = ca * LIGHT[0] + sa * LIGHT[1]
    val = clamp(150 + face * 90, 60, 235)
    for y in range(max(0, y0), min(CH, y1)):
        for x in range(max(0, x0), min(CW, x1)):
            if _in_poly(x + 0.5, y + 0.5, poly):
                blend(buf, x, y, val, 1.0)

def _in_poly(x, y, poly):
    inside = False
    n = len(poly); j = n - 1
    for i in range(n):
        xi, yi = poly[i]; xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-9) + xi):
            inside = not inside
        j = i
    return inside

def crescent(buf, cx, cy, r):
    """3-D crescent: sliver of a sphere, lit on the outer (left) edge + craters."""
    off = r * 0.62
    icx = cx + off              # inner (shadow) circle center, shifted right
    icy = cy - r * 0.10
    ir = r * 0.98
    cx3, cy3, r3, icx3, icy3, ir3 = (v * SS for v in (cx, cy, r, icx, icy, ir))
    x0, x1 = int(cx3 - r3 - 2), int(cx3 + r3 + 3)
    y0, y1 = int(cy3 - r3 - 2), int(cy3 + r3 + 3)
    light = (-0.7, -0.35, 0.6)
    ln = math.sqrt(sum(c * c for c in light)); light = tuple(c / ln for c in light)
    craters = [(-0.35, -0.25, 0.14), (-0.15, 0.30, 0.11), (-0.45, 0.10, 0.08)]
    for y in range(max(0, y0), min(CH, y1)):
        for x in range(max(0, x0), min(CW, x1)):
            nx = (x + 0.5 - cx3) / r3; ny = (y + 0.5 - cy3) / r3
            d2 = nx * nx + ny * ny
            if d2 > 1.0 + 3.0 / r3:
                continue
            d = math.sqrt(d2)
            cov = clamp((1.0 - d) * r3 + 0.5, 0.0, 1.0)
            idx = (x + 0.5 - icx3) / ir3; idy = (y + 0.5 - icy3) / ir3
            di = math.sqrt(idx * idx + idy * idy)
            cov = min(cov, clamp((di - 1.0) * ir3 + 0.5, 0.0, 1.0))  # subtract inner
            if cov <= 0:
                continue
            z = math.sqrt(max(0.0, 1.0 - min(d2, 1.0)))
            lamb = max(0.0, nx * light[0] + ny * light[1] + z * light[2])
            val = 60 + 195 * lamb - 0.30 * 195 * d2
            for (cxr, cyr, crr) in craters:      # shaded pits
                cd = math.sqrt((nx - cxr) ** 2 + (ny - cyr) ** 2)
                if cd < crr:
                    val -= (1 - cd / crr) * 70 * (1 - (ny - cyr) / crr * 0.5)
            blend(buf, x, y, clamp(val), cov)

def raindrop(buf, x, y, s=1.0, dark=False):
    r = 7 * s
    lo, hi = (20, 120) if dark else (60, 210)
    # round body
    sphere(buf, x, y, r, lo, hi, spec=170, rim=0.30, ambient=0.10, seed=int(x + y))
    # pointed top
    _quad(buf, (x - r * 0.7, y - r * 0.2), (x + r * 0.7, y - r * 0.2),
          (x + 0.3 * s, y - r * 2.4), (x - 0.3 * s, y - r * 2.4), -0.4, -0.9)
    # bright specular
    blend_disc(buf, x - r * 0.35, y - r * 0.3, r * 0.28, 245)

def blend_disc(buf, cx, cy, r, val):
    cx *= SS; cy *= SS; r *= SS
    x0, x1 = int(cx - r - 1), int(cx + r + 2)
    y0, y1 = int(cy - r - 1), int(cy + r + 2)
    for y in range(max(0, y0), min(CH, y1)):
        for x in range(max(0, x0), min(CW, x1)):
            d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
            cov = clamp((r - d) + 0.5, 0.0, 1.0)
            if cov > 0:
                blend(buf, x, y, val, cov)

def snowflake(buf, x, y, r, shadow=True):
    if shadow:
        _star(buf, x + 1.5, y + 1.5, r, 150, 2.2)   # soft drop shadow
    _star(buf, x, y, r, 30, 2.2)                     # dark crystal
    _star(buf, x, y, r * 0.9, 90, 1.1)               # lit core edge
    blend_disc(buf, x - r * 0.15, y - r * 0.15, r * 0.16, 235)

def _star(buf, cx, cy, r, val, wpx):
    for k in range(6):
        a = k * math.pi / 3
        _thick_line(buf, cx, cy, cx + math.cos(a) * r, cy + math.sin(a) * r, val, wpx)

def _thick_line(buf, x0, y0, x1, y1, val, wpx):
    x0 *= SS; y0 *= SS; x1 *= SS; y1 *= SS; w = wpx * SS / 2
    minx, maxx = int(min(x0, x1) - w - 1), int(max(x0, x1) + w + 2)
    miny, maxy = int(min(y0, y1) - w - 1), int(max(y0, y1) + w + 2)
    dx, dy = x1 - x0, y1 - y0
    L2 = dx * dx + dy * dy or 1
    for y in range(max(0, miny), min(CH, maxy)):
        for x in range(max(0, minx), min(CW, maxx)):
            t = clamp(((x - x0) * dx + (y - y0) * dy) / L2, 0, 1)
            px, py = x0 + t * dx, y0 + t * dy
            dist = math.hypot(x + 0.5 - px, y + 0.5 - py)
            cov = clamp((w - dist) + 0.5, 0.0, 1.0)
            if cov > 0:
                blend(buf, x, y, val, cov)

def bolt(buf, cx, cy):
    pts = [(cx, cy), (cx + 16, cy), (cx + 2, cy + 20),
           (cx + 14, cy + 20), (cx - 10, cy + 50),
           (cx, cy + 26), (cx - 12, cy + 26)]
    poly = [(p[0] * SS, p[1] * SS) for p in pts]
    xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
    for y in range(max(0, int(min(ys)) - 1), min(CH, int(max(ys)) + 2)):
        for x in range(max(0, int(min(xs)) - 1), min(CW, int(max(xs)) + 2)):
            if _in_poly(x + 0.5, y + 0.5, poly):
                # vertical gradient + left-lit highlight
                t = (y / SS - cy) / 50.0
                val = clamp(30 + 150 * (1 - t) - (x / SS - cx) * 3, 20, 235)
                blend(buf, x, y, val, 1.0)

def fog(buf, cx, cy):
    cloud(buf, cx, cy - 20, 0.82)
    for i in range(3):
        yy = cy + 12 + i * 16
        wobble = 4 * math.sin(i * 1.7)
        ellipsoid(buf, cx + wobble, yy, (58 - i * 6), 5.0, 90, 205,
                  rim=0.25, ambient=0.2, seed=i)

def bars_none():
    pass

# ---- compose each group ----
def render(name):
    buf = new_buf()
    cx, cy = W / 2, H / 2
    if name == "sun":
        sun(buf, cx, cy, 40)
    elif name == "moon":
        crescent(buf, cx + 6, cy, 50)
    elif name == "cloud":
        cloud(buf, cx, cy)
    elif name == "partly-day":
        sun(buf, cx - 30, cy - 26, 24)
        cloud(buf, cx + 16, cy + 12, 0.72)
    elif name == "partly-night":
        crescent(buf, cx - 26, cy - 22, 28)
        cloud(buf, cx + 16, cy + 12, 0.72)
    elif name == "fog":
        fog(buf, cx, cy)
    elif name in ("drizzle", "rain"):
        b = cloud(buf, cx, cy - 16, 0.92, dark=False)
        n = 3 if name == "drizzle" else 5
        for k in range(n):
            fx = W * (0.30 + k * (0.40 / max(1, n - 1)))
            raindrop(buf, fx, b + 14 + (k % 2) * 8, 1.1)
    elif name == "snow":
        b = cloud(buf, cx, cy - 16, 0.92)
        for k in range(3):
            fx = W * (0.30 + k * 0.20)
            snowflake(buf, fx, b + 22 + (k % 2) * 6, 11)
    elif name == "storm":
        b = cloud(buf, cx, cy - 18, 0.95, dark=True)
        bolt(buf, cx - 2, b + 2)
    else:
        raise SystemExit("unknown " + name)
    return buf

def add_outline(gray, thr=252, val=28):
    """Darken a thin ring around the OUTER silhouette so shapes stay crisp on the
    1-bit print. Only the exterior background is outlined (via a border flood
    fill), so interior specular highlights stay as clean shine, not donut rings."""
    w, h = gray.size
    px = gray.load()
    drawn = [[px[x, y] < thr for x in range(w)] for y in range(h)]
    # flood-fill background (undrawn) inward from the border
    bg = [[False] * w for _ in range(h)]
    stack = []
    for x in range(w):
        stack.append((x, 0)); stack.append((x, h - 1))
    for y in range(h):
        stack.append((0, y)); stack.append((w - 1, y))
    while stack:
        x, y = stack.pop()
        if x < 0 or x >= w or y < 0 or y >= h or bg[y][x] or drawn[y][x]:
            continue
        bg[y][x] = True
        stack.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])
    # ring = exterior background pixel touching a drawn pixel
    for y in range(h):
        for x in range(w):
            if not bg[y][x]:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
                xx, yy = x + dx, y + dy
                if 0 <= xx < w and 0 <= yy < h and drawn[yy][xx]:
                    px[x, y] = val
                    break
    return gray

def to_image(buf, outline=True):
    img = Image.new("L", (CW, CH))
    img.putdata([int(buf[y][x]) for y in range(CH) for x in range(CW)])
    tw, th = round(W * SHRINK), round(H * SHRINK)
    img = img.resize((tw, th), Image.LANCZOS)
    if outline:
        img = add_outline(img)
    return img

GROUPS = ["sun", "moon", "partly-day", "partly-night", "cloud",
          "fog", "drizzle", "rain", "snow", "storm"]

if __name__ == "__main__":
    for g in GROUPS:
        gray = to_image(render(g))
        if PREVIEW:
            gray.save(f"{OUT}/{g}_gray.png")           # grayscale preview
        gray.convert("1").save(f"{OUT}/{g}.png")       # 1-bit Floyd-Steinberg
    print(f"wrote {len(GROUPS)} icons to {OUT}/")
