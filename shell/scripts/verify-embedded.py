"""Compare the webcore JavaScript embedded in installed macOS binaries with webcore/dist."""
import argparse
import hashlib
import io
import pathlib
import struct
import sys
import zipfile

REPO = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_DIST = REPO / "webcore" / "dist" / "assets" / "main.js"
DEFAULT_TARGETS = [
    pathlib.Path.home() / "Library/Audio/Plug-Ins/VST3/Riffsheet.vst3/Contents/MacOS/Riffsheet",
    pathlib.Path.home() / "Library/Audio/Plug-Ins/Components/Riffsheet.component/Contents/MacOS/Riffsheet",
    pathlib.Path("/Applications/Riffsheet.app/Contents/MacOS/Riffsheet"),
]

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("targets", nargs="*", type=pathlib.Path, help="Mach-O binaries to inspect")
parser.add_argument("--dist", type=pathlib.Path, default=DEFAULT_DIST, help="built assets/main.js")
args = parser.parse_args()

targets = args.targets or DEFAULT_TARGETS
missing = [path for path in [args.dist, *targets] if not path.is_file()]
if missing:
    for path in missing:
        print(f"missing: {path}", file=sys.stderr)
    raise SystemExit(2)

want = hashlib.sha256(args.dist.read_bytes()).hexdigest()
print(f"dist assets/main.js sha256 {want[:16]}  ({args.dist.stat().st_size} bytes)")
ok = True
for target in targets:
    data = target.read_bytes()
    found = None
    # Scan for local file headers and try to open a zip at each End-Of-Central-Directory.
    idx = 0
    while True:
        idx = data.find(b"PK\x05\x06", idx)
        if idx < 0:
            break
        # walk backwards for the start of the archive using the central directory offset
        try:
            cd_size, cd_off = struct.unpack("<II", data[idx+12:idx+20])
            start = idx - cd_size - cd_off
            if start >= 0:
                z = zipfile.ZipFile(io.BytesIO(data[start:idx+22]))
                names = z.namelist()
                if any(n.endswith("assets/main.js") for n in names):
                    n = [x for x in names if x.endswith("assets/main.js")][0]
                    found = hashlib.sha256(z.read(n)).hexdigest()
                    break
        except Exception:
            pass
        idx += 4
    mark = "OK " if found == want else "MISMATCH"
    if found != want:
        ok = False
    print(f"  {mark} {target.name:28} {(found or 'no zip found')[:16]}")
sys.exit(0 if ok else 1)
