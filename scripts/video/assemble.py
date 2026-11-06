#!/usr/bin/env python3
"""Fit each recorded scene to its voice-over and join them. A scene longer than its narration is sped
up, and it says so on screen; a shorter one holds its last frame. Output: var/video/shadow-run-demo.mp4."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "var" / "video"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def probe(path: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


def main() -> int:
    scenes = json.loads((OUT / "scenes.json").read_text())
    parts = []
    for s in scenes:
        video = OUT / f"scene-{s['id']}.webm"
        seconds = s["seconds"] + 0.35
        trim_file = OUT / f"scene-{s['id']}.trim"
        trim = float(trim_file.read_text()) if trim_file.exists() else 0.0
        have = probe(video) - trim
        hold = min(float(s.get("hold", 0)), max(0.0, seconds - 1), have)
        speed = (have - hold) / max(0.1, seconds - hold)
        part = OUT / f"part-{s['id']}.mp4"
        base = "fps=30,scale=1600:900"
        label = f",drawtext=fontfile={FONT}:text='sped up {speed:.1f}x':x=w-tw-28:y=h-th-24:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8" if Path(FONT).exists() else ""
        if speed > 1.08:
            # Speed through the waiting, and label it. The last few seconds, the result, stay at real speed.
            cut = have - hold
            fast = f"[0:v]{base},trim=0:{cut:.3f},setpts=(PTS-STARTPTS)/{speed:.4f}{label}[f]"
            if hold > 0:
                graph = f"{fast};[0:v]{base},trim={cut:.3f},setpts=PTS-STARTPTS[h];[f][h]concat=n=2:v=1:a=0[v]"
            else:
                graph = fast.replace("[f]", "[v]")
        else:
            graph = f"[0:v]{base},tpad=stop_mode=clone:stop_duration={max(0.0, seconds - have):.3f}[v]"
        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error", "-ss", f"{trim:.2f}", "-i", str(video), "-i", s["audio"],
            "-filter_complex", f"{graph};[1:a]apad=whole_dur={seconds:.3f}[a]",
            "-map", "[v]", "-map", "[a]", "-t", f"{seconds:.3f}", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", str(part),
        ], check=True)
        parts.append(part)
        print(s["id"], f"video {have:.1f}s -> {seconds:.1f}s (speed {speed:.2f})", flush=True)
    listing = OUT / "parts.txt"
    listing.write_text("".join(f"file '{p}'\n" for p in parts))
    final = OUT / "shadow-run-demo.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", "-movflags", "+faststart", str(final)], check=True)
    d = probe(final)
    print(f"wrote {final}, {d:.1f} s, {final.stat().st_size / 1e6:.1f} MB")
    return 0 if d <= 180 else 1


if __name__ == "__main__":
    sys.exit(main())
