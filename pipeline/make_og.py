# Renders og.png: the lynxr gate wordmark (X mark + "lynxr.") centered on the
# site background, 1200x630. Drawn at 4x and downscaled for antialiasing.
from PIL import Image, ImageDraw, ImageFont

SS = 4                       # supersample factor
W, H = 1200, 630
BG, TEXT, DIM = "#0a0a0b", "#ededf0", "#6b6b76"

# Gate proportions: font 32px, mark 26px, gap 12px -> scale everything off font
FONT_PX = 112 * SS
MARK_PX = int(FONT_PX * 26 / 32)
GAP_PX = int(FONT_PX * 12 / 32)
TRACK = -0.03 * FONT_PX      # letter-spacing -0.03em

img = Image.new("RGB", (W * SS, H * SS), BG)
d = ImageDraw.Draw(img)

# Helvetica Neue Medium ~ font-weight 600 on the site
font = None
for idx in range(14):
    try:
        f = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", FONT_PX, index=idx)
        if f.getname()[1] == "Medium":
            font = f
            break
    except OSError:
        break
if font is None:
    font = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", FONT_PX)

def text_width(s):
    w = 0
    for ch in s:
        w += d.textlength(ch, font=font) + TRACK
    return w - TRACK

def draw_text(x, y, s, fill):
    for ch in s:
        d.text((x, y), ch, font=font, fill=fill)
        x += d.textlength(ch, font=font) + TRACK
    return x

word = "lynxr"
w_word = text_width(word)
w_dot = d.textlength(".", font=font)
total_w = MARK_PX + GAP_PX + w_word + w_dot

# The mark's two strokes from the site SVG (viewBox 0 0 24 24):
#   M3 3h3l15 15-3 3L3 6z  and  M21 3v3L6 21l-3-3L18 3z
s = MARK_PX / 24.0
x0 = ((W * SS) - total_w) / 2

# Vertically center the group on the cap height of the text
asc, desc = font.getmetrics()
cap = font.getbbox("l")[3] - font.getbbox("l")[1]
y_text = (H * SS - (asc + desc)) / 2
cap_top = y_text + font.getbbox("l")[1]
y0 = cap_top + (cap - MARK_PX) / 2

for poly in [
    [(3, 3), (6, 3), (21, 18), (18, 21), (3, 6)],
    [(21, 3), (21, 6), (6, 21), (3, 18), (18, 3)],
]:
    d.polygon([(x0 + px * s, y0 + py * s) for px, py in poly], fill=TEXT)

x = draw_text(x0 + MARK_PX + GAP_PX, y_text, word, TEXT)
draw_text(x, y_text, ".", DIM)

img = img.resize((W, H), Image.LANCZOS)
img.save("/Users/junsahwang/Documents/lynxrio/og.png", optimize=True)
print("wrote og.png", img.size)
