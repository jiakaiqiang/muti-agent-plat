from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROGRESS = ROOT / "progress.json"
README = ROOT / "docs" / "tasks" / "README.md"


def load_progress() -> dict:
    return json.loads(PROGRESS.read_text(encoding="utf-8"))


class TaskIndexReadmeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.progress = load_progress()
        self.content = README.read_text(encoding="utf-8")
        self.tasks = self.progress["tasks"]

    def test_readme_exists(self) -> None:
        self.assertTrue(README.exists())

    def test_stats_match_progress_counts(self) -> None:
        done = sum(1 for task in self.tasks if task["status"] == "done")
        pending = sum(1 for task in self.tasks if task["status"] == "pending")
        self.assertIn(f"- **已完成**：{done}", self.content)
        self.assertIn(f"- **待开始**：{pending}", self.content)

    def test_every_progress_task_has_a_markdown_link(self) -> None:
        for task in self.tasks:
            plan_name = Path(task["plan"]).name
            self.assertIn(f"[{task['id']}](./{plan_name})", self.content)

    def test_done_tasks_are_marked_done_in_table(self) -> None:
        for task in self.tasks:
            if task["status"] == "done":
                self.assertRegex(self.content, rf"\| \[{task['id']}\].*\| ✅ 已完成 \|")

    def test_pending_tasks_are_marked_pending_in_table(self) -> None:
        for task in self.tasks:
            if task["status"] == "pending":
                self.assertRegex(self.content, rf"\| \[{task['id']}\].*\| ⏸️ 待开始 \|")

    def test_readme_documents_serial_tdd_execution(self) -> None:
        self.assertIn("## TDD 串行执行规则", self.content)
        self.assertIn("从 `progress.json` 读取第一个 `pending` 任务", self.content)
        self.assertIn("禁止并行写代码", self.content)

    def test_readme_includes_dependency_diagram(self) -> None:
        self.assertIn("## 🗺️ 任务依赖关系图", self.content)
        self.assertIn("```mermaid", self.content)
        self.assertIn("TASK-001", self.content)
        self.assertIn("TASK-013", self.content)

    def test_readme_includes_verification_commands(self) -> None:
        self.assertIn("npm run typecheck", self.content)
        self.assertIn("ruff check .", self.content)
        self.assertIn("ruff format --check .", self.content)
        self.assertIn("python check_progress.py", self.content)

    def test_task_numbers_are_contiguous(self) -> None:
        task_ids = re.findall(r"\[(TASK-\d{3})\]\(\./TASK-", self.content)
        self.assertEqual(task_ids, [f"TASK-{number:03d}" for number in range(1, 14)])


if __name__ == "__main__":
    unittest.main()
