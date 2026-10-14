"""Regenerate sounds/sounds.json from the audio files in sounds/.

Existing entries keep their name, color and position; new files are appended
with a name derived from the filename; entries for deleted files are dropped.
"""
import json
import pathlib
import re

SOUNDS = pathlib.Path(__file__).resolve().parents[2] / "sounds"
MANIFEST = SOUNDS / "sounds.json"
AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".flac", ".webm"}
COLORS = ["#ff3b6b", "#00d1ff", "#ffd400", "#3ddc84", "#b44dff", "#ff8a00", "#5b6cff", "#ff4dd2"]


def pretty(stem: str) -> str:
    words = re.sub(r"[-_]+", " ", stem).split()
    return " ".join(w if w.isupper() else w.capitalize() for w in words) or stem


try:
    existing = json.loads(MANIFEST.read_text(encoding="utf-8"))
except (FileNotFoundError, json.JSONDecodeError):
    existing = []

files = sorted(
    p.name for p in SOUNDS.iterdir()
    if p.is_file() and p.suffix.lower() in AUDIO_EXTS
)
present = set(files)
entries = [e for e in existing if isinstance(e, dict) and e.get("file") in present]
known = {e["file"] for e in entries}

for name in files:
    if name not in known:
        entries.append({
            "file": name,
            "name": pretty(pathlib.Path(name).stem),
            "color": COLORS[len(entries) % len(COLORS)],
        })

MANIFEST.write_text(json.dumps(entries, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"sounds.json: {len(entries)} sound(s)")
for e in entries:
    print(f"  - {e['name']} ({e['file']})")
