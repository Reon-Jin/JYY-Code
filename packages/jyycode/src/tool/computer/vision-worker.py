"""Persistent, local OmniParser icon_detect_v3 detector.

Protocol: newline-delimited JSON on stdin/stdout. Images stay on this machine.
The MIT-licensed model weight is provisioned separately in the Hugging Face cache.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torchvision.ops import nms


IMAGE_SIZE = 1280
STRIDES = (8, 16, 32)
CONFIDENCE = 0.05
IOU = 0.45


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def detect(model, device, image_path, region=None):
    image = Image.open(image_path).convert("RGB")
    offset_x = offset_y = 0
    if region:
        offset_x, offset_y = int(region["x"]), int(region["y"])
        width, height = int(region["width"]), int(region["height"])
        if width < 1 or height < 1 or offset_x < 0 or offset_y < 0 or offset_x + width > image.width or offset_y + height > image.height:
            raise ValueError("region is outside screenshot")
        image = image.crop((offset_x, offset_y, offset_x + width, offset_y + height))
    width, height = image.size
    scale = min(IMAGE_SIZE / width, IMAGE_SIZE / height)
    resized = image.resize((round(width * scale), round(height * scale)), Image.Resampling.BILINEAR)
    canvas = Image.new("RGB", (IMAGE_SIZE, IMAGE_SIZE), (114, 114, 114))
    canvas.paste(resized, (0, 0))
    tensor = torch.from_numpy(np.array(canvas)).permute(2, 0, 1).float()[None].to(device) / 255.0
    with torch.inference_mode():
        outputs = model(tensor)
        boxes, scores = [], []
        for index, stride in enumerate(STRIDES):
            cls = outputs[2 * index].sigmoid()[0, 0]
            distances = outputs[2 * index + 1][0]
            grid_y, grid_x = torch.meshgrid(
                torch.arange(cls.shape[-2], dtype=torch.float32, device=device),
                torch.arange(cls.shape[-1], dtype=torch.float32, device=device),
                indexing="ij",
            )
            center_x, center_y = grid_x + 0.5, grid_y + 0.5
            left, top, right, bottom = distances
            boxes.append(torch.stack([
                (center_x - left) * stride, (center_y - top) * stride,
                (center_x + right) * stride, (center_y + bottom) * stride,
            ], dim=-1).reshape(-1, 4))
            scores.append(cls.reshape(-1))
        boxes, scores = torch.cat(boxes), torch.cat(scores)
        keep = scores > CONFIDENCE
        boxes, scores = boxes[keep].cpu(), scores[keep].cpu()
    if boxes.numel() == 0:
        return []
    chosen = nms(boxes, scores, IOU)[:512]
    boxes, scores = boxes[chosen] / scale, scores[chosen]
    boxes[:, 0::2] = boxes[:, 0::2].clamp(0, width)
    boxes[:, 1::2] = boxes[:, 1::2].clamp(0, height)
    result = []
    for (x1, y1, x2, y2), score in zip(boxes.tolist(), scores.tolist()):
        x, y = round(x1) + offset_x, round(y1) + offset_y
        w, h = round(x2) - round(x1), round(y2) - round(y1)
        if w >= 2 and h >= 2:
            result.append({"x": x, "y": y, "width": w, "height": h, "confidence": round(score, 5)})
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = parser.parse_args()
    if not Path(args.model).is_file():
        emit({"ready": False, "error": "model weight is missing"})
        return 1
    device = torch.device(args.device)
    started = time.perf_counter()
    model = torch.jit.load(args.model, map_location=device).eval()
    warm = torch.zeros((1, 3, IMAGE_SIZE, IMAGE_SIZE), dtype=torch.float32, device=device)
    with torch.inference_mode():
        model(warm)
        model(warm)
    if device.type == "cuda":
        torch.cuda.synchronize()
    load_ms = round((time.perf_counter() - started) * 1000, 2)
    emit({"ready": True, "device": str(device), "loadMs": load_ms})
    for line in sys.stdin:
        try:
            request = json.loads(line)
            started = time.perf_counter()
            boxes = detect(model, device, request["imagePath"], request.get("region"))
            if device.type == "cuda":
                torch.cuda.synchronize()
            emit({"id": request["id"], "boxes": boxes, "inferMs": round((time.perf_counter() - started) * 1000, 2)})
        except Exception as error:
            emit({"id": request.get("id") if "request" in locals() else None, "error": str(error)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
