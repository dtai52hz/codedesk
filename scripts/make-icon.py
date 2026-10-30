"""Rebuild the small, code-native app mark. Requires Pillow only for this script."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
out = root / "resources"
out.mkdir(exist_ok=True)
image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((10, 10, 502, 502), radius=112, fill="#191b20", outline="#383a42", width=3)
draw.line([(195, 164), (112, 256), (195, 348)], fill="#f2a66e", width=30, joint="curve")
draw.line([(317, 164), (400, 256), (317, 348)], fill="#f2a66e", width=30, joint="curve")
draw.line([(282, 140), (230, 372)], fill="#f0ece6", width=24)
image.save(out / "icon.png")
image.save(out / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
