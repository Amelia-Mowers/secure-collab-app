#!/usr/bin/env python3
"""Assert the wasm memory ceiling agrees in all three places that state it.

The ceiling is declared as a linker argument, baked into the built module, and
duplicated in TypeScript so a crash report can say how close the heap was to it.
Nothing links those three, and getting them out of step is invisible until a
user hits the cap.

It is worth a check because of how the cap fails. When `memory.grow` refuses,
the Rust allocator gets null and `handle_alloc_error` aborts, which compiles to
a bare wasm `unreachable`. An abort is not a panic, so no panic hook runs and
nothing is printed -- the entire symptom is

    RuntimeError: unreachable executed  app_core_bg-<hash>.wasm:6126383:1

and a poisoned module that answers nothing until the tab is reloaded. That was
the production crash of 2026-08-03, against a 128 MiB cap, and it cost a week of
theories no small test workspace could have distinguished. Lowering the cap
again by accident would reintroduce it in exactly the same unreadable form.

Usage: check-wasm-memory.py [path/to/app_core_bg.wasm]
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CARGO_CONFIG = ROOT / ".cargo" / "config.toml"
LOADER_TS = ROOT / "ui" / "src" / "wasm" / "loader.ts"
DEFAULT_WASM = ROOT / "ui" / "src" / "wasm" / "generated" / "app_core_bg.wasm"

# Below this, a real workspace can reach the cap. The crash that prompted this
# script happened at 128 MiB; 1 GiB is the floor at which the check stops being
# a safety net and starts being a formality.
MIN_SANE_MIB = 1024


def uleb(data, i):
    result = shift = 0
    while True:
        byte = data[i]
        i += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            return result, i


def wasm_max_mib(path):
    """The maximum declared by the module's memory section, in MiB."""
    data = path.read_bytes()
    if data[:4] != b"\0asm":
        raise SystemExit(f"{path} is not a wasm module")
    i = 8
    while i < len(data):
        section_id = data[i]
        i += 1
        size, i = uleb(data, i)
        if section_id == 5:  # memory
            _count, j = uleb(data, i)
            flags, j = uleb(data, j)
            _initial, j = uleb(data, j)
            if not flags & 1:
                raise SystemExit(f"{path}: no maximum declared")
            maximum, _ = uleb(data, j)
            return maximum * 65536 // 1048576
        i += size
    raise SystemExit(f"{path}: no memory section")


def config_max_mib():
    text = CARGO_CONFIG.read_text(encoding="utf-8")
    match = re.search(r"link-arg=--max-memory=(\d+)", text)
    if not match:
        raise SystemExit(f"{CARGO_CONFIG}: no --max-memory link argument")
    return int(match.group(1)) // 1048576


def loader_max_mib():
    text = LOADER_TS.read_text(encoding="utf-8")
    match = re.search(r"WASM_MAX_HEAP_MIB\s*=\s*(\d+)", text)
    if not match:
        raise SystemExit(f"{LOADER_TS}: no WASM_MAX_HEAP_MIB constant")
    return int(match.group(1))


def main():
    wasm_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_WASM
    sources = {
        ".cargo/config.toml": config_max_mib(),
        "ui/src/wasm/loader.ts": loader_max_mib(),
        str(wasm_path.relative_to(ROOT) if wasm_path.is_relative_to(ROOT) else wasm_path): (
            wasm_max_mib(wasm_path)
        ),
    }

    if len(set(sources.values())) != 1:
        print("wasm memory ceiling disagrees between:", file=sys.stderr)
        for where, mib in sources.items():
            print(f"  {mib:>6} MiB  {where}", file=sys.stderr)
        return 1

    ceiling = next(iter(sources.values()))
    if ceiling < MIN_SANE_MIB:
        print(
            f"wasm memory ceiling is {ceiling} MiB, below the {MIN_SANE_MIB} MiB floor.\n"
            "A real workspace can reach this, and reaching it aborts with a bare\n"
            "`unreachable` that prints no message at all. See this script's docstring.",
            file=sys.stderr,
        )
        return 1

    print(f"wasm memory ceiling: {ceiling} MiB, consistent across {len(sources)} sources")
    return 0


if __name__ == "__main__":
    sys.exit(main())
