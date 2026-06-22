from __future__ import annotations

import json
from pathlib import Path
from typing import Any


PROGRESS_PATH = Path(__file__).with_name("progress.json")


def load_progress() -> dict[str, Any]:
    with PROGRESS_PATH.open(encoding="utf-8") as progress_file:
        return json.load(progress_file)


def main() -> int:
    progress = load_progress()
    tasks = progress.get("tasks", [])
    done_count = sum(1 for task in tasks if task.get("status") == "done")
    expected_total = len(tasks)

    if done_count != expected_total:
        return 1
    if progress.get("completed") != expected_total:
        return 1
    if progress.get("rounds", 0) < expected_total:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
