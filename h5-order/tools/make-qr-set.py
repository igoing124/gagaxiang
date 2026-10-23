# -*- coding: utf-8 -*-
"""为正式点单地址生成点单码和商家码（海报版 + 纯码版）。

用法：
  python make-qr-set.py
  python make-qr-set.py --base-url https://order.example.com --label 正式

默认写 4 张图到项目根目录。地址变化后重新运行即可，不需要改脚本。

设计约定：
- 点单码：品牌棕色码点 + 烤串标志，底部「扫码点单」
- 商家码：墨绿色码点 + 剪贴板标志，底部「商家后台」并标注「商家专用 · 请勿张贴」
  两种码配色明显区分，避免店里贴错
"""
import argparse
import os

import qrcode
from PIL import Image, ImageDraw, ImageFont
from qrcode.image.styledpil import StyledPilImage
from qrcode.image.styles.colormasks import SolidFillColorMask
from qrcode.image.styles.moduledrawers.pil import RoundedModuleDrawer

OUT_DIR = "D:/ai/油炸小程序"

DEFAULT_BASE_URL = "https://xaingdepibao.icu"

# ---- 配色 ----
CREAM = (255, 248, 238)
BROWN = (58, 36, 23)      # 点单码：品牌深棕
GREEN = (26, 74, 56)      # 商家码：墨绿，与点单码强区分
GOLD = (212, 158, 78)
MEAT = (196, 88, 50)
MEAT_DARK = (150, 60, 30)
CLIP = (196, 150, 96)
CLIP_DARK = (140, 100, 56)

FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_REG = "C:/Windows/Fonts/msyh.ttc"


def build_qr(link, front_color):
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, box_size=24, border=4)
    qr.add_data(link)
    qr.make(fit=True)
    return qr.make_image(
        image_factory=StyledPilImage,
        module_drawer=RoundedModuleDrawer(),
        color_mask=SolidFillColorMask(back_color=CREAM, front_color=front_color),
    ).convert("RGB")


def draw_skewer_logo(size):
    """点单码标志：竹签 + 三块肉 + 「嘎嘎香」。"""
    s = 4
    img = Image.new("RGBA", (size * s, size * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = size * s / 100.0

    d.line([(25 * u, 78 * u), (80 * u, 18 * u)], fill=GOLD, width=int(4.5 * u))
    d.ellipse([78 * u - 3.2 * u, 15 * u - 3.2 * u, 78 * u + 3.2 * u, 15 * u + 3.2 * u], fill=GOLD)

    cx, cy = 43 * u, 61 * u
    for dx, dy, r, col in [(-13, 8, 15, MEAT_DARK), (2, -2, 16, MEAT), (16, -13, 13, MEAT_DARK)]:
        x, y = cx + dx * u, cy + dy * u
        rr = r * u
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=col)
        d.ellipse([x - rr * 0.45, y - rr * 0.55, x - rr * 0.05, y - rr * 0.15], fill=(255, 255, 255, 70))

    img = img.resize((size, size), Image.LANCZOS)

    text = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    td = ImageDraw.Draw(text)
    font = ImageFont.truetype(FONT_BOLD, int(size * 0.22))
    box = td.textbbox((0, 0), "嘎嘎香", font=font)
    td.text(((size - (box[2] - box[0])) / 2 - box[0], size * 0.72), "嘎嘎香", font=font, fill=BROWN)
    return Image.alpha_composite(img, text)


def draw_clipboard_logo(size, ink):
    """商家码标志：剪贴板 + 订单行 + 「商家」。"""
    s = 4
    img = Image.new("RGBA", (size * s, size * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = size * s / 100.0

    # 板身
    d.rounded_rectangle([18 * u, 14 * u, 82 * u, 80 * u], radius=int(7 * u), fill=CLIP)
    # 顶部夹子
    d.rounded_rectangle([40 * u, 7 * u, 60 * u, 20 * u], radius=int(3.5 * u), fill=CLIP_DARK)
    # 纸上内容行
    d.rounded_rectangle([26 * u, 26 * u, 74 * u, 32 * u], radius=int(2 * u), fill=(255, 255, 255))
    for i in range(3):
        y = 40 * u + i * 12 * u
        d.rounded_rectangle([26 * u, y, 66 * u, y + 5 * u], radius=int(2.2 * u), fill=(255, 255, 255))

    img = img.resize((size, size), Image.LANCZOS)

    text = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    td = ImageDraw.Draw(text)
    font = ImageFont.truetype(FONT_BOLD, int(size * 0.24))
    box = td.textbbox((0, 0), "商家", font=font)
    td.text(((size - (box[2] - box[0])) / 2 - box[0], size * 0.72), "商家", font=font, fill=ink)
    return Image.alpha_composite(img, text)


def paste_logo(qr_img, logo_fn, ink):
    """把标志贴到二维码中央（米白圆角底）。"""
    W, H = qr_img.size
    box = int(W * 0.26)
    pad = int(box * 0.16)
    plate = Image.new("RGB", (box, box), CREAM)
    plate.paste(logo_fn(box - pad * 2), (pad, pad), logo_fn(box - pad * 2))

    mask = Image.new("L", (box, box), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, box - 1, box - 1], radius=int(box * 0.18), fill=255)
    qr_img.paste(plate, ((W - box) // 2, (H - box) // 2), mask)
    return qr_img


def make_poster(qr_img, ink, title, sub, warn=None):
    """海报版：码 + 品牌头 + 底部说明。"""
    W, H = qr_img.size
    margin, footer = 60, 165
    canvas = Image.new("RGB", (W + margin * 2, H + margin * 2 + footer), CREAM)
    canvas.paste(qr_img, (margin, margin))
    d = ImageDraw.Draw(canvas)
    CW = canvas.width

    d.rectangle([0, 0, CW, 10], fill=ink)

    f_name = ImageFont.truetype(FONT_BOLD, 52)
    f_sub = ImageFont.truetype(FONT_REG, 30)
    f_warn = ImageFont.truetype(FONT_REG, 24)

    y0 = H + margin * 2 - footer + 26
    b1 = d.textbbox((0, 0), title, font=f_name)
    d.text(((CW - (b1[2] - b1[0])) / 2 - b1[0], y0), title, font=f_name, fill=ink)

    b2 = d.textbbox((0, 0), sub, font=f_sub)
    d.text(((CW - (b2[2] - b2[0])) / 2 - b2[0], y0 + 74), sub, font=f_sub, fill=(120, 90, 70))

    if warn:
        b3 = d.textbbox((0, 0), warn, font=f_warn)
        d.text(((CW - (b3[2] - b3[0])) / 2 - b3[0], y0 + 118), warn, font=f_warn, fill=(176, 74, 60))
    return canvas


def center_text(img, y, text, font, fill):
    d = ImageDraw.Draw(img)
    b = d.textbbox((0, 0), text, font=font)
    d.text(((img.width - (b[2] - b[0])) / 2 - b[0], y), text, font=font, fill=fill)


def main():
    parser = argparse.ArgumentParser(description="生成点单码和商家码")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="正式站点根地址")
    parser.add_argument("--label", default="正式", help="文件名标签")
    parser.add_argument("--out-dir", default=OUT_DIR, help="图片输出目录")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    if not base.startswith(("https://", "http://")):
        raise SystemExit("--base-url 必须以 http:// 或 https:// 开头")

    os.makedirs(args.out_dir, exist_ok=True)
    made = []
    tag = args.label.strip() or "正式"

    # ---- 点单码 ----
    qr = build_qr(base + "/", BROWN)
    qr = paste_logo(qr, draw_skewer_logo, BROWN)
    poster = make_poster(
        qr.copy(), BROWN,
        "嘎嘎香 · 乐山油炸串串",
        "扫码点单 · 每天营业 17:00 - 次日 00:30",
    )
    p1 = os.path.join(args.out_dir, f"点单码-{tag}-海报.png")
    p2 = os.path.join(args.out_dir, f"点单码-{tag}-纯码.png")
    poster.save(p1, quality=95)
    qr.save(p2)
    made += [p1, p2]

    # ---- 商家码 ----
    qa = build_qr(base + "/admin", GREEN)
    qa = paste_logo(qa, lambda s: draw_clipboard_logo(s, GREEN), GREEN)
    poster_a = make_poster(
        qa.copy(), GREEN,
        "商家后台 · 嘎嘎香",
        "扫码登录 · 需输入商家口令",
        warn="商家专用 · 请勿张贴给顾客",
    )
    p3 = os.path.join(args.out_dir, f"商家码-{tag}-海报.png")
    p4 = os.path.join(args.out_dir, f"商家码-{tag}-纯码.png")
    poster_a.save(p3, quality=95)
    qa.save(p4)
    made += [p3, p4]

    for p in made:
        print("已保存:", p, os.path.getsize(p) // 1024, "KB")


if __name__ == "__main__":
    main()
