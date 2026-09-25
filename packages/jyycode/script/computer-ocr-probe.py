"""Measure optional EasyOCR on public synthetic UI fixtures."""
import json
import sys
import time
from pathlib import Path

import easyocr

image = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "test/tool/fixtures/computer-synthetic-96.png"
started = time.perf_counter()
reader = easyocr.Reader(["ch_sim", "en"], gpu=True, download_enabled=False, verbose=False)
load_ms = round((time.perf_counter() - started) * 1000)
runs = []
for _ in range(3):
    started = time.perf_counter()
    result = reader.readtext(str(image), detail=1)
    runs.append({"milliseconds": round((time.perf_counter() - started) * 1000), "tokens": len(result)})
print(json.dumps({"image": image.name, "loadMs": load_ms, "runs": runs, "synthetic": True}))
