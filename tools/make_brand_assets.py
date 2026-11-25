#!/usr/bin/env python3
"""Regenerate every raster brand asset from the lynxr guy (the logo since 2026-11-23; a circle since kit v3, 2026-11-25).

Source of the art: the owner's logo kit v2, ~/Lynxr-redesign/logo-kit-v2/lynxr-logo-kit/ (LOGO-HANDOFF.md). Its geometry
is copied below exactly (viewBox 0 0 400 400, tight logo box 50 55 300 300); nothing is redrawn by eye.

Writes into the repo root (or --out DIR):
  favicon.svg            tab icon: the kit's favicon art (ink rounded tile, white guy, thicker eyes that survive 16 px)
  favicon.png            32x32, the same art
  favicon.ico            48, 32 and 16, the same art
  apple-touch-icon.png   180x180 opaque: the kit's app icon (full-bleed ink, white guy; iOS rounds the corners)
  icon-192.png, icon-512.png   the same app icon, for site.webmanifest
  lynxr-logo-v2.png      512x512 opaque ink square with the white guy: the JSON-LD Organization logo
  og-v5.png, og-agency-v5.png, og-invite-v2.png   1200x630 link previews, the night look (render_og_night)
With --social DIR (keep it OUTSIDE the repo): lynxr-profile-1024.png, the app icon at 1024, for the Instagram, TikTok
and LinkedIn profile pictures, which the owner uploads by hand.

No new dependencies: PIL (./venv) composes and sets type from the self-hosted woff2 files; macOS `sips` (CoreSVG)
rasterises the SVG art. Lives in tools/, not pipeline/: a push touching pipeline/** redeploys Fly.

    ./venv/bin/python tools/make_brand_assets.py
    ./venv/bin/python tools/make_brand_assets.py --out /private/tmp/lynxr-guy-brand-dry --social /private/tmp/lynxr-guy-brand-dry/social
"""
import argparse, subprocess, tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent

# ----------------------------------------------------------------- BRAND (plan section 3)
# The guy's two colours (owner decision D1, 2026-11-23). Kit: "#141414", "#FFFFFF". Site tokens: "#14122b", "#f6f4ff".
GUY_INK, GUY_WHITE = "#141414", "#F2F2F0"   # owner 2026-11-25: soft white, "doesnt hurt the average human eye"
LOGO_GROUND = GUY_INK            # the JSON-LD logo's square: opaque ink (owner 2026-11-25: the guy is always white), so it reads on any card
# The link-preview look (owner decision D5): "dark" = the kit's og-image (ink field, white guy) plus the wordmark and
# label; "light" = the pastel field below with the black guy and the ink wordmark; "bare" = the kit's og-image as is.
OG_LOOK = "dark"
LABEL_DARK = "#a3a3a3"           # the label on the dark card: 7.3:1 on #141414 (with the site ink use "#a9a5c2": 7.7:1)
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

CIRCLE = "M50,205 A150,150 0 1 1 350,205 A150,150 0 1 1 50,205 Z"
EYES = ("108.5,227.5 142.2,182.5 176,227.5", "224,227.5 257.8,182.5 291.5,227.5")  # stroke 22.5: the logo (kit v3)
FAV_EYES = EYES                                      # kit v3 favicon: the same eyes at stroke 34, survives 16 px
BOX_W, BOX_H = 300, 300                              # the tight logo box, viewBox 50 55 300 300

def guy_g(body, eye, eyes=EYES, sw=22.5):
    pl = "".join(f'<polyline points="{p}"/>' for p in eyes)
    return (f'<path d="{CIRCLE}" fill="{body}"/><g fill="none" stroke="{eye}" stroke-width="{sw}" '
            f'stroke-linecap="round" stroke-linejoin="round">{pl}</g>')

def favicon_svg(px):     # the kit's svg/favicon.svg
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{px}" height="{px}" viewBox="0 0 64 64">'
            f'<rect width="64" height="64" rx="14" fill="{GUY_INK}"/>'
            f'<g transform="translate(32,32) scale(0.18) translate(-200,-205)">{guy_g(GUY_WHITE, GUY_INK, FAV_EYES, 34)}</g></svg>\n')

def app_icon_svg(px):    # the kit's svg/app-icon.svg: full bleed, no corner rounding
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{px}" height="{px}" viewBox="0 0 1024 1024">'
            f'<rect width="1024" height="1024" fill="{GUY_INK}"/>'
            f'<g transform="translate(512,512) scale(2) translate(-200,-205)">{guy_g(GUY_WHITE, GUY_INK)}</g></svg>\n')

def logo_svg(w, h, body, eye):   # the tight logo box: the kit's svg/lynxr-guy.svg and lynxr-guy-black.svg
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="50 55 300 300" width="{w}" height="{h}">{guy_g(body, eye)}</svg>\n'

def opaque(img, ground):
    flat = Image.new("RGB", img.size, ground)
    flat.paste(img, (0, 0), img)
    return flat

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

def ink_left(ch, f):
    """Where a glyph's ink actually starts, measured from a render: textbbox's
    left edge did not track the real side bearing here (off by 16px at 2x)."""
    pad = 200
    probe = Image.new("L", (pad * 3, pad * 3), 0)
    ImageDraw.Draw(probe).text((pad, pad), ch, font=f, fill=255)
    return probe.getbbox()[0] - pad

def render_og(label, out, tmp, fonts):
    SS, W, H = 2, 1200, 630
    if OG_LOOK == "light":
        img = sips(field_svg(W, H), W * SS, H * SS, tmp, "field").convert("RGBA")
        body, eye, ink, muted = GUY_INK, GUY_WHITE, TEXT, LABEL
    else:
        img = Image.new("RGBA", (W * SS, H * SS), GUY_INK)
        body, eye, ink, muted = GUY_WHITE, GUY_INK, GUY_WHITE, LABEL_DARK
    if OG_LOOK == "bare":
        # the kit's svg/og-image.svg exactly: translate(600,315) scale(1.3) translate(-200,-205), no words.
        # The box's top-left (50, 55) lands at (600 - 150 * 1.3, 315 - 150 * 1.3).
        gw, gh = round(BOX_W * 1.3 * SS), round(BOX_H * 1.3 * SS)
        g = sips(logo_svg(gw, gh, body, eye), gw, gh, tmp, "guy")
        img.alpha_composite(g, (round((600 - 150 * 1.3) * SS), round((315 - 150 * 1.3) * SS)))
    else:
        WORD_PX = 158
        wf = font(fonts / Path(WORD_FONT).name, WORD_PX * SS, WORD_WGHT)
        d = ImageDraw.Draw(img)
        gw = 190 * SS; gh = round(gw * BOX_H / BOX_W); gap = 44 * SS
        track = WORD_TRACK * WORD_PX * SS
        ww = tracked_width(d, WORD, wf, track)
        total = gw + gap + ww
        asc, desc = wf.getmetrics()
        lab_h = 0
        if label:
            lf = font(fonts / Path(LABEL_FONT).name, 30 * SS); lab_h = 64 * SS
        row_h = max(gh, asc + desc)
        x0 = (W * SS - total) / 2; y0 = (H * SS - row_h - lab_h) / 2
        g = sips(logo_svg(gw, gh, body, eye), gw, gh, tmp, "guy")
        img.alpha_composite(g, (round(x0), round(y0 + (row_h - gh) / 2)))
        wx = x0 + gw + gap
        tracked(d, wx, y0 + (row_h - (asc + desc)) / 2, WORD, wf, track, ink)
        if label:
            # left-aligned to the first ink of the l (owner, 2026-09-15), both side bearings subtracted
            lt = LABEL_TRACK * 30 * SS
            lx = wx + ink_left(WORD[0], wf) - ink_left(label[0], lf)
            tracked(d, lx, y0 + row_h + 18 * SS, label, lf, lt, muted)
    img.convert("RGB").resize((W, H), Image.LANCZOS).save(out, optimize=True)
    print("wrote", out, (W, H))

NIGHT, NIGHT_DOT, NIGHT_SUB, NIGHT_ACT = "#212227", (238, 237, 245), "#b9b7c9", "#ff9f2e"

def render_og_night(label, out, tmp, fonts):
    """THE 2026-11 LOOK (owner, 2026-11-26: "change all the share banners too with this revamp"): the landing's night
    (#212227) with a scatter of faint star dots, the soft-white guy over the big lowercase "lynxr", and one line under it:
    "let's go viral", or the label (the invite's in the press orange)."""
    import random
    SS, W, H = 2, 1200, 630
    img = Image.new("RGBA", (W * SS, H * SS), NIGHT)
    d = ImageDraw.Draw(img)
    rnd = random.Random(7)
    for _ in range(90):
        x, y, r = rnd.uniform(0, W * SS), rnd.uniform(0, H * SS), rnd.choice([1.6, 2, 2.4, 3])
        a = rnd.choice([70, 100, 130, 160])
        d.ellipse((x - r, y - r, x + r, y + r), fill=NIGHT_DOT + (a,))
    gw = 132 * SS
    g = sips(logo_svg(gw, gw, GUY_WHITE, GUY_INK), gw, gw, tmp, "nguy")
    WORD_PX = 200
    wf = font(fonts / Path(WORD_FONT).name, WORD_PX * SS, 800)
    track = -0.05 * WORD_PX * SS
    ww = tracked_width(d, WORD, wf, track)
    asc, desc = wf.getmetrics()
    sub = label or "let's go viral"
    sf = font(fonts / Path(WORD_FONT).name, 46 * SS, 500)
    sw = tracked_width(d, sub, sf, 0)
    gap1, gap2 = 22 * SS, 18 * SS
    block = gw + gap1 + asc + desc + gap2 + 50 * SS - asc * 0.18
    y0 = (H * SS - block) / 2
    img.alpha_composite(g, (round((W * SS - gw) / 2), round(y0)))
    wy = y0 + gw + gap1 - asc * 0.18
    tracked(d, (W * SS - ww) / 2, wy, WORD, wf, track, GUY_WHITE)
    sy = wy + asc + desc + gap2 * 0.2   # below the y's descender
    tracked(d, (W * SS - sw) / 2, sy, sub, sf, 0, NIGHT_ACT if label == "you're invited" else NIGHT_SUB)
    img.convert("RGB").resize((W, H), Image.LANCZOS).save(out, optimize=True)
    print("wrote", out, (W, H))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT))
    ap.add_argument("--fonts", default=str(ROOT / "fonts"))
    ap.add_argument("--social", default="", help="a directory OUTSIDE the repo for the profile picture")
    a = ap.parse_args(); out = Path(a.out); fonts = Path(a.fonts); out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        (out / "favicon.svg").write_text(favicon_svg(64))
        print("wrote", out / "favicon.svg")
        sips(favicon_svg(32), 32, 32, tmp, "f32").save(out / "favicon.png", optimize=True)
        print("wrote", out / "favicon.png")
        f48, f32, f16 = (sips(favicon_svg(n), n, n, tmp, f"i{n}") for n in (48, 32, 16))
        f48.save(out / "favicon.ico", format="ICO", sizes=[(48, 48), (32, 32), (16, 16)], append_images=[f32, f16])
        print("wrote", out / "favicon.ico")
        for name, n in (("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)):
            opaque(sips(app_icon_svg(n), n, n, tmp, f"app{n}"), GUY_INK).save(out / name, optimize=True)
            print("wrote", out / name)
        # The Organization logo for search engines (JSON-LD "logo"): square, on our own domain, on an opaque light
        # ground so no crawler or card fills it black. The black guy 360 wide: more than one eye's height clear all round.
        lw, lh = 360, round(360 * BOX_H / BOX_W)
        logo = Image.new("RGB", (512, 512), LOGO_GROUND)
        g = sips(logo_svg(lw, lh, GUY_WHITE, GUY_INK), lw, lh, tmp, "logo")
        logo.paste(g, ((512 - lw) // 2, (512 - lh) // 2), g)
        logo.save(out / "lynxr-logo-v2.png", optimize=True)
        print("wrote", out / "lynxr-logo-v2.png")
        render_og_night("", out / "og-v5.png", tmp, fonts)
        render_og_night("agency", out / "og-agency-v5.png", tmp, fonts)
        # The share link's preview (/join/, owner 2026-11-21): the same lockup, labelled for the friend who opens it.
        render_og_night("you're invited", out / "og-invite-v2.png", tmp, fonts)
        if a.social:
            s = Path(a.social); s.mkdir(parents=True, exist_ok=True)
            opaque(sips(app_icon_svg(1024), 1024, 1024, tmp, "app1024"), GUY_INK).save(s / "lynxr-profile-1024.png", optimize=True)
            print("wrote", s / "lynxr-profile-1024.png")

if __name__ == "__main__":
    main()
