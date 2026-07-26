"""Regenerate the print-ready Ferrix logo from branding/ferrix-logo.png.

Flattens transparency onto white, resizes to the print head width, and hard-
thresholds to crisp 1-bit black/white (best for a flat two-tone logo + text).
Outputs:
  branding/ferrix-logo-print.png   -> printed via ESC/POS raster (src/logo.ts)
  public/logo.png                  -> shown in the web dashboard preview

Run:  python3 scripts/gen-logo.py
"""
import shutil
from PIL import Image

SRC = "branding/ferrix-logo.png"
TARGET_W = 504   # full print head width (matches src/bitmap.ts PRINT_WIDTH)

src = Image.open(SRC).convert("RGBA")
white = Image.new("RGBA", src.size, (255, 255, 255, 255))
flat = Image.alpha_composite(white, src).convert("L")

w, h = flat.size
flat = flat.resize((TARGET_W, round(h * TARGET_W / w)), Image.LANCZOS)

bw = flat.point(lambda x: 255 if x >= 128 else 0, "L").convert("1", dither=Image.NONE)
bw.save("branding/ferrix-logo-print.png")
shutil.copy("branding/ferrix-logo-print.png", "public/logo.png")
print(f"wrote branding/ferrix-logo-print.png + public/logo.png  {bw.size}")
