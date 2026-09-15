#!/usr/bin/env python3
"""Regenerate every raster brand asset from the idle lynxr avatar.

Writes into the repo root (or --out DIR):
  favicon.svg            tab icon: the faceless, highlight-less X (16 CSS px slot)
  favicon.png            32x32, same faceless X (shown at 16 CSS px on retina tabs)
  favicon.ico            16 faceless; 32 and 48 with the face (OS surfaces at true size)
  apple-touch-icon.png   180x180 opaque, full idle avatar on the dark --bg tile
  og-v2.png, og-creator-v2.png, og-agency-v2.png   1200x630

WHY FACELESS AT 16: rendered and measured on 2026-09-14 -- at 16px the eyes and
mouth resolve to two pink smudges over the gradient, while the bare X stays
crisp. From 22px up the face reads. The soft highlight is dropped with it at 16
(it only lightens one arm by a shade there).

No new dependencies: PIL (./venv) composes and sets type from the self-hosted
woff2 files; macOS `sips` (CoreSVG) rasterises the SVG avatar and the field,
verified to render the mask, both gradients and the Gaussian blur.
Lives in tools/, not pipeline/: a push touching pipeline/** redeploys Fly.

    ./venv/bin/python tools/make_brand_assets.py
    ./venv/bin/python tools/make_brand_assets.py --out /private/tmp/lynxr-rebrand/brand-dry
"""
import argparse, subprocess, tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent

# ----------------------------------------------------------------- BRAND (plan section 3)
BG = "#f6eefa"                                   # light --bg (light only since 2026-09-15)
FIELD = [(40, 55, 18, 28, (255, 179, 138), .60),  # the light --field / backdrop blobs: rx% ry% cx% cy% rgb alpha,
         (38, 50, 80, 20, (255, 126, 184), .40),  # a little stronger than the page (x1.2-1.3): a preview is seen
         (45, 55, 62, 88, (123, 97, 255), .26),   # small, and the lockup sits on the slab, not on the blobs
         (35, 45, 10, 92, (255, 126, 184), .32),
         (16, 22, 92, 58, (123, 97, 255), .21),
         (13, 18, 38, 60, (255, 179, 138), .50)]
SLAB_FILL = (255, 255, 255, 184)                 # light --surface #ffffffb8
SLAB_EDGE = (20, 18, 43, 30)                     # a faint ink edge: the white glass edge vanishes on a light ground
TEXT = "#14122b"                                 # light --text
LABEL = "#544f70"                                # light --text-3
WORD = "lynxr"
WORD_FONT, WORD_WGHT, WORD_TRACK = "fonts/albert-sans-latin-wght.woff2", 700, -0.035
LABEL_FONT, LABEL_TRACK = "fonts/ibm-plex-mono-latin-400.woff2", 0.04
# ----------------------------------------------------------------- /BRAND

ARMS = (-45, 45, 135, -135)

def avatar_svg(px, face=True, highlight=True, tile=None):
    arms = "".join(f'<rect x="43" y="10" width="34" height="60" rx="17" fill="#fff" transform="rotate({a} 60 62)"/>' for a in ARMS)
    s = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="{px}" height="{px}"><defs>'
         '<linearGradient id="g" x1="10" y1="0" x2="110" y2="118" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffb38a"/><stop offset=".48" stop-color="#ff7eb8"/><stop offset="1" stop-color="#7b61ff"/></linearGradient>'
         '<linearGradient id="s" x1="0" y1="14" x2="0" y2="108" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#3a1478" stop-opacity=".32"/></linearGradient>'
         '<filter id="f" x="-40%" y="-80%" width="180%" height="260%"><feGaussianBlur stdDeviation="3"/></filter>'
         f'<mask id="m" maskUnits="userSpaceOnUse" x="-20" y="-20" width="160" height="160">{arms}</mask></defs>')
    if tile: s += f'<rect x="-40" y="-40" width="200" height="200" fill="{tile}"/>'
    s += '<rect x="-20" y="-20" width="160" height="160" fill="url(#g)" mask="url(#m)"/><rect x="-20" y="-20" width="160" height="160" fill="url(#s)" mask="url(#m)"/>'
    if highlight: s += '<g mask="url(#m)"><ellipse cx="42" cy="36" rx="30" ry="10" transform="rotate(-40 42 36)" fill="#fff" opacity=".4" filter="url(#f)"/></g>'
    if face: s += ('<rect x="47" y="48.5" width="8" height="13" rx="4" fill="#fff"/><rect x="65" y="48.5" width="8" height="13" rx="4" fill="#fff"/>'
                   '<path d="M55 70q5 4 10 0" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>')
    return s + "</svg>\n"

def field_svg(w, h):
    grads, rects = "", ""
    for i, (rx, ry, cx, cy, rgb, a) in enumerate(FIELD):
        RX, RY, CX, CY = rx / 100 * w, ry / 100 * h, cx / 100 * w, cy / 100 * h
        c = "#%02x%02x%02x" % rgb
        grads += (f'<radialGradient id="r{i}" gradientUnits="userSpaceOnUse" cx="{CX}" cy="{CY}" r="{RX}" '
                  f'gradientTransform="translate({CX} {CY}) scale(1 {RY / RX}) translate({-CX} {-CY})">'
                  f'<stop offset="0" stop-color="{c}" stop-opacity="{a}"/><stop offset=".7" stop-color="{c}" stop-opacity="0"/></radialGradient>')
        rects = f'<rect width="{w}" height="{h}" fill="url(#r{i})"/>' + rects   # first CSS layer paints on top
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}"><defs>{grads}</defs>'
            f'<rect width="{w}" height="{h}" fill="{BG}"/>{rects}</svg>\n')

def sips(svg, w, h, tmp, name):
    src = Path(tmp) / f"{name}.svg"; dst = src.with_suffix(".png")
    src.write_text(svg)
    subprocess.run(["sips", "-s", "format", "png", "-z", str(h), str(w), str(src), "--out", str(dst)], check=True, capture_output=True)
    return Image.open(dst).convert("RGBA")

def font(path, px, wght=None):
    f = ImageFont.truetype(str(path), px)
    if wght is not None: f.set_variation_by_axes([wght])
    return f

def tracked(d, x, y, s, f, track, fill):
    for ch in s:
        d.text((x, y), ch, font=f, fill=fill); x += d.textlength(ch, font=f) + track
    return x

def tracked_width(d, s, f, track):
    return sum(d.textlength(ch, font=f) + track for ch in s) - (track if s else 0)

def render_og(label, out, tmp, fonts):
    SS, W, H = 2, 1200, 630
    img = sips(field_svg(W, H), W * SS, H * SS, tmp, "field").convert("RGBA")
    wf = font(fonts / Path(WORD_FONT).name, 132 * SS, WORD_WGHT)
    d = ImageDraw.Draw(img)
    av_px = 150 * SS; gap = 34 * SS
    track = WORD_TRACK * 132 * SS
    ww = tracked_width(d, WORD, wf, track)
    total = av_px + gap + ww
    asc, desc = wf.getmetrics()
    lab_h = 0
    if label:
        lf = font(fonts / Path(LABEL_FONT).name, 30 * SS); lab_h = 64 * SS
    block_h = max(av_px, asc + desc) + lab_h
    x0 = (W * SS - total) / 2; y0 = (H * SS - block_h) / 2
    # the glass slab behind the lockup (no blur: nothing detailed sits under it)
    pad_x, pad_y = 72 * SS, 56 * SS
    slab = Image.new("RGBA", img.size, (0, 0, 0, 0)); sd = ImageDraw.Draw(slab)
    box = (x0 - pad_x, y0 - pad_y, x0 + total + pad_x, y0 + block_h + pad_y)
    sd.rounded_rectangle(box, radius=56 * SS, fill=SLAB_FILL, outline=SLAB_EDGE, width=2 * SS)
    img = Image.alpha_composite(img, slab); d = ImageDraw.Draw(img)
    av = sips(avatar_svg(av_px), av_px, av_px, tmp, "av")
    cap_top = y0 + (max(av_px, asc + desc) - (asc + desc)) / 2
    img.alpha_composite(av, (round(x0), round(y0 + (max(av_px, asc + desc) - av_px) / 2)))
    tracked(d, x0 + av_px + gap, cap_top, WORD, wf, track, TEXT)
    if label:
        lt = LABEL_TRACK * 30 * SS
        lw = tracked_width(d, label, lf, lt)
        tracked(d, (W * SS - lw) / 2, y0 + max(av_px, asc + desc) + 18 * SS, label, lf, lt, LABEL)
    img.convert("RGB").resize((W, H), Image.LANCZOS).save(out, optimize=True)
    print("wrote", out, (W, H))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT))
    ap.add_argument("--fonts", default=str(ROOT / "fonts"))
    a = ap.parse_args(); out = Path(a.out); fonts = Path(a.fonts); out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        (out / "favicon.svg").write_text(avatar_svg(32, face=False, highlight=False).replace(' width="32" height="32"', ""))
        print("wrote", out / "favicon.svg")
        sips(avatar_svg(32, face=False, highlight=False), 32, 32, tmp, "f32").save(out / "favicon.png", optimize=True)
        print("wrote", out / "favicon.png")
        f48 = sips(avatar_svg(48), 48, 48, tmp, "i48"); f32 = sips(avatar_svg(32), 32, 32, tmp, "i32")
        f16 = sips(avatar_svg(16, face=False, highlight=False), 16, 16, tmp, "i16")
        f48.save(out / "favicon.ico", format="ICO", sizes=[(48, 48), (32, 32), (16, 16)], append_images=[f32, f16])
        print("wrote", out / "favicon.ico")
        tile = sips(avatar_svg(180, tile=BG).replace('viewBox="0 0 120 120"', 'viewBox="-24 -24 168 168"'), 180, 180, tmp, "apple")
        flat = Image.new("RGB", tile.size, BG); flat.paste(tile, (0, 0), tile); flat.save(out / "apple-touch-icon.png", optimize=True)
        print("wrote", out / "apple-touch-icon.png")
        render_og("", out / "og-v2.png", tmp, fonts)
        render_og("creators", out / "og-creator-v2.png", tmp, fonts)
        render_og("agency", out / "og-agency-v2.png", tmp, fonts)

if __name__ == "__main__":
    main()
