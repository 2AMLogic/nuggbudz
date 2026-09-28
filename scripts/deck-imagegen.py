#!/usr/bin/env python3
"""Run anvil's ``deck-imagegen`` for a pitch thread and write image sidecars.

Usage, from the repo root:

    PYTHONPATH=.anvil python3 scripts/deck-imagegen.py nuggbudz-hackathon

Everything about *what* gets generated lives elsewhere — the markers in
``deck.md``, the prompts in ``speaker-notes.md``, the preset in
``.anvil/skills/deck/assets/imagery-style-presets.md``, the backend in
``.anvil/config.json``. This file only supplies this repo's paths and
closes the one gap between two contracts that were written separately:

- **anvil** records a run in ``assets/_prompts.json`` (prompt, style,
  backend, per slot) and hands the adapter nowhere to write a file.
- **the cross-repo image policy** requires every ``foo.png`` to sit beside
  a ``foo.png.json`` carrying the prompt, model, hash and timestamp,
  because an image in the tree without its sidecar is unattributed
  content.

``imagine`` already writes exactly that sidecar — into the temporary
directory the adapter hands it, which dies with the call. So the adapter
keeps each record in ``anvil_imagery_backend.DISPATCHES`` and this script
pairs them with the slots anvil reports. The pairing is positional, which
is sound because anvil's contract guarantees serial dispatch in markdown
order and the adapter is called once per generated slot; a mismatch in
length is treated as a failure rather than guessed at.

The committed PNG is hashed here rather than trusting the CLI's hash: the
adapter normalises JPEG to PNG, so the bytes on disk are not always the
bytes the provider returned. ``sha256`` stays whatever ``imagine`` said
about the provider's bytes; ``png_sha256`` is the file in the tree.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / ".anvil"))

import scripts.anvil_imagery_backend as backend  # noqa: E402
from anvil.skills.deck.lib.imagegen import run_imagegen  # noqa: E402

PORTFOLIO = REPO_ROOT / "docs" / "pitch"
CONFIG = REPO_ROOT / ".anvil" / "config.json"
PRESETS = REPO_ROOT / ".anvil" / "skills" / "deck" / "assets" / "imagery-style-presets.md"


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} <thread-slug>", file=sys.stderr)
        return 2
    thread = argv[1]

    result = run_imagegen(
        thread,
        portfolio=PORTFOLIO,
        config_path=CONFIG,
        presets_path=PRESETS,
    )
    print(result.message)

    generated = [slot for slot in result.slots if slot.status == "generated"]
    for slot in result.slots:
        detail = f" — {slot.error}" if slot.error else ""
        print(f"  {slot.slot}: {slot.status}{detail}")

    if len(generated) != len(backend.DISPATCHES):
        print(
            f"ERROR: anvil reported {len(generated)} generated slot(s) but the "
            f"adapter recorded {len(backend.DISPATCHES)} call(s); refusing to "
            f"guess which sidecar belongs to which image.",
            file=sys.stderr,
        )
        return 1

    version_dir = _version_dir_for(thread)
    if version_dir is None:
        if generated:
            print("ERROR: could not locate the version dir for the sidecars", file=sys.stderr)
            return 1
        return 0

    out_dir = version_dir / "assets" / "generated"
    for slot, record in zip(generated, backend.DISPATCHES):
        png = out_dir / f"{slot.slot}.png"
        sidecar = dict(record)
        sidecar["slot"] = slot.slot
        sidecar["thread"] = thread
        sidecar["version_dir"] = version_dir.name
        sidecar["style"] = slot.style
        sidecar["steps"] = slot.steps
        sidecar["backend"] = "scripts.anvil_imagery_backend:Backend"
        sidecar["png_sha256"] = hashlib.sha256(png.read_bytes()).hexdigest()
        (out_dir / f"{slot.slot}.png.json").write_text(
            json.dumps(sidecar, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        print(f"  wrote {slot.slot}.png.json")

    _prune_orphan_sidecars(out_dir)
    return 0 if result.phase_state in {"done", "skipped"} else 1


def _version_dir_for(thread: str) -> Path | None:
    """Highest-numbered ``<thread>.{N}/`` under the thread root."""
    root = PORTFOLIO / thread
    candidates = sorted(
        (p for p in root.glob(f"{thread}.*") if p.is_dir() and p.name.split(".")[-1].isdigit()),
        key=lambda p: int(p.name.split(".")[-1]),
    )
    return candidates[-1] if candidates else None


def _prune_orphan_sidecars(out_dir: Path) -> None:
    """Drop a sidecar whose PNG is gone — the pair is one artifact."""
    for sidecar in out_dir.glob("*.png.json"):
        if not sidecar.with_suffix("").exists():
            sidecar.unlink()
            print(f"  removed orphan {sidecar.name} (its PNG is gone)")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
