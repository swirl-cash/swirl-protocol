from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[1] / "public" / "icons"
root.mkdir(parents=True, exist_ok=True)
source = Image.open(root / "logo-dark-bg.png").convert("RGB")
for size in (16, 32, 48, 128):
    image = source.resize((size, size), Image.Resampling.LANCZOS)
    image.save(root / f"icon-{size}.png", optimize=True)
print("Generated extension icons from the official SWIRL logo")
