"""Cut square face portraits for tree cards.

Reads a JSON list on stdin: [{"src": path, "out": path, "face": [cx, cy] | null, "size": frac | null}]
face is the crop centre as fractions of width and height; size is the crop side as a
fraction of the width. Without them, takes the largest centred square, nudged up on
tall photos where faces sit near the top.
"""
import json
import sys

from PIL import Image, ImageOps

PX = 160
for job in json.load(sys.stdin):
    with Image.open(job["src"]) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        w, h = im.size
        if job.get("face"):
            side = min(w, h, max(8, round((job.get("size") or 0.3) * w)))
            cx, cy = job["face"][0] * w, job["face"][1] * h
        else:
            side = min(w, h)
            cx, cy = w / 2, (side / 2 + (h - side) * 0.15) if h > w else h / 2
        left = min(max(0, round(cx - side / 2)), w - side)
        top = min(max(0, round(cy - side / 2)), h - side)
        im = im.crop((left, top, left + side, top + side)).resize((PX, PX), Image.LANCZOS)
        im = ImageOps.autocontrast(im, cutoff=0.5)
        im.save(job["out"], "JPEG", quality=85, optimize=True)
