#!/usr/bin/env python3
"""Read TinyMemory files and return their contents as plain-text context."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

DEFAULT_ROOT = Path("/var/lib/dre-memory")


def _safe_path(root: Path, relative_name: str) -> Path:
    """Resolve a manifest path while preventing access outside the root."""
    if not isinstance(relative_name, str) or not relative_name:
        raise ValueError("memory file names must be non-empty strings")
    candidate = (root / relative_name).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"memory path escapes root: {relative_name}") from exc
    return candidate


def _read_optional(path: Path) -> str:
    """Read UTF-8 text, treating a missing optional file as empty."""
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def load_memory(root: str | Path = DEFAULT_ROOT) -> str:
    """Load manifest-selected files and return plain text without execution."""
    root_path = Path(root).resolve()
    manifest_path = root_path / "manifest.json"
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest: Any = json.load(handle)

    if not isinstance(manifest, dict):
        raise ValueError("manifest must be a JSON object")

    always_load = manifest.get("always_load", [])
    if not isinstance(always_load, list) or not all(
        isinstance(item, str) for item in always_load
    ):
        raise ValueError("always_load must be a list of strings")

    selected = list(always_load)
    skills_index = manifest.get("skills_index")
    if skills_index is not None:
        if not isinstance(skills_index, str):
            raise ValueError("skills_index must be a string")
        selected.append(skills_index)

    chunks = []
    for relative_name in selected:
        text = _read_optional(_safe_path(root_path, relative_name))
        if text:
            chunks.append(text)
    return "\n\n".join(chunks)


def main() -> int:
    parser = argparse.ArgumentParser(description="Load TinyMemory plain-text context")
    parser.add_argument("root", nargs="?", default=str(DEFAULT_ROOT))
    args = parser.parse_args()
    sys.stdout.write(load_memory(args.root))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
