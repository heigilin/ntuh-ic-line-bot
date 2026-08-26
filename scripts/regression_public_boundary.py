from __future__ import annotations

import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ["OPENAI_API_KEY"] = ""

import app  # noqa: E402


CASES = (
    (
        "help_current_running_work_phrasing",
        "你現在有什麼在執行的事",
        ("可查感染管制", "法定傳染病通報"),
        ("關鍵字檢索命中度較低", "可能相關主題"),
    ),
    (
        "meeting_dates_only",
        "VRE在哪些週會出現",
        ("查得日期",),
        ("決議", "摘要", "檔案", "群聚事件報告", "資料來源", "週會紀錄_"),
    ),
    (
        "meeting_requires_explicit_query",
        "VRE處置",
        (),
        ("週會紀錄_", "月會議題_", "查得日期"),
    ),
    (
        "raw_pp_not_searchable",
        "5123456",
        (),
        ("感染管制PP_臨床重點整理_", "李O明"),
    ),
    (
        "approved_contact_information_remains",
        "感管中心值班手機",
        ("08:00", "22:00"),
        ("感染管制PP_臨床重點整理_",),
    ),
    (
        "approved_office_directions_remain",
        "感管中心辦公室在哪",
        ("東址研究大樓",),
        ("感染管制PP_臨床重點整理_",),
    ),
    (
        "approved_internal_operation_remains",
        "怎麼在院內系統找病人",
        ("院內系統",),
        ("感染管制PP_臨床重點整理_",),
    ),
)


def main() -> int:
    failures: list[str] = []
    for case_id, question, required, forbidden in CASES:
        answer = app.answer_question(question)
        missing = [value for value in required if value not in answer]
        leaked = [value for value in forbidden if value in answer]
        if missing or leaked:
            failures.append(f"{case_id}: missing={missing}, leaked={leaked}")

    print(f"public-boundary cases={len(CASES)} failures={len(failures)}")
    for failure in failures:
        print(failure)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
