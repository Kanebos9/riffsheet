#!/usr/bin/env python3
"""Riffsheet's sidecar for anime-song/instrument-agnostic-amt.

Riffsheet runs this with the interpreter of the virtual environment the
installer built, from `<appSupport>/engines/bass-v2/`, once per transcription;
the process exits when the transcription does, which is the one-job rule the
rest of the app keeps for every engine.

WHY THERE IS A SCRIPT AT ALL. Upstream's entry point is `infer.py`, which takes
a checkpoint path and writes a MIDI file. Riffsheet needs two things it does not
do: pick the checkpoint from what the user asked to hear, and hand back notes
rather than a file. Both are five lines, and doing them here rather than in C++
keeps the C++ side one class that runs a program and reads one JSON object -
which is what makes every subprocess engine the same class.

It calls upstream's own `main()` with the arguments the audition proved, rather
than reimplementing the inference: `--type bass_v2 --checkpoint <ckpt> --audio
<wav> --output-midi <mid> --device cpu --window-batch-size 1`.

The output on stdout is one JSON object on the last line:

    {"notes": [{"start": 0.51, "end": 0.83, "pitch": 40, "velocity": 78,
                "instrument": "electric_bass"}],
     "instrument": "electric_bass", "modelType": "bass_v2", "error": null}

and the MIDI file is left where --output-midi asked for it, so the shell can
hand the user the engine's own MIDI rather than one rebuilt from the notes.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# The instrument names the bass checkpoint is the right answer for. Anything
# else - or a mixture - goes to the general checkpoint, which knows all of the
# model's instrument classes and is the one upstream ships as the default.
BASS_NAMES = {
    "bass",
    "electric_bass",
    "electric bass",
    "acoustic_bass",
    "acoustic bass",
    "double_bass",
    "double bass",
    "upright_bass",
    "upright bass",
    "bass_guitar",
    "bass guitar",
    "synth_bass",
    "synth bass",
}


def _emit(payload: dict) -> None:
    print(json.dumps(payload), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Riffsheet <-> instrument-agnostic-amt")
    parser.add_argument("--root", required=True, help="the installed engine directory")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output-midi", required=True)
    parser.add_argument("--output-json", default=None)
    # "any" rather than "" for the unconstrained case: juce::ChildProcess drops
    # an empty argument when it builds argv, so an empty value would arrive as a
    # missing one. The shell always sends a word.
    parser.add_argument("--instruments", default="any",
                        help="comma separated instrument names, or \"any\"")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--window-batch-size", type=int, default=1)
    args = parser.parse_args()

    root = Path(args.root)
    repo = root / "repo"

    if not (repo / "infer.py").exists():
        _emit({"notes": [], "error": f"the engine files are missing from {repo}"})
        return 1

    # Upstream imports its own package by name and reads nothing relative to the
    # working directory except through paths we pass absolutely, but chdir keeps
    # anything it adds later honest too.
    sys.path.insert(0, str(repo))
    os.chdir(repo)

    wanted = [
        name.strip().lower()
        for name in args.instruments.split(",")
        if name.strip() and name.strip().lower() != "any"
    ]
    use_bass = (not wanted) or all(name in BASS_NAMES for name in wanted)

    model_type = "bass_v2" if use_bass else "default"
    checkpoint = root / "checkpoints" / (
        "best_model_bass_v2.pth" if use_bass else "best_model.pth"
    )

    if not checkpoint.exists():
        _emit({"notes": [], "error": f"the checkpoint is missing at {checkpoint}"})
        return 1

    output_midi = Path(args.output_midi)
    output_midi.parent.mkdir(parents=True, exist_ok=True)

    # Upstream's own argument parser, upstream's own main(): the invocation is
    # exactly the one that was measured, and nothing about the model is
    # reimplemented here.
    sys.argv = [
        "infer.py",
        "--type", model_type,
        "--checkpoint", str(checkpoint),
        "--audio", str(Path(args.audio)),
        "--output-midi", str(output_midi),
        "--device", args.device,
        "--window-batch-size", str(args.window_batch_size),
        "--disable-tqdm",
    ]

    from instrument_agnostic_amt.cli.infer import main as upstream_main

    upstream_main()

    if not output_midi.exists():
        _emit({"notes": [], "error": "the engine finished without writing a MIDI file"})
        return 1

    import pretty_midi

    midi = pretty_midi.PrettyMIDI(str(output_midi))
    notes = []

    for instrument in midi.instruments:
        label = (instrument.name or "").strip()

        for note in instrument.notes:
            notes.append(
                {
                    "start": round(float(note.start), 6),
                    "end": round(float(note.end), 6),
                    "pitch": int(note.pitch),
                    "velocity": int(note.velocity),
                    "instrument": label,
                }
            )

    notes.sort(key=lambda note: (note["start"], note["pitch"]))

    labels = [note["instrument"] for note in notes if note["instrument"]]
    payload = {
        "notes": notes,
        # One label for the whole take when every note agrees, "" when they do
        # not - the shell uses it only for the notes that carry none of their own.
        "instrument": labels[0] if labels and len(set(labels)) == 1 else "",
        "modelType": model_type,
        "error": None,
    }

    if args.output_json:
        Path(args.output_json).write_text(json.dumps(payload), encoding="utf-8")

    _emit(payload)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as failure:  # noqa: BLE001 - the shell needs the sentence, not a traceback
        import traceback

        traceback.print_exc()
        _emit({"notes": [], "error": f"{type(failure).__name__}: {failure}"})
        sys.exit(1)
