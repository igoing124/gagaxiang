# -*- coding: utf-8 -*-
"""生成「嘎嘎香 乐山油炸串串」品牌点单二维码。

品牌特征：
- 码点：深棕色（#3a2417，与页面 theme-color 一致）圆点风格
- 中央标志：白色圆角底 + 手绘烤串图形（三块肉 + 竹签）+ 「嘎嘎香」
- 配色：棕金品牌色，米白背景
"""
import math

import qrcode
from PIL import Image, ImageDraw, ImageFont
from qrcode.image.styledpil import StyledPilImage
from qrcode.image.styles.colormasks import SolidFillColorMask
from qrcode.image.styles.moduledrawers.pil import RoundedModuleDrawer

import sys

LINK = sys.argv[1] if len(sys.argv) > 1 else "https://youzha-331927-5-1510728692.sh.run.tcloudbase.com/"

# ---- 品牌色 ----
BROWN = (58, 36, 23)        # #3a2417 主题深棕
GOLD = (212, 158, 78)       # #d49e4e 品牌金
CREAM = (255, 248, 238)     # #fff8ee 米白
MEAT = (196, 88, 50)        # 烤肉色
MEAT_DARK = (150, 60, 30)

FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_REG = "C:/Windows/Fonts/msyh.ttc"

# ---- 1. 生成基础二维码（高容错，圆点风格） ----
qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, box_size=24, border=4)
qr.add_data(LINK)
qr.make(fit=True)
qr_img = qr.make_image(
    image_factory=StyledPilImage,
    module_drawer=RoundedModuleDrawer(),
    color_mask=SolidFillColorMask(back_color=CREAM, front_color=BROWN),
).convert("RGB")

W, H = qr_img.size
print("二维码基础尺寸:", qr_img.size)

# ---- 2. 绘制中央品牌标志 ----
def draw_logo(size):
    """烤串图形：竹签 + 三块圆角肉块 + 火苗点缀，下方「嘎嘎香」。"""
    s = 4  # 超采样抗锯齿
    img = Image.new("RGBA", (size * s, size * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = size * s / 100.0  # 以 100 为设计坐标

    # 竹签（斜 45 度，从左下到右上）
    d.line([(25 * u, 78 * u), (80 * u, 18 * u)], fill=GOLD, width=int(4.5 * u))
    d.ellipse(
        [78 * u - 3.2 * u, 15 * u - 3.2 * u, 78 * u + 3.2 * u, 15 * u + 3.2 * u],
        fill=GOLD,
    )

    # 三块肉（椭圆，串在签上，微带烤色渐变感）
    cx, cy = 43 * u, 61 * u
    for i, (dx, dy, r, col) in enumerate(
        [
            (-13, 8, 15, MEAT_DARK),
            (2, -2, 16, MEAT),
            (16, -13, 13, MEAT_DARK),
        ]
    ):
        x, y = cx + dx * u, cy + dy * u
        rr = r * u
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=col)
        # 高光
        d.ellipse(
            [x - rr * 0.45, y - rr * 0.55, x - rr * 0.05, y - rr * 0.15],
            fill=(255, 255, 255, 70),
        )

    img = img.resize((size, size), Image.LANCZOS)

    # 「嘎嘎香」文字
    text = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    td = ImageDraw.Draw(text)
    font = ImageFont.truetype(FONT_BOLD, int(size * 0.22))
    box = td.textbbox((0, 0), "嘎嘎香", font=font)
    tw = box[2] - box[0]
    td.text(((size - tw) / 2 - box[0], size * 0.72), "嘎嘎香", font=font, fill=BROWN)
    return Image.alpha_composite(img, text)


logo_inner = draw_logo(64)
LOGO_BOX = int(W * 0.26)  # 中央标志区域（白色底）
logo_pad = int(LOGO_BOX * 0.16)
plate = Image.new("RGB", (LOGO_BOX, LOGO_BOX), (255, 255, 255))
# 米白底更柔和，与码点背景一致
plate = Image.new("RGB", (LOGO_BOX, LOGO_BOX), CREAM)

inner_size = LOGO_BOX - logo_pad * 2
logo = draw_logo(inner_size)
plate.paste(logo, (logo_pad, logo_pad), logo)

# 圆角白底
mask = Image.new("L", (LOGO_BOX, LOGO_BOX), 0)
ImageDraw.Draw(mask).rounded_rectangle(
    [0, 0, LOGO_BOX - 1, LOGO_BOX - 1], radius=int(LOGO_BOX * 0.18), fill=255
)
qr_img.paste(plate, ((W - LOGO_BOX) // 2, (H - LOGO_BOX) // 2), mask)

# ---- 3. 加边框 + 底部品牌条，输出成品海报式二维码 ----
margin = 60
footer = 150
canvas = Image.new("RGB", (W + margin * 2, H + margin * 2 + footer), CREAM)
canvas.paste(qr_img, (margin, margin))

d = ImageDraw.Draw(canvas)
CW = canvas.width

# 顶部品牌横条
bar_h = 10
d.rectangle([0, 0, CW, bar_h], fill=BROWN)

# 底部文字
f_name = ImageFont.truetype(FONT_BOLD, 52)
f_sub = ImageFont.truetype(FONT_REG, 30)
name = "嘎嘎香 · 乐山油炸串串"
sub = "扫码点单 · 每天营业 17:00 - 次日 00:30"
b1 = d.textbbox((0, 0), name, font=f_name)
b2 = d.textbbox((0, 0), sub, font=f_sub)
y0 = H + margin * 2 - footer + 28
d.text(((CW - (b1[2] - b1[0])) / 2, y0), name, font=f_name, fill=BROWN)
d.text(((CW - (b2[2] - b2[0])) / 2, y0 + 74), sub, font=f_sub, fill=(120, 90, 70))

out = "D:/ai/油炸小程序/点单二维码-嘎嘎香.png"
canvas.save(out, quality=95)
print("已保存:", out, canvas.size)

# 同时输出一个纯二维码小图（方形，适合印贴纸/菜单角标）
small_out = "D:/ai/油炸小程序/点单二维码-纯码.png"
qr_img.save(small_out)
print("已保存:", small_out, qr_img.size)
