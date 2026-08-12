# Renders the link-preview images: the lynxr gate wordmark (X mark + "lynxr.")
# centered on the site background, 1200x630. Drawn at 4x and downscaled for
# antialiasing.
#
# Three variants, because both apps now live on unlisted URLs that get sent to
# people by hand — and an iMessage preview that says only "lynxr / lynxr.io"
# gives the sender no way to tell which link they just pasted:
#
#   og.png          the public landing page, no label
#   og-creator.png  CREATORS
#   og-agency.png   AGENCY
#
# Run: ./venv/bin/python pipeline/make_og.py
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

SS = 4                       # supersample factor
W, H = 1200, 630
BG, TEXT, DIM = "#0a0a0b", "#ededf0", "#6b6b76"
ROOT = Path(__file__).resolve().parent.parent

# Gate proportions: font 32px, mark 26px, gap 12px -> scale everything off font
FONT_PX = 112 * SS
MARK_PX = int(FONT_PX * 26 / 32)
GAP_PX = int(FONT_PX * 12 / 32)
TRACK = -0.03 * FONT_PX      # letter-spacing -0.03em

# The label sits under the wordmark in the site's "eyebrow" style: small, dim,
# uppercase, widely tracked. Deliberately quiet — it is a note to the sender,
# not a headline.
LABEL_PX = int(FONT_PX * 0.20)
LABEL_TRACK = 0.18 * LABEL_PX
LABEL_GAP = int(FONT_PX * 0.42)


def helvetica(px, want="Medium"):
    for idx in range(14):
        try:
            f = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", px, index=idx)
            if f.getname()[1] == want:
                return f
        except OSError:
            break
    return ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", px)


def render(label, out):
    img = Image.new("RGB", (W * SS, H * SS), BG)
    d = ImageDraw.Draw(img)
    font = helvetica(FONT_PX)

    def text_width(s, f=font, track=TRACK):
        w = 0
        for ch in s:
            w += d.textlength(ch, font=f) + track
        return w - track

    def draw_text(x, y, s, fill, f=font, track=TRACK):
        for ch in s:
            d.text((x, y), ch, font=f, fill=fill)
            x += d.textlength(ch, font=f) + track
        return x

    word = "lynxr"
    w_word = text_width(word)
    w_dot = d.textlength(".", font=font)
    total_w = MARK_PX + GAP_PX + w_word + w_dot

    s = MARK_PX / 24.0
    x0 = ((W * SS) - total_w) / 2

    # Vertically center the group on the cap height of the text. With a label
    # present the whole block shifts up so the PAIR stays optically centred.
    asc, desc = font.getmetrics()
    cap = font.getbbox("l")[3] - font.getbbox("l")[1]
    y_text = (H * SS - (asc + desc)) / 2
    if label:
        y_text -= LABEL_GAP * 0.6
    cap_top = y_text + font.getbbox("l")[1]
    y0 = cap_top + (cap - MARK_PX) / 2

    # The site SVG uses fill-rule="evenodd": where the two strokes overlap, the
    # background shows through. XOR of the two filled masks reproduces that.
    masks = []
    for poly in [
        [(3, 3), (6, 3), (21, 18), (18, 21), (3, 6)],
        [(21, 3), (21, 6), (6, 21), (3, 18), (18, 3)],
    ]:
        m = Image.new("L", img.size, 0)
        ImageDraw.Draw(m).polygon([(x0 + px * s, y0 + py * s) for px, py in poly], fill=255)
        masks.append(m)
    img.paste(TEXT, mask=ImageChops.difference(*masks))

    x = draw_text(x0 + MARK_PX + GAP_PX, y_text, word, TEXT)
    draw_text(x, y_text, ".", DIM)

    if label:
        lf = helvetica(LABEL_PX)
        up = label.upper()
        lw = text_width(up, lf, LABEL_TRACK)
        draw_text((W * SS - lw) / 2, y_text + asc + LABEL_GAP, up, DIM, lf, LABEL_TRACK)

    img = img.resize((W, H), Image.LANCZOS)
    img.save(ROOT / out, optimize=True)
    print("wrote", out, img.size)


if __name__ == "__main__":
    render("", "og.png")
    render("creators", "og-creator.png")
    render("agency", "og-agency.png")
