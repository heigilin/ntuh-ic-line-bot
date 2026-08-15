from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass
from pathlib import Path


CJK_RE = re.compile(r"[\u4e00-\u9fff]{2,}")
LATIN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_\-./+%]*")
DISEASE_KEYWORDS = (
    "伊波拉",
    "ebola",
    "馬堡",
    "marburg",
    "拉薩熱",
    "lassa",
    "裂谷熱",
    "黃熱病",
    "天花",
    "猴痘",
    "mpox",
    "登革熱",
    "流感",
    "新冠",
    "covid",
    "sars-cov-2",
    "mdr tb",
    "mdrtb",
    "多重抗藥性結核",
    "疥瘡",
    "vre",
    "cre",
    "mdro",
    "crab",
    "crpa",
    "mrsa",
)


@dataclass(frozen=True)
class SearchHit:
    score: float
    title: str
    source: str
    text: str


def _tokenize(text: str) -> list[str]:
    text = text.lower()
    tokens: list[str] = []
    tokens.extend(LATIN_RE.findall(text))

    for chunk in CJK_RE.findall(text):
        if len(chunk) <= 6:
            tokens.append(chunk)
        for size in (2, 3, 4):
            tokens.extend(chunk[i : i + size] for i in range(0, max(len(chunk) - size + 1, 0)))
    return tokens


def _split_markdown(path: Path, text: str, max_chars: int = 1600) -> list[tuple[str, str]]:
    chunks: list[tuple[str, str]] = []
    current_title = path.stem
    current: list[str] = []

    def flush() -> None:
        joined = "\n".join(line for line in current).strip()
        if joined:
            if len(joined) <= max_chars:
                chunks.append((current_title, joined))
            else:
                for i in range(0, len(joined), max_chars):
                    part = joined[i : i + max_chars].strip()
                    if part:
                        chunks.append((current_title, part))

    for line in text.splitlines():
        if line.startswith("#"):
            flush()
            current = [line]
            current_title = line.lstrip("#").strip() or path.stem
        else:
            current.append(line)
    flush()
    return chunks


class MarkdownKnowledgeBase:
    def __init__(self, knowledge_dir: str | os.PathLike[str]) -> None:
        self.knowledge_dir = Path(knowledge_dir)
        self._hits: list[SearchHit] = []
        self._chunk_tokens: list[set[str]] = []
        self._doc_freq: dict[str, int] = {}
        self._loaded = False

    @property
    def loaded(self) -> bool:
        return self._loaded

    @property
    def chunk_count(self) -> int:
        return len(self._hits)

    def load(self) -> None:
        self._hits.clear()
        self._chunk_tokens.clear()
        self._doc_freq.clear()

        if not self.knowledge_dir.exists():
            raise FileNotFoundError(f"Knowledge folder not found: {self.knowledge_dir}")

        for path in sorted(self.knowledge_dir.glob("*.md")):
            text = path.read_text(encoding="utf-8", errors="ignore")
            for title, chunk in _split_markdown(path, text):
                tokens = set(_tokenize(title + "\n" + chunk))
                if not tokens:
                    continue
                self._hits.append(SearchHit(0.0, title, str(path), chunk))
                self._chunk_tokens.append(tokens)
                for token in tokens:
                    self._doc_freq[token] = self._doc_freq.get(token, 0) + 1

        self._loaded = True

    def search(self, query: str, limit: int = 6) -> list[SearchHit]:
        if not self._loaded:
            self.load()

        query_tokens = _tokenize(query)
        if not query_tokens:
            return []

        query_lower = query.lower()
        required_keywords = [kw for kw in DISEASE_KEYWORDS if kw in query_lower]
        token_counts: dict[str, int] = {}
        for token in query_tokens:
            token_counts[token] = token_counts.get(token, 0) + 1

        total_chunks = max(len(self._hits), 1)
        scored: list[SearchHit] = []

        for hit, tokens in zip(self._hits, self._chunk_tokens):
            score = 0.0
            source_name = Path(hit.source).name.lower()
            title_lower = hit.title.lower()
            haystack = (hit.title + "\n" + source_name + "\n" + hit.text).lower()
            if required_keywords and not any(kw in haystack for kw in required_keywords):
                continue
            for token, count in token_counts.items():
                if token not in tokens:
                    continue
                idf = math.log((total_chunks + 1) / (self._doc_freq.get(token, 0) + 0.5))
                score += (1.0 + math.log(count)) * max(idf, 0.1)
                if token in title_lower:
                    score += 5.0
                if token in source_name:
                    score += 4.0
            if query_lower and query_lower in haystack:
                score += 8.0
            if score > 0:
                scored.append(SearchHit(score, hit.title, hit.source, hit.text))

        scored.sort(key=lambda item: item.score, reverse=True)
        return scored[:limit]


def format_context(hits: list[SearchHit], max_chars: int = 9000) -> str:
    parts: list[str] = []
    used = 0
    for index, hit in enumerate(hits, start=1):
        source_name = Path(hit.source).name
        block = f"[{index}] {hit.title}\n來源：{source_name}\n{hit.text.strip()}\n"
        if used + len(block) > max_chars:
            remaining = max_chars - used
            if remaining > 300:
                parts.append(block[:remaining])
            break
        parts.append(block)
        used += len(block)
    return "\n---\n".join(parts)
