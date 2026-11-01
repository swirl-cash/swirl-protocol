from pathlib import Path
import json
import zipfile

extension = Path(__file__).resolve().parent.parent
dist = extension / "dist"
manifest = json.loads((dist / "manifest.json").read_text(encoding="utf-8"))
output = extension / "artifacts" / f"swirl-extension-{manifest['version']}.zip"
output.parent.mkdir(parents=True, exist_ok=True)

with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for file in sorted(dist.rglob("*")):
        plain_proving_source = file.parent.name == "proving" and file.suffix in {".wasm", ".zkey"}
        if file.is_file() and file.name != "deployment.local.json" and not plain_proving_source:
            archive.write(file, file.relative_to(dist).as_posix())

with zipfile.ZipFile(output) as archive:
    names = archive.namelist()
    assert "manifest.json" in names
    assert "deployment.local.json" not in names
    assert not any(name.startswith("proving/") and name.endswith((".wasm", ".zkey")) for name in names)
    assert archive.testzip() is None
    bundled = json.loads(archive.read("manifest.json"))
    assert bundled["version"] == manifest["version"]
    print(json.dumps({"file": str(output), "version": bundled["version"], "files": len(names), "bytes": output.stat().st_size}, indent=2))
