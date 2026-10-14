# -*- coding: utf-8 -*-
"""生成扩展图标：圆角方形 + 蓝紫渐变 + 白色「译」字 + 右下角小对话气泡点。"""
from PIL import Image, ImageDraw, ImageFont

FONT_PATH = r"C:\Windows\Fonts\msyh.ttc"

def rounded_gradient(size, r1=(79, 70, 229), r2=(14, 165, 233)):
    """对角渐变圆角方形底板。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGBA", (size, size))
    px = grad.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size - 2)
            px[x, y] = (
                int(r1[0] + (r2[0] - r1[0]) * t),
                int(r1[1] + (r2[1] - r1[1]) * t),
                int(r1[2] + (r2[2] - r1[2]) * t),
                255,
            )
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    radius = int(size * 0.22)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)
    return img

def make_icon(size):
    img = rounded_gradient(size)
    draw = ImageDraw.Draw(img)

    # 「译」字居中偏上
    font_size = int(size * 0.52)
    try:
        font = ImageFont.truetype(FONT_PATH, font_size)
    except OSError:
        font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), "译", font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1] - size * 0.02
    draw.text((x, y), "译", font=font, fill=(255, 255, 255, 255))

    # 右下角小圆点（对话气泡尾点，强调"翻译气泡"的意象）
    r = max(2, int(size * 0.055))
    cx, cy = int(size * 0.82), int(size * 0.84)
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 235))

    return img

if __name__ == "__main__":
    import os
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
    os.makedirs(out_dir, exist_ok=True)
    for s in (16, 48, 128):
        icon = make_icon(s)
        path = os.path.join(out_dir, f"icon{s}.png")
        icon.save(path)
        print("saved", path)
