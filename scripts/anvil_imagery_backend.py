"""Deck imagery backend for anvil's ``deck-imagegen``, over the ``imagine`` CLI.

Conforms to the adapter contract in
``.anvil/skills/deck/commands/deck-imagegen-adapter.md``: one
``generate(prompt, style, steps) -> bytes``, registered in
``.anvil/config.json`` under ``deck.imagegen.backend``.

Why it is this thin: ``imagine`` is renderer-tier here, invoked exactly
like ``marp`` or ``mmdc`` — prompt in, image out. Model routing, provider
credentials, retry and rate limiting all live in the CLI, and the
cross-repo policy (``2am/docs/image-generation.md``) is explicit that a
second HTTP client in a consumer repo is the thing not to build. So this
file shells out and does nothing else.

Credentials never appear here. ``imagine`` reads ``GEMINI_API_KEY`` (or
``~/.config/imagine/env``) for Gemini and a per-account directory under
``~/.cloudflare`` for Workers AI. ``imagine doctor`` diagnoses both;
run it first on any failure.

Two knobs, both environment-only so nothing host-specific lands in the
repo:

- ``ANVIL_IMAGINE_MODEL`` — pin a model, overriding the routing below.
- ``ANVIL_IMAGINE_CF_ACCOUNT`` — the account directory name passed to
  ``--cf-account`` when the resolved model is served by Cloudflare. Unset
  means "let the CLI find its own", which is the right default on a host
  where only Gemini is provisioned.
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import tempfile
from typing import Any

__all__ = ["DISPATCHES", "Backend", "BackendError", "generate"]

# Provenance captured from `imagine`, one record per successful call, in call
# order. `imagine` writes its sidecar next to the `-o` path — inside a
# temporary directory that dies with the call — so without this the prompt,
# model and provider it actually used would be lost the moment the bytes are
# returned. The adapter contract has nowhere to put a destination path, so the
# records are collected here and `scripts/deck-imagegen.py` pairs them with the
# slots deck-imagegen reports (dispatch is serial and in markdown order, which
# is the one ordering guarantee anvil makes) to write `<slot>.png.json` beside
# each committed PNG. The image and its sidecar are one artifact.
DISPATCHES: list[dict[str, Any]] = []


class BackendError(RuntimeError):
    """Unrecoverable generation failure for one slot.

    ``deck-imagegen`` catches this per-slot, writes a ``*-FAILED.md``
    stub and moves on; it does not retry. Raise it only for conditions
    this adapter cannot recover from.
    """


# Gemini is the default per the cross-repo policy: it is the stronger
# model for work that has to hold a house style, and it is the one that
# produced the calibration render this deck's preset is written against.
# The preset key is a routing *hint*, not a model selector — the prompt
# already carries the style prefix by the time it reaches us.
_DEFAULT_MODEL = "nano-banana"
_STYLE_MODEL_HINTS = {
    # Anything brand-facing: pro tier, for composition fidelity.
    "brand": "nano-banana-pro",
    "logo": "nano-banana-pro",
}

# Aliases (and raw ids) served by Cloudflare Workers AI rather than Gemini.
_CLOUDFLARE_MODELS = frozenset(
    {
        "flux-schnell",
        "flux-2-dev",
        "flux-2-klein",
        "flux-2-4b",
        "sdxl",
        "lucid-origin",
        "phoenix",
    }
)

# Deck slides are 16:9 (anvil pins the Marp size). `--ar` is a Gemini
# flag; Cloudflare models take pixel dimensions instead, and we leave
# those to the CLI's own defaults rather than guessing a size here.
_ASPECT_RATIO = "16:9"


def _is_cloudflare(model: str) -> bool:
    return model.startswith("@cf/") or model in _CLOUDFLARE_MODELS


def _resolve_model(style: str) -> str:
    override = os.environ.get("ANVIL_IMAGINE_MODEL")
    if override:
        return override
    key = (style or "").strip().lower()
    for hint, model in _STYLE_MODEL_HINTS.items():
        if hint in key:
            return model
    return _DEFAULT_MODEL


class Backend:
    """Adapter over the ``imagine`` CLI."""

    def __init__(self, executable: str = "imagine", timeout_s: int = 300) -> None:
        self.executable = executable
        self.timeout_s = timeout_s

    def generate(self, prompt: str, style: str, steps: int | None) -> bytes:
        """Generate one image and return its bytes.

        ``steps`` has no dedicated CLI flag — ``imagine gen`` exposes
        provider passthrough instead — so it rides along as
        ``--param steps=<n>``. Models with no step count ignore it;
        ``None`` means "send nothing".
        """
        if not prompt or not prompt.strip():
            raise BackendError("empty prompt: deck-imagegen must supply a resolved prompt")

        exe = shutil.which(self.executable)
        if exe is None:
            raise BackendError(
                f"{self.executable!r} is not on PATH. Install it with: "
                "uv tool install git+https://github.com/rjwalters/imagine"
            )

        with tempfile.TemporaryDirectory(prefix="nuggbudz-imagegen-") as tmp:
            out = pathlib.Path(tmp) / "out.png"
            model = _resolve_model(style)
            cmd = [exe, "gen", prompt, "-m", model, "-o", str(out)]
            if _is_cloudflare(model):
                account = os.environ.get("ANVIL_IMAGINE_CF_ACCOUNT")
                if account:
                    cmd += ["--cf-account", account]
            else:
                cmd += ["--ar", _ASPECT_RATIO]
            if steps is not None:
                cmd += ["--param", f"steps={int(steps)}"]

            try:
                proc = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=self.timeout_s,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise BackendError(f"imagine timed out after {self.timeout_s}s") from exc
            except OSError as exc:
                raise BackendError(f"failed to invoke imagine: {exc}") from exc

            if proc.returncode != 0:
                detail = (proc.stderr or proc.stdout or "").strip()[:600]
                raise BackendError(
                    f"imagine exited {proc.returncode}. Run `imagine doctor` to check "
                    f"credentials and dependencies. Output: {detail}"
                )

            if not out.is_file():
                # The CLI may honour -o with a suffixed name (e.g. --n > 1);
                # accept whatever image it actually produced.
                produced = sorted(
                    p
                    for p in pathlib.Path(tmp).iterdir()
                    if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
                )
                if not produced:
                    raise BackendError("imagine reported success but produced no image file")
                out = produced[0]

            data = out.read_bytes()
            DISPATCHES.append(_read_cli_sidecar(out, prompt=prompt, model=model, steps=steps))

        if not data:
            raise BackendError("imagine produced an empty image file")
        return _to_png(data)


def _read_cli_sidecar(
    out: pathlib.Path, *, prompt: str, model: str, steps: int | None
) -> dict[str, Any]:
    """Read the sidecar ``imagine`` wrote beside its output, if it wrote one.

    The CLI owns the sidecar's shape, so it is taken verbatim rather than
    reconstructed. When it is absent (an older CLI, or a path the CLI
    chose differently) we record only what this adapter can state from
    its own call — never a provider or a model id we did not observe.
    """
    for candidate in (out.with_name(out.name + ".json"), out.with_suffix(".json")):
        if candidate.is_file():
            try:
                record = json.loads(candidate.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                break
            if isinstance(record, dict):
                return record
    return {
        "tool": "imagine",
        "prompt": prompt,
        "requested_model": model,
        "steps": steps,
        "note": "imagine wrote no sidecar for this call; provider and model id unobserved",
    }


def _to_png(data: bytes) -> bytes:
    """Normalise image bytes to PNG.

    ``imagine`` writes the provider's bytes verbatim to the ``-o`` path,
    so a ``.png`` filename can hold JPEG (Gemini returns JPEG). The
    contract accepts JPEG and transcodes it, but only with anvil's
    optional ``[deck_imagegen]`` extra installed; doing it here keeps
    that extra off the happy path. Without Pillow we hand the bytes back
    unchanged — still contract-legal, just relying on anvil's transcode.
    """
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return data
    try:
        import io

        from PIL import Image
    except ImportError:
        return data
    try:
        with Image.open(io.BytesIO(data)) as im:
            buf = io.BytesIO()
            im.convert("RGB").save(buf, format="PNG")
            return buf.getvalue()
    except Exception:
        # Let anvil sniff the format and report it rather than masking the bytes.
        return data


def generate(prompt: str, style: str, steps: int | None) -> bytes:
    """Module-level callable form of the contract."""
    return Backend().generate(prompt, style, steps)
