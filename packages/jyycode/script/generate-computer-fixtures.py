"""Generate public synthetic UI screenshots; no user's desktop is captured."""
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


OUT = Path(__file__).resolve().parents[1] / "test" / "tool" / "fixtures"
OUT.mkdir(parents=True, exist_ok=True)
font_path = Path("C:/Windows/Fonts/msyh.ttc")
font = ImageFont.truetype(str(font_path), 22) if font_path.exists() else ImageFont.load_default()
small = ImageFont.truetype(str(font_path), 15) if font_path.exists() else ImageFont.load_default()

image = Image.new("RGB", (1280, 720), "#f3f5f8")
draw = ImageDraw.Draw(image)
draw.rectangle((0, 0, 1279, 47), fill="#29364b")
draw.text((22, 10), "Synthetic Editor · 合成界面", fill="white", font=font)
draw.rectangle((0, 48, 1279, 111), fill="#ffffff")
targets = {
    "save": (48, 60, 148, 101),
    "open": (166, 60, 266, 101),
    "icon_only": (1210, 63, 1246, 99),
    "search": (235, 164, 830, 208),
    "tiny_icon": (1142, 161, 1158, 177),
}
for key, text in [("save", "保存 Save"), ("open", "打开 Open")]:
    box = targets[key]
    draw.rounded_rectangle(box, radius=7, fill="#dce9fb", outline="#4786cf", width=2)
    draw.text((box[0] + 8, box[1] + 8), text, fill="#1d3f68", font=small)
draw.rounded_rectangle(targets["icon_only"], radius=6, fill="#e7ecf3", outline="#7190b2", width=2)
draw.line((1219, 81, 1236, 81), fill="#2c587d", width=3)
draw.line((1227, 72, 1227, 90), fill="#2c587d", width=3)
draw.rectangle((0, 112, 188, 719), fill="#e6ebf2")
draw.text((27, 152), "文件", fill="#1d3654", font=font)
draw.text((27, 202), "最近使用", fill="#3c536d", font=small)
draw.rounded_rectangle(targets["search"], radius=6, fill="white", outline="#a9b9ca", width=2)
draw.text((252, 173), "搜索设置 Search settings", fill="#67798d", font=small)
draw.rectangle(targets["tiny_icon"], fill="#d7e7f8", outline="#3777ba", width=1)
draw.line((1145, 169, 1155, 169), fill="#2c587d", width=1)
draw.rectangle((215, 245, 1190, 635), fill="white", outline="#cbd5e1", width=2)
draw.text((246, 275), "Workspace 工作区", fill="#233c59", font=font)
draw.rectangle((641, 292, 1010, 505), fill="#fefefe", outline="#8493a6", width=2)
draw.text((670, 318), "覆盖面板 · Overlay", fill="#324c68", font=small)
draw.rounded_rectangle((868, 444, 976, 486), radius=6, fill="#2c77c8")
draw.text((890, 452), "确定", fill="white", font=small)

manifest = []
for scale, dpi in [(1, 96), (1.5, 144), (2, 192)]:
    width, height = round(1280 * scale), round(720 * scale)
    scaled = image.resize((width, height), Image.Resampling.BICUBIC)
    name = f"computer-synthetic-{dpi}.png"
    scaled.save(OUT / name, optimize=True)
    manifest.append({
        "name": name,
        "dpi": dpi,
        "screen": {"x": -width if dpi == 192 else 0, "y": 0, "width": width, "height": height},
        "targets": {key: [round(v * scale) for v in box] for key, box in targets.items()},
        "limitations": "Synthetic geometry and parser smoke only; not a detector accuracy benchmark",
    })
(OUT / "computer-synthetic.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
