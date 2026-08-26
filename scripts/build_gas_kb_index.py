from __future__ import annotations

import json
import re
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
KB_DIR = BASE_DIR / "output" / "coze_upload"
OUT_DIR = BASE_DIR / "output" / "gas"
OUT_FILE = OUT_DIR / "kb_index.json"
SYNONYMS_FILE = BASE_DIR / "gas_line_bot" / "synonyms.json"
INTENT_RULES_FILE = BASE_DIR / "gas_line_bot" / "intent_rules.json"
EXCLUDED_PREFIXES = (
    "00_9千列版回補_",
    "00_全傳染病線上互動平台",
    "README_Coze",
    "月會議題_",
    "週會紀錄_",
    "感染管制PP_臨床重點整理_",
)
EXCLUDED_CONTAINS = (
    "GitHubPages規格",
    "串接規格",
    "會議紀錄",
    "會議記錄",
    "週會",
    "月會",
)

CJK_RE = re.compile(r"[\u4e00-\u9fff]{2,}")
LATIN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_\-./+%]*")
NOISE_PREFIXES = (
    "本檔供",
    "檢索關鍵字",
    "資料來源",
    "來源：",
)
INTERNAL_INSTRUCTION_TITLES = {
    "查核佐證路徑與用途",
    "LINE 問答關鍵字",
}
INTERNAL_INSTRUCTION_PATTERNS = (
    re.compile(r"只在使用者明確詢問"),
    re.compile(r"一般病人照護或民眾衛教回答不要"),
    re.compile(r"不要主動列出"),
    re.compile(r"[A-Z]:\\", re.I),
)


def clean_text(text: str) -> str:
    text = text.replace("\ufeff", "")
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_markdown(path: Path, text: str, max_chars: int = 1200) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    current_title = path.stem
    current: list[str] = []

    def flush() -> None:
        joined = clean_text("\n".join(current))
        if not joined:
            return
        if current_title in INTERNAL_INSTRUCTION_TITLES:
            return
        if any(pattern.search(joined) for pattern in INTERNAL_INSTRUCTION_PATTERNS):
            return
        if any(joined.startswith(prefix) for prefix in NOISE_PREFIXES):
            return
        parts = [joined[i : i + max_chars].strip() for i in range(0, len(joined), max_chars)]
        for index, part in enumerate(parts, start=1):
            if len(part) < 20:
                continue
            title = current_title if len(parts) == 1 else f"{current_title} 第{index}段"
            entries.append(
                {
                    "source": path.name,
                    "title": title,
                    "text": part,
                }
            )

    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        if line.startswith("#"):
            flush()
            current = [line]
            current_title = line.lstrip("#").strip() or path.stem
        else:
            current.append(line)
    flush()
    return entries


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    synonyms = json.loads(SYNONYMS_FILE.read_text(encoding="utf-8"))
    intent_rules = json.loads(INTENT_RULES_FILE.read_text(encoding="utf-8")) if INTENT_RULES_FILE.exists() else {"version": 1, "rules": []}
    entries: list[dict[str, object]] = []
    for path in sorted(KB_DIR.glob("*.md")):
        if path.name.startswith(EXCLUDED_PREFIXES) or any(term in path.name for term in EXCLUDED_CONTAINS):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        entries.extend(split_markdown(path, text))

    payload = {
        "version": 1,
        "generated_from": "output/coze_upload",
        "entry_count": len(entries),
        "synonyms": synonyms,
        "intent_rules": intent_rules,
        "entries": entries,
    }
    OUT_FILE.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {OUT_FILE}")
    print(f"Entries: {len(entries)}")
    print(f"Size MB: {OUT_FILE.stat().st_size / 1024 / 1024:.2f}")


if __name__ == "__main__":
    main()
