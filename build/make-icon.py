"""Regenerates the Hand Arrow app icon. The mark (three fingers fusing into a
download arrow) is drawn on the Midnight Blue gradient tile at a given size,
then exported as PNG master + multi-size .ico candidates.

Usage: python build/make-icon.py <mark_height_fraction> [out.png]
       python build/make-icon.py 0.68            -> build/icon-candidate.png
"""
import math
import sys
from PIL import Image, ImageDraw

TILE = 1024
SS = 4  # supersample factor for clean antialiased strokes
TOP = (92, 161, 255)    # #5CA1FF
BOTTOM = (43, 107, 224)  # #2B6BE0
CORNER = 0.225  # tile corner radius as tile fraction


def rounded_gradient(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    strip = Image.new("RGB", (1, size))
    px = strip.load()
    for y in range(size):
        t = y / (size - 1)
        px[0, y] = (
            int(TOP[0] + (BOTTOM[0] - TOP[0]) * t),
            int(TOP[1] + (BOTTOM[1] - TOP[1]) * t),
            int(TOP[2] + (BOTTOM[2] - TOP[2]) * t),
        )
    grad = strip.resize((size, size))
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    rad = int(size * CORNER)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=rad, fill=255)
    img.paste(grad, (0, 0), mask)
    return img


def draw_mark(img, mark_h):
    """Hand Arrow: middle finger long, side fingers shorter, both fusing into
    the downward chevron. mark_h is in img pixels; img is already supersampled."""
    w, h = img.size
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    stroke = mark_h * 0.145
    r = stroke / 2
    cx = w / 2
    top = (h - mark_h) / 2             # vertical centering
    spread = mark_h * 0.30             # finger x distance from center
    finger_top_mid = top + r
    finger_top_side = top + mark_h * 0.28 + r
    fuse_y = top + mark_h * 0.66       # fingers end / chevron starts
    vertex_y = top + mark_h - r        # chevron vertex

    def line(x1, y1, x2, y2):
        d.line([x1, y1, x2, y2], fill=(255, 255, 255, 255), width=int(stroke))
        for x, y in ((x1, y1), (x2, y2)):
            d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 255))

    line(cx, finger_top_mid, cx, fuse_y)                       # middle finger
    line(cx - spread, finger_top_side, cx - spread, fuse_y)    # left finger
    line(cx + spread, finger_top_side, cx + spread, fuse_y)    # right finger
    line(cx - spread, fuse_y, cx, vertex_y)                    # chevron left
    line(cx, vertex_y, cx + spread, fuse_y)                    # chevron right
    return Image.alpha_composite(img, layer)


def render(mark_h):
    icon = rounded_gradient(TILE * SS)
    icon = draw_mark(icon, mark_h * TILE * SS)
    return icon.resize((TILE, TILE), Image.LANCZOS)


def make(mark_h, out):
    render(mark_h).save(out)
    print(f"wrote {out} (mark height {mark_h:.0%} of tile)")


def ship(mark_h):
    """Regenerate the shipped build assets from a mark height fraction."""
    master = render(mark_h)
    master.save("build/icon.png", sizes=[(256, 256)])
    master.resize((256, 256), Image.LANCZOS).save("build/icon-preview-256.png")
    master.save(
        "build/icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"shipped icon.png, icon-preview-256.png, icon.ico (mark height {mark_h:.0%})")


if __name__ == "__main__":
    frac = float(sys.argv[1]) if len(sys.argv) > 1 else 0.68
    if len(sys.argv) > 2 and sys.argv[2] == "--ship":
        ship(frac)
    else:
        out = sys.argv[2] if len(sys.argv) > 2 else "build/icon-candidate.png"
        make(frac, out)
