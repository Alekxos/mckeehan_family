"""Write 480px-wide JPEG thumbnails: thumbs.py OUT_DIR image [image ...]"""
import os
import sys

from PIL import Image, ImageOps

out = sys.argv[1]
for src in sys.argv[2:]:
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        im.thumbnail((480, 480))
        im.save(os.path.join(out, os.path.basename(src)), "JPEG", quality=82, optimize=True)
