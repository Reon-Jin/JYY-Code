"""Optional persistent EasyOCR worker for unlabeled desktop controls."""
import json
import sys
import time
import numpy as np
from PIL import Image

try:
    import easyocr
    import torch

    reader = easyocr.Reader(["ch_sim", "en"], gpu=torch.cuda.is_available(), download_enabled=False, verbose=False)
    print(json.dumps({"ready": True}), flush=True)
except Exception as error:
    print(json.dumps({"ready": False, "error": str(error)}), flush=True)
    raise SystemExit(1)

for line in sys.stdin:
    try:
        request = json.loads(line)
        started = time.perf_counter()
        image = Image.open(request["imagePath"]).convert("RGB")
        region = request.get("region")
        offset_x = offset_y = 0
        if region:
            offset_x, offset_y = int(region["x"]), int(region["y"])
            width, height = int(region["width"]), int(region["height"])
            if width < 1 or height < 1 or offset_x < 0 or offset_y < 0 or offset_x + width > image.width or offset_y + height > image.height:
                raise ValueError("OCR region is outside screenshot")
            image = image.crop((offset_x, offset_y, offset_x + width, offset_y + height))
        tokens = []
        for corners, text, confidence in reader.readtext(np.array(image), detail=1):
            xs = [point[0] for point in corners]
            ys = [point[1] for point in corners]
            x, y = round(min(xs)) + offset_x, round(min(ys)) + offset_y
            width, height = round(max(xs) - min(xs)), round(max(ys) - min(ys))
            if text.strip() and width >= 2 and height >= 2:
                tokens.append({"text": text.strip(), "box": {"x": x, "y": y, "width": width, "height": height}, "confidence": round(float(confidence), 5)})
        print(json.dumps({"id": request["id"], "tokens": tokens, "inferMs": round((time.perf_counter() - started) * 1000, 2)}, ensure_ascii=False), flush=True)
    except Exception as error:
        print(json.dumps({"id": request.get("id") if "request" in locals() else None, "error": str(error)}), flush=True)
