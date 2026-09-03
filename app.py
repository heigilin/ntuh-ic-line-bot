from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

from knowledge_search import MarkdownKnowledgeBase, format_context


BASE_DIR = Path(__file__).resolve().parent


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env(BASE_DIR / ".env")

LINE_CHANNEL_SECRET = os.getenv("LINE_CHANNEL_SECRET", "")
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
KNOWLEDGE_DIR = BASE_DIR / os.getenv("KNOWLEDGE_DIR", "output/coze_upload")
MAX_CONTEXT_CHARS = int(os.getenv("MAX_CONTEXT_CHARS", "9000"))
MAX_LINE_REPLY_CHARS = int(os.getenv("MAX_LINE_REPLY_CHARS", "4500"))
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))

kb = MarkdownKnowledgeBase(KNOWLEDGE_DIR)

SYSTEM_PROMPT = """你是台大感管中心的 LINE 臨床問答助手。
請用繁體中文、專業但親切的語氣回答臨床同仁。
只能根據提供的知識庫內容回答；若資料不足，請清楚說明目前知識庫沒有足夠資訊，並建議洽感染管制中心、感染科、胸腔科、皮膚科或依院內最新規範確認。
不要編造固定解隔天數、藥物劑量或不存在的政策。
藥物問題只說明類別與需醫師評估，不提供劑量。
回答末尾簡短提醒：「請勿輸入病人姓名、病歷號、床號等個資。」
"""

POLICY_NOTICE = "一般流程摘要｜如與正式公告不一致，以正式公告為準。"
PRIVACY_NOTICE = "請勿輸入病人姓名、病歷號、床號等個資。"
HELP_REPLY = (
    "您好，我是台大感管 LINE 查詢助手。可查感染管制、法定傳染病通報、隔離／解隔、"
    "檢體送驗、疫區、清消濃度、查核重點，也可查週會／月會議題曾在哪些日期出現。\n\n"
    "提問範例：VRE解隔、登革熱通報、伊波拉疫區、感染月報在哪些週會出現。"
)


def verify_line_signature(body: bytes, signature: str | None) -> bool:
    if not LINE_CHANNEL_SECRET or not signature:
        return False
    digest = hmac.new(LINE_CHANNEL_SECRET.encode("utf-8"), body, hashlib.sha256).digest()
    expected = base64.b64encode(digest).decode("utf-8")
    return hmac.compare_digest(expected, signature)


def post_json(url: str, headers: dict[str, str], payload: dict[str, Any], timeout: int = 30) -> dict[str, Any]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(url, data=data, headers=headers, method="POST")
    with urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8", errors="ignore")
        return json.loads(body) if body else {}


def call_openai(question: str, context: str) -> str | None:
    if not OPENAI_API_KEY:
        return None
    data = post_json(
        "https://api.openai.com/v1/chat/completions",
        {
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        {
            "model": OPENAI_MODEL,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"使用者問題：{question}\n\n知識庫內容：\n{context}"},
            ],
        },
        timeout=45,
    )
    return data["choices"][0]["message"]["content"].strip()


def _clean_context_line(line: str) -> str:
    line = line.strip()
    line = line.strip("`")
    if line.startswith("[") and "]" in line[:5]:
        line = line.split("]", 1)[1].strip()
    line = line.lstrip("#").strip()
    line = line.removeprefix("- ").strip()
    return line


def _brief_line(line: str, limit: int = 180) -> str:
    line = " ".join(line.split())
    if len(line) <= limit:
        return line
    return line[: limit - 1].rstrip("，。；、 ") + "..."


def _display_source(source: str, target_disease: str = "") -> str:
    name = Path(source).name
    if target_disease == "疥瘡" and name.startswith("流感新冠登革熱MDRTB疥瘡_"):
        return "疥瘡床位藥物解隔_臨床查詢重點.md"
    return name or source


def extractive_answer(context: str, style: str = "clinical") -> str:
    if not context.strip():
        return (
            "目前知識庫沒有找到足夠相關內容，建議先洽感染管制中心確認。"
            f"\n\n{PRIVACY_NOTICE}"
        )

    sections: list[str] = []
    sources: list[str] = []
    hidden_titles = {
        "來源",
        "資料來源",
        "LINE 問答關鍵字",
        "LINE 查詢建議",
        "疾病總覽",
        "檔案",
        "檢索關鍵字",
        "檢索關鍵字補充",
        "一頁速查",
    }
    hidden_prefixes = ("本檔供 Coze/LINE", "本檔供 LINE", "本檔供 Coze", "檢索關鍵字")
    target_disease = "疥瘡" if "疥瘡" in context and "問：疥瘡" in context else ""
    other_disease_terms = ("登革熱", "流感", "新冠", "COVID", "MDR TB", "多重抗藥性結核")

    for block in context.split("\n---\n")[:6]:
        raw_lines = [line.strip() for line in block.splitlines() if line.strip()]
        if not raw_lines:
            continue

        title = _clean_context_line(raw_lines[0])
        source = next((line.removeprefix("來源：").strip() for line in raw_lines if line.startswith("來源：")), "")

        content_lines = []
        if title in hidden_titles:
            continue
        for raw_line in raw_lines[1:]:
            if raw_line.startswith("來源："):
                continue
            line = _clean_context_line(raw_line)
            if not line or line == title:
                continue
            if line in hidden_titles:
                continue
            if any(line.startswith(prefix) for prefix in hidden_prefixes):
                continue
            if target_disease == "疥瘡" and any(term in line for term in other_disease_terms) and "疥瘡" not in line:
                continue
            if "D:\\" in line or "Y:\\" in line:
                continue
            content_lines.append(_brief_line(line))

        if not content_lines:
            continue

        display_source = _display_source(source, target_disease)
        if display_source and display_source not in sources:
            sources.append(display_source)

        bullets = "\n".join(f"- {line}" for line in content_lines[:5])
        sections.append(f"【{title}】\n{bullets}")

    if not sections:
        return (
            "目前有找到相關資料，但內容不足以整理成明確答案，建議先洽感染管制中心確認。"
            f"\n\n{PRIVACY_NOTICE}"
        )

    if style == "travel":
        answer = "依疾管署國際旅遊疫情建議等級整理如下；疫情建議等級會隨疫情變動，出國前請再次確認疾管署最新頁面。\n\n"
    else:
        answer = "我先依知識庫內容整理重點如下。\n\n"
    answer += "\n\n".join(sections)
    if sources:
        answer += "\n\n資料來源：" + "、".join(sources[:3])
    if style == "travel":
        answer += "\n\n提醒：旅遊疫情建議等級為行前參考，返國後如有不適請儘速就醫並告知旅遊史。"
    else:
        answer += f"\n\n{POLICY_NOTICE}\n\n{PRIVACY_NOTICE}"
    return answer


def clarification_response(question: str) -> str | None:
    compact = "".join(question.split()).lower()
    meeting_terms = ("週會", "月會", "會議", "紀錄", "記錄", "出現日期", "曾在哪", "議題")
    workflow_terms = (
        "流程",
        "怎麼",
        "如何",
        "時限",
        "多久",
        "診斷碼",
        "定義",
        "病例",
        "診斷要件",
        "診斷條件",
        "通報定義",
        "採檢",
        "檢體",
        "送驗",
        "疫區",
        "旅遊疫情",
        "隔離",
        "醫令",
        "icd",
        "法傳",
        "法定傳染病",
        "通報路徑",
        "通報作業",
        "送驗單",
        "收執聯",
        "疾管局送驗單",
        "補報",
        "非當次",
    )

    if "通報" not in compact:
        return None
    if any(term in compact for term in meeting_terms):
        return None
    if any(term in compact for term in workflow_terms):
        return None
    if len(compact) > 12:
        return None

    return (
        "想先確認您要查的是哪一類「通報」資訊？\n\n"
        "1. 臨床通報流程：通報時限、病例定義、採檢/檢驗醫令、通報路徑。\n"
        "2. 感管中心內部紀錄：週會或月會曾在哪些日期出現這個議題。\n\n"
        "請回覆例如：「登革熱通報流程」或「登革熱週會紀錄」。\n\n"
        + PRIVACY_NOTICE
    )


def is_explicit_meeting_date_query(question: str) -> bool:
    compact = "".join(str(question or "").split()).lower()
    meeting_terms = ("週會", "月會", "會議", "會報", "委員會", "感管會")
    query_terms = ("在哪", "哪個", "哪次", "何時", "有無", "討論過", "紀錄", "記錄", "日期", "時間", "出現")
    return any(term in compact for term in meeting_terms) and any(term in compact for term in query_terms)


def _meeting_topic(question: str) -> str:
    compact = "".join(str(question or "").split())
    compact = re.sub(r"請問|想問|查詢|幫我|可以|麻煩", "", compact)
    compact = re.sub(r"在哪些|在哪個|在哪|哪個|哪次|哪一次|曾經|曾在|曾|何時|什麼時候|有無|是否|有沒有", "", compact)
    compact = re.sub(r"週會|月會|會議紀錄|會議記錄|會議|會報|委員會|感管會|紀錄|記錄|日期|時間|出現|討論過|討論|議題|清單|相關", "", compact)
    compact = re.sub(r"[?？,，.。:：;；]", "", compact)
    return compact[:30] if len(compact) >= 2 else ""


def meeting_date_only_answer(question: str) -> str | None:
    if not is_explicit_meeting_date_query(question):
        return None

    topic = _meeting_topic(question)
    if not topic:
        return f"請用「議題＋週會／月會」明確查詢，例如：VRE在哪些週會出現。\n\n{PRIVACY_NOTICE}"

    compact = "".join(question.split())
    weekly_only = "週會" in compact and "月會" not in compact
    monthly_only = "月會" in compact and "週會" not in compact
    prefixes = ("週會紀錄_",) if weekly_only else (("月會議題_",) if monthly_only else ("週會紀錄_", "月會議題_"))
    date_pattern = re.compile(r"(?<!\d)(20\d{2})[-/.年](0?[1-9]|1[0-2])[-/.月](0?[1-9]|[12]\d|3[01])日?")
    roc_pattern = re.compile(r"(?<!\d)(\d{2,3})[-/.年](0?[1-9]|1[0-2])[-/.月](0?[1-9]|[12]\d|3[01])日?")
    dates: set[str] = set()

    for path in sorted(KNOWLEDGE_DIR.glob("*.md")):
        if not path.name.startswith(prefixes):
            continue
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if topic.lower() not in line.lower():
                continue
            for year, month, day in date_pattern.findall(line):
                dates.add(f"{int(year):04d}-{int(month):02d}-{int(day):02d}")
            for year, month, day in roc_pattern.findall(line):
                y = int(year)
                if y < 1911:
                    dates.add(f"{y + 1911:04d}-{int(month):02d}-{int(day):02d}")

    if not dates:
        return f"目前沒有查到「{topic}」可供顯示的明確會議日期。\n\n{PRIVACY_NOTICE}"
    ordered = sorted(dates)
    suffix = f" 等{len(ordered)}筆" if len(ordered) > 30 else ""
    return f"「{topic}」查得日期：\n" + "、".join(ordered[:30]) + suffix + f"\n\n{PRIVACY_NOTICE}"


def query_intent(question: str) -> str:
    compact = "".join(question.split()).lower()
    meeting_terms = ("週會", "月會", "會議", "紀錄", "記錄", "出現日期", "曾在哪", "議題")
    workflow_terms = (
        "流程",
        "怎麼",
        "如何",
        "時限",
        "多久",
        "診斷碼",
        "定義",
        "病例",
        "診斷要件",
        "診斷條件",
        "通報定義",
        "採檢",
        "檢體",
        "送驗",
        "疫區",
        "旅遊疫情",
        "隔離",
        "醫令",
        "icd",
        "法傳",
        "法定傳染病",
        "通報路徑",
        "通報作業",
        "送驗單",
        "收執聯",
        "疾管局送驗單",
        "補報",
        "非當次",
    )
    if any(term in compact for term in meeting_terms):
        return "meeting"
    if any(term in compact for term in workflow_terms):
        return "workflow"
    return "general"


def filter_hits_by_intent(question: str, hits: list[Any]) -> list[Any]:
    intent = query_intent(question)

    meeting_markers = ("週會", "月會", "會議題", "會議紀錄", "會議記錄")

    def is_meeting_hit(hit: Any) -> bool:
        haystack = f"{hit.title}\n{hit.source}".lower()
        return any(marker in haystack for marker in meeting_markers)

    if intent == "general":
        filtered = [hit for hit in hits if not is_meeting_hit(hit)]
        return filtered or hits

    if intent == "meeting":
        filtered = [hit for hit in hits if is_meeting_hit(hit)]
        return filtered or hits

    filtered = [hit for hit in hits if not is_meeting_hit(hit)]
    return filtered or hits


def convert_full_width_to_half_width(text: str) -> str:
    result = []
    for char in str(text or ""):
        code = ord(char)
        if 0xFF01 <= code <= 0xFF5E:
            result.append(chr(code - 65248))
        elif code == 0x3000:
            result.append(' ')
        else:
            result.append(char)
    return "".join(result)


def answer_question(question: str) -> str:
    question = convert_full_width_to_half_width(question)
    compact = "".join(question.split()).lower()
    help_phrases = {
        "可以查什麼", "可以問什麼", "你能做什麼", "你能查什麼", "你能回答什麼", "你能答什麼",
        "你可以做什麼", "你可以回答什麼", "你可以答什麼", "你會做什麼", "你能幫我什麼",
        "你提供什麼服務", "有什麼功能", "你現在有什麼在執行的事", "你現在在執行什麼",
        "你目前在執行什麼", "你現在在做什麼", "你目前在做什麼", "功能", "幫助", "help", "menu",
    }
    if compact in help_phrases:
        return f"{HELP_REPLY}\n\n{PRIVACY_NOTICE}"
    meeting_answer = meeting_date_only_answer(question)
    if meeting_answer is not None:
        return meeting_answer
    clarification = clarification_response(question)
    if clarification:
        return clarification

    search_question = question
    compact_question = "".join(question.split()).lower()
    disease_terms = ("伊波拉", "ebola", "登革熱", "流感", "新冠", "疥瘡", "vre", "cre", "mdro", "mdr")
    report_operation_terms = (
        "怎麼通報",
        "如何通報",
        "法傳怎麼",
        "法傳通報",
        "操作流程",
        "診斷碼",
        "沒有診斷碼",
        "沒診斷碼",
        "無相關診斷碼",
        "有相關診斷碼",
        "非當次",
        "補報",
        "檢體",
        "送驗檢體",
        "送驗單",
        "疾管局送驗單",
        "防疫檢體",
        "cdc通報檢驗",
        "疫區",
        "旅遊疫情",
        "隔離注意事項",
        "隔離",
        "通報收執聯",
        "收執聯",
        "通報作業",
        "病人診斷畫面",
        "病患就診紀錄",
    )
    explicit_report_operation_terms = (
        "怎麼通報",
        "如何通報",
        "法傳怎麼",
        "法傳通報",
        "操作流程",
        "沒有診斷碼",
        "沒診斷碼",
        "無相關診斷碼",
        "有相關診斷碼",
        "非當次",
        "補報",
        "送驗單",
        "疾管局送驗單",
        "防疫檢體",
        "cdc通報檢驗",
        "通報收執聯",
        "收執聯",
        "通報作業",
        "病人診斷畫面",
        "病患就診紀錄",
    )
    combo_report_terms = ("診斷碼", "檢體", "送驗檢體", "疫區", "旅遊疫情", "隔離注意事項", "隔離")
    is_report_operation_query = (
        any(term in compact_question for term in explicit_report_operation_terms)
        or ("通報" in compact_question and any(term in compact_question for term in combo_report_terms))
    )
    if query_intent(question) == "workflow" and is_report_operation_query:
        search_question = (
            f"{question} 法定傳染病通報操作流程 臨床使用者端 病人診斷畫面 行政 通報作業 "
            "有相關診斷碼 無相關診斷碼 非當次就診 補報 防疫檢體送驗單 CDC通報檢驗 "
            "疾管局送驗單 通報收執聯 檢醫部抽血櫃檯 東址檢體受理處 "
            "診斷碼 通報定義 送驗檢體 疫區 旅遊疫情建議 隔離注意事項 病人安置"
        )
    elif query_intent(question) == "workflow" and "通報" in compact_question:
        search_question = f"{question} 通報時限 病例定義 防疫檢體 採檢 檢驗醫令 ICD"
    elif query_intent(question) == "workflow" and ("診斷要件" in compact_question or "診斷條件" in compact_question):
        search_question = f"{question} 通報定義 病例定義 防疫檢體 採檢送驗 通報時限 檢驗醫令 ICD"
    elif "疥瘡" in compact_question:
        search_question = (
            f"{question} 疥瘡病人 疥瘡床位 接觸隔離 抗疥藥 抗蟲藥 permethrin "
            "結痂型疥瘡 挪威型疥瘡 開始治療後24小時 完成治療 皮膚科判定 解隔"
        )
    elif query_intent(question) == "general" and len(compact_question) <= 8 and any(term in compact_question for term in disease_terms):
        search_question = f"{question} 重點結論 臨床問答 標準回覆 感染管制 清消 消毒 隔離 通報"

    hits = filter_hits_by_intent(question, kb.search(search_question, limit=30))
    if is_report_operation_query:
        operation_hits = [
            hit
            for hit in hits
            if "法定傳染病通報操作流程_臨床使用者知識庫" in hit.source
        ]
        matched_operation_terms = [term for term in report_operation_terms if term in compact_question]
        operation_hits.sort(
            key=lambda hit: (
                "問：" not in hit.title,
                not any(
                    term in "".join(hit.title.split()).lower()
                    for term in matched_operation_terms
                ),
                not any(
                    term in "".join(f"{hit.title}\n{hit.text}".split()).lower()
                    for term in matched_operation_terms
                ),
                -hit.score,
            )
        )
        hits = operation_hits + [hit for hit in hits if hit not in operation_hits]
    if "疥瘡" in compact_question:
        hits.sort(
            key=lambda hit: (
                "疥瘡病人要住哪裡" not in hit.title,
                "疥瘡病人" not in hit.title,
                "流感新冠登革熱MDRTB疥瘡_床位藥物解隔" not in hit.source,
                -hit.score,
            )
        )
    if "漢他" in compact_question:
        hantavirus_hits = [
            hit
            for hit in hits
            if "漢他病毒症候群" in f"{hit.title}\n{hit.text}"
        ]
        hits = hantavirus_hits or hits
    travel_terms = ("疫區", "旅遊疫情", "建議等級", "哪些國家", "哪些地區")
    is_travel_query = any(term in compact_question for term in travel_terms)
    if is_travel_query:
        travel_hits = [hit for hit in kb.search(f"{question} 目前列示地區數 地區清單 第三級 第二級 第一級", limit=80) if "CDC目前國際旅遊疫情建議等級_疾病疫區" in hit.source]
        travel_disease_terms = (
            "m痘",
            "中東呼吸症候群冠狀病毒感染症",
            "伊波拉",
            "小兒麻痺",
            "急性無力肢體麻痺",
            "屈公病",
            "拉薩熱",
            "新冠併發重症",
            "新型a型流感",
            "瘧疾",
            "登革熱",
            "立百病毒",
            "茲卡",
            "霍亂",
            "馬堡",
            "麻疹",
            "黃熱病",
        )
        matched_terms = [term for term in travel_disease_terms if term in compact_question]
        if matched_terms:
            filtered_travel_hits = [
                hit
                for hit in travel_hits
                if any(term in f"{hit.title}\n{hit.text}".lower() for term in matched_terms)
            ]
            travel_hits = filtered_travel_hits or travel_hits
        travel_hits.sort(
            key=lambda hit: (
                "疫區摘要" not in hit.title,
                "目前疫區" not in hit.title,
                -hit.score,
            )
        )
        if is_report_operation_query:
            hits = hits[:3] + [hit for hit in travel_hits[:2] if hit not in hits] + hits[3:6]
        else:
            hits = travel_hits[:8] or hits
    hits = hits[:8]
    context = format_context(hits, max_chars=MAX_CONTEXT_CHARS)
    answer_style = "travel" if is_travel_query and not is_report_operation_query else "clinical"
    try:
        answer = call_openai(question, context) or extractive_answer(context, style=answer_style)
    except Exception as exc:
        print(f"AI call failed, using extractive answer: {exc}")
        answer = extractive_answer(context, style=answer_style)

    if answer_style == "clinical":
        answer = answer.replace(POLICY_NOTICE, "").replace(PRIVACY_NOTICE, "").rstrip()
        answer += f"\n\n{POLICY_NOTICE}\n\n{PRIVACY_NOTICE}"

    if len(answer) > MAX_LINE_REPLY_CHARS:
        answer = answer[: MAX_LINE_REPLY_CHARS - 30] + "\n\n（內容較長，已截短）"
    return answer


def reply_to_line(reply_token: str, text: str) -> None:
    if not LINE_CHANNEL_ACCESS_TOKEN:
        raise RuntimeError("LINE_CHANNEL_ACCESS_TOKEN is not configured")
    post_json(
        "https://api.line.me/v2/bot/message/reply",
        {
            "Authorization": f"Bearer {LINE_CHANNEL_ACCESS_TOKEN}",
            "Content-Type": "application/json",
        },
        {"replyToken": reply_token, "messages": [{"type": "text", "text": text}]},
        timeout=15,
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "NTUHInfectionControlLineBot/0.1"

    def send_text(self, status: int, text: str, content_type: str = "text/plain; charset=utf-8") -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        self.send_text(status, json.dumps(payload, ensure_ascii=False), "application/json; charset=utf-8")

    def send_file(self, path: Path) -> None:
        if not path.is_file():
            self.send_text(404, "Not found")
            return
        body = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        cache_policy = "no-cache" if path.suffix in {".html", ".css", ".js"} else "public, max-age=3600"
        self.send_header("Cache-Control", cache_policy)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        public_files = {
            "/": BASE_DIR / "index.html",
            "/site.css": BASE_DIR / "site.css",
            "/reading.css": BASE_DIR / "reading.css",
            "/effects.css": BASE_DIR / "effects.css",
            "/bright.css": BASE_DIR / "bright.css",
            "/site.js": BASE_DIR / "site.js",
            "/assets/avatar.jpg": BASE_DIR / "頭貼.jpg",
            "/assets/mos-meal.jpg": BASE_DIR / "摩斯套餐.jpg",
            "/assets/video-poster.png": BASE_DIR / "output/video/slide-01.png",
            "/assets/qbee-character.png": BASE_DIR / "assets/qbee-character.png",
            "/assets/children-hospital.jpg": BASE_DIR / "assets/children-hospital.jpg",
            "/assets/nursing-cart-crop.jpg": BASE_DIR / "assets/nursing-cart-crop.jpg",
            "/assets/system-demo.png": BASE_DIR / "assets/system-demo.png",
            "/assets/qbee-promo.mp4": BASE_DIR / "output/video/台大感管LINE起來_Qbee宣傳影片_送審版.mp4",
            "/assets/台大感管line起來_暫_web.mp4": BASE_DIR / "assets/台大感管line起來_暫_web.mp4",
            "/assets/qbee_promo_comic_temp.jpg": BASE_DIR / "assets/qbee_promo_comic_temp.jpg",
            "/assets/qbee_promo_comic_20260903.jpg": BASE_DIR / "assets/qbee_promo_comic_20260903.jpg",
            "/assets/event-rules.pdf": BASE_DIR / "台大感管 LINE 官方帳號體驗問卷抽獎推廣活動辦法_0901活動版.pdf",
        }
        if parsed.path in public_files:
            self.send_file(public_files[parsed.path])
            return
        if parsed.path == "/health":
            self.send_json(
                200,
                {
                    "ok": True,
                    "knowledge_dir": str(KNOWLEDGE_DIR),
                    "chunks": kb.chunk_count,
                    "openai_enabled": bool(OPENAI_API_KEY),
                },
            )
            return
        if parsed.path == "/ask":
            query = parse_qs(parsed.query).get("q", [""])[0].strip()
            if not query:
                self.send_text(400, "Missing q")
                return
            self.send_text(200, answer_question(query))
            return
        self.send_text(404, "Not found")

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/line/webhook":
            self.send_text(404, "Not found")
            return

        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        signature = self.headers.get("X-Line-Signature")
        if not verify_line_signature(body, signature):
            self.send_json(401, {"ok": False, "error": "Invalid LINE signature"})
            return

        payload = json.loads(body.decode("utf-8"))
        for event in payload.get("events", []):
            if event.get("type") != "message":
                continue
            message = event.get("message", {})
            if message.get("type") != "text":
                continue
            reply_token = event.get("replyToken")
            user_text = message.get("text", "").strip()
            if not reply_token or not user_text:
                continue
            reply_to_line(reply_token, answer_question(user_text))

        self.send_json(200, {"ok": True})

    def log_message(self, format: str, *args: Any) -> None:
        print("%s - %s" % (self.address_string(), format % args))


def main() -> None:
    kb.load()
    print(f"Knowledge loaded: {kb.chunk_count} chunks from {KNOWLEDGE_DIR}")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Server listening: http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
