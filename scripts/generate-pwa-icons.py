#!/usr/bin/env python3
"""
Generate every PWA icon from one vector definition.

Checked in rather than committing only the PNGs, because "make the icon slightly lighter"
should be a one-line edit and a re-run, not a round trip through a design tool. Everything
is drawn at 4x and downsampled with LANCZOS, which is what keeps the roof's diagonal from
looking like a staircase at 192px.

Outputs, into apps/web/public/:

  icons/icon-192.png            any-purpose, transparent-safe rounded square
  icons/icon-512.png            same, install/splash source
  icons/icon-maskable-192.png   full-bleed, artwork inside the 80% safe zone
  icons/icon-maskable-512.png   same
  icons/apple-touch-icon.png    180px, SQUARE and opaque — iOS applies its own mask, and
                                a pre-rounded icon gets rounded twice into a blob
  favicon.png                   32px
  favicon.svg                   crisp at any size, preferred by modern browsers

Usage:  python3 scripts/generate-pwa-icons.py
"""

from __future__ import annotations

import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, "..", "apps", "web", "public")
ICONS = os.path.join(PUBLIC, "icons")

# Straight from the design tokens in src/index.css, converted out of HSL:
#   --sidebar        224 44% 14%   deep navy
#   --accent         239 68% 58%   electric indigo
NAVY = (20, 28, 51)
INDIGO = (75, 78, 221)
INDIGO_DEEP = (48, 50, 150)
WHITE = (255, 255, 255)

SS = 4  # supersampling factor


def _gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    """A vertical linear gradient. Diagonal reads as a gimmick at favicon size."""
    grad = Image.new("RGB", (1, size), top)
    px = grad.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return grad.resize((size, size), Image.NEAREST)


def _landmark(draw: ImageDraw.ImageDraw, cx: float, cy: float, w: float, fill) -> None:
    """
    The Lucide `landmark` mark — the same glyph the sidebar and login screen use.

    Redrawn with primitives rather than traced, so it stays legible when the whole mark is
    24 pixels wide in a browser tab. The stroke weights are deliberately heavier than the
    web icon's 2/24: a hairline that reads well at 32px on a monitor disappears entirely
    on a phone's home screen.
    """
    h = w * 0.86
    left, right = cx - w / 2, cx + w / 2
    top, bottom = cy - h / 2, cy + h / 2

    bar = max(w * 0.075, 1)          # stroke weight
    roof_h = h * 0.30

    # Roof — a solid triangle. Outlined, it fills with background and vanishes at 32px.
    draw.polygon(
        [(cx, top), (right, top + roof_h), (left, top + roof_h)],
        fill=fill,
    )

    # Architrave under the roof, and the plinth at the foot.
    arch_y = top + roof_h + bar * 0.5
    draw.rounded_rectangle([left, arch_y, right, arch_y + bar], radius=bar / 2, fill=fill)
    draw.rounded_rectangle([left, bottom - bar, right, bottom], radius=bar / 2, fill=fill)

    # Three columns spanning architrave to plinth.
    col_top = arch_y + bar * 1.9
    col_bottom = bottom - bar * 1.9
    inset = w * 0.13
    span = (right - inset) - (left + inset)
    for i in range(3):
        x = left + inset + span * (i / 2)
        draw.rounded_rectangle(
            [x - bar / 2, col_top, x + bar / 2, col_bottom], radius=bar / 2, fill=fill
        )


def render(size: int, *, maskable: bool = False, square: bool = False) -> Image.Image:
    """One icon. `maskable` shrinks the art into the safe zone; `square` drops the radius."""
    s = size * SS
    img = _gradient(s, INDIGO, INDIGO_DEEP).convert("RGBA")

    # Corner treatment. Android maskable icons and iOS touch icons are both masked by the
    # platform, so they must be drawn full-bleed square or they get rounded twice.
    if not (maskable or square):
        radius = s * 0.225  # iOS "squircle" is ~22.5% of the side
        mask = Image.new("L", (s, s), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)
        img.putalpha(mask)

    draw = ImageDraw.Draw(img)

    # A maskable icon may be cropped to a circle inscribed in the middle 80%, so the mark
    # has to sit well inside that. Elsewhere it can breathe closer to the edge.
    art_w = s * (0.46 if maskable else 0.60)
    _landmark(draw, s / 2, s / 2, art_w, WHITE)

    return img.resize((size, size), Image.LANCZOS)


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="AMIRI Finance">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4b4edd"/>
      <stop offset="1" stop-color="#303296"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#g)"/>
  <g fill="#fff">
    <path d="M32 15 47 26.4H17z"/>
    <rect x="17" y="28.6" width="30" height="2.9" rx="1.45"/>
    <rect x="17" y="45.6" width="30" height="2.9" rx="1.45"/>
    <rect x="22.6" y="33.9" width="2.9" height="9.4" rx="1.45"/>
    <rect x="30.5" y="33.9" width="2.9" height="9.4" rx="1.45"/>
    <rect x="38.4" y="33.9" width="2.9" height="9.4" rx="1.45"/>
  </g>
</svg>
"""


def main() -> None:
    os.makedirs(ICONS, exist_ok=True)

    render(192).save(os.path.join(ICONS, "icon-192.png"))
    render(512).save(os.path.join(ICONS, "icon-512.png"))
    render(192, maskable=True).save(os.path.join(ICONS, "icon-maskable-192.png"))
    render(512, maskable=True).save(os.path.join(ICONS, "icon-maskable-512.png"))

    # iOS ignores the manifest icons for the home screen and ignores alpha, compositing
    # any transparency onto black — hence square, and flattened onto the navy.
    apple = Image.new("RGB", (180, 180), NAVY)
    apple.paste(render(180, square=True).convert("RGB"), (0, 0))
    apple.save(os.path.join(ICONS, "apple-touch-icon.png"))

    render(32).save(os.path.join(PUBLIC, "favicon.png"))
    with open(os.path.join(PUBLIC, "favicon.svg"), "w", encoding="utf-8") as fh:
        fh.write(SVG)

    for root, _, files in sorted(os.walk(PUBLIC)):
        for f in sorted(files):
            if f.endswith((".png", ".svg")):
                path = os.path.join(root, f)
                print(f"  {os.path.relpath(path, PUBLIC):34} {os.path.getsize(path):>7,} bytes")


if __name__ == "__main__":
    main()
