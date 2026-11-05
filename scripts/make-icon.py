"""生成应用图标 build/icon.ico + icon.png（无外部素材，纯绘）。

用任意装了 Pillow 的 Python 跑：python scripts/make-icon.py
"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    sys.exit("需要 Pillow：pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build"
OUT.mkdir(parents=True, exist_ok=True)

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# 竖向渐变底色（在 alpha 圆角遮罩里）
grad = Image.new("RGBA", (S, S))
gd = grad.load()
top = (44, 78, 168)
mid = (91, 140, 255)
bot = (127, 176, 255)
for y in range(S):
    t = y / (S - 1)
    if t < 0.55:
        k = t / 0.55
        c = tuple(int(top[i] + (mid[i] - top[i]) * k) for i in range(3))
    else:
        k = (t - 0.55) / 0.45
        c = tuple(int(mid[i] + (bot[i] - mid[i]) * k) for i in range(3))
    for x in range(S):
        gd[x, y] = (*c, 255)

mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.235), fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)

# 播放三角
cx, cy = S * 0.475, S * 0.5
r = S * 0.20
tri = [
    (cx - r * 0.62, cy - r * 0.92),
    (cx - r * 0.62, cy + r * 0.92),
    (cx + r * 0.98, cy),
]
d.polygon(tri, fill=(255, 255, 255, 245))

# 右侧“扫描条”三条，暗示逐帧拆解
bar_x = S * 0.70
for i, w in enumerate((0.20, 0.14, 0.09)):
    y0 = S * (0.34 + i * 0.145)
    d.rounded_rectangle(
        [bar_x, y0, bar_x + S * w, y0 + S * 0.055],
        radius=S * 0.028,
        fill=(255, 255, 255, int(220 - i * 45)),
    )

# 顶部细高光
d.rounded_rectangle([S * 0.12, S * 0.06, S * 0.88, S * 0.075], radius=S * 0.01, fill=(255, 255, 255, 40))

png = OUT / "icon.png"
img.save(png)

sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]
img.save(OUT / "icon.ico", format="ICO", sizes=sizes)
print("已生成", png, "和", OUT / "icon.ico")
