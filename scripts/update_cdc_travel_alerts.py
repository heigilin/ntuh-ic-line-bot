from __future__ import annotations

import csv
import tempfile
import subprocess
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import urlretrieve


BASE_DIR = Path(__file__).resolve().parents[1]
OUTPUT_PATH = BASE_DIR / "output" / "coze_upload" / "CDC目前國際旅遊疫情建議等級_疾病疫區.md"
SOURCE_URL = "https://www.cdc.gov.tw/InternationalEpidemicLevel/Index/6U0eCorDVCOBl2dEQchLcQ"
CSV_URL = "https://www.cdc.gov.tw/CountryEpidLevel/ExportCSV?fileName=TCDCTravelAlertAll.csv&type=0"


def area_label(row: dict[str, str]) -> str:
    area = row.get("areaDesc", "").strip()
    detail = row.get("areaDetail", "").strip()
    english = row.get("areaDesc_EN", "").strip()
    iso = row.get("ISO3166", "").strip()

    label = area
    if detail:
        label += f"（{detail}）"

    bits = [part for part in (english, iso) if part]
    if bits:
        label += f" [{', '.join(bits)}]"
    return label


def date_only(value: str) -> str:
    return value[:10] if value else "未載明"


def load_rows() -> list[dict[str, str]]:
    tmp_path = Path(tempfile.gettempdir()) / "TCDCTravelAlertAll.csv"
    try:
        urlretrieve(CSV_URL, tmp_path)
    except Exception:
        subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                f"Invoke-WebRequest -Uri '{CSV_URL}' -OutFile '{tmp_path}'",
            ],
            check=True,
        )
    with tmp_path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def latest_active_rows(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    latest: dict[tuple[str, str, str, str, str], dict[str, str]] = {}
    for row in rows:
        key = (
            row.get("alert_disease", "").strip(),
            row.get("areaDesc", "").strip(),
            row.get("areaDetail", "").strip(),
            row.get("ISO3166", "").strip(),
            row.get("ISO3166_2", "").strip(),
        )
        if key not in latest or row.get("effective", "") > latest[key].get("effective", ""):
            latest[key] = row

    active = []
    for row in latest.values():
        disease = row.get("alert_disease", "").strip()
        if not disease:
            continue
        if disease == "嚴重特殊傳染性肺炎":
            continue
        if row.get("severity_level", "").strip() == "解除" or row.get("instruction", "").strip() == "解除":
            continue
        active.append(row)
    return active


def build_markdown(rows: list[dict[str, str]]) -> str:
    by_disease: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        by_disease[row["alert_disease"].strip()].append(row)

    level_order = {
        "第三級:警告(Warning)": 3,
        "第二級:警示(Alert)": 2,
        "第一級:注意(Watch)": 1,
    }
    level_sequence = ("第三級:警告(Warning)", "第二級:警示(Alert)", "第一級:注意(Watch)")
    now = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    latest_data = max((row.get("effective", "") for row in rows), default="")[:10]

    lines = [
        "# CDC目前國際旅遊疫情建議等級與疾病疫區",
        "",
        "本檔依衛生福利部疾病管制署「國際旅遊疫情建議等級」Open Data 整理，供 LINE/知識庫查詢「某疾病目前哪些國家或地區為疫區、旅遊疫情建議等級」時使用。",
        "",
        f"- 整理時間：{now}（Asia/Taipei）",
        f"- 資料最新發布日期：{latest_data}",
        f"- 資料來源：{SOURCE_URL}",
        "- 整理規則：同一疾病、同一國家/地區取最新一筆；最新狀態為「解除」者排除。",
        "- 排除項目：「嚴重特殊傳染性肺炎」2020 年舊版歷史旅遊警示已排除；目前新冠相關項目以「新冠併發重症」列示。",
        "",
        "## 等級意義",
        "",
        "- 第一級：注意（Watch）：提醒遵守當地的一般預防措施。",
        "- 第二級：警示（Alert）：對當地採取加強防護。",
        "- 第三級：警告（Warning）：避免至當地所有非必要旅遊。",
        "",
        "## 疾病總覽",
        "",
    ]

    for disease in sorted(by_disease):
        disease_rows = by_disease[disease]
        counts: dict[str, int] = defaultdict(int)
        for row in disease_rows:
            counts[row.get("severity_level", "")] += 1
        summary = "；".join(
            f"{level} {count}處"
            for level, count in sorted(counts.items(), key=lambda item: -level_order.get(item[0], 0))
        )
        lines.append(f"- {disease}：{len(disease_rows)}處（{summary}）")
    lines.append("")

    for disease in sorted(by_disease):
        disease_rows = by_disease[disease]
        lines.extend(
            [
                f"## {disease}目前疫區",
                "",
                f"- 疾病：{disease}",
                f"- 目前列示地區數：{len(disease_rows)}",
                f"- 本疾病最新發布日期：{max(row['effective'] for row in disease_rows)[:10]}",
                "",
            ]
        )

        summary_rows = []
        for level in level_sequence:
            subset = sorted(
                [row for row in disease_rows if row.get("severity_level", "").strip() == level],
                key=lambda row: (row.get("areaDesc", ""), row.get("areaDetail", "")),
            )
            if subset:
                summary_rows.append(f"{level}：" + "、".join(row["areaDesc"].strip() for row in subset))

        if summary_rows:
            lines.extend([f"### {disease} 疫區摘要", ""])
            lines.extend(f"- {item}" for item in summary_rows)
            lines.append("")

        for level in level_sequence:
            subset = sorted(
                [row for row in disease_rows if row.get("severity_level", "").strip() == level],
                key=lambda row: (row.get("areaDesc", ""), row.get("areaDetail", "")),
            )
            if not subset:
                continue
            lines.extend(
                [
                    f"### {disease} {level}",
                    "",
                    f"- 疾病：{disease}",
                    f"- 建議：{subset[0].get('instruction', '').strip()}",
                    f"- 地區數：{len(subset)}",
                    "- 地區清單：",
                ]
            )
            for row in subset:
                lines.append(f"  - {area_label(row)}；發布日期：{date_only(row.get('effective', ''))}")
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    rows = latest_active_rows(load_rows())
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(build_markdown(rows), encoding="utf-8")
    print(f"Updated {OUTPUT_PATH}")
    print(f"Active rows: {len(rows)}")


if __name__ == "__main__":
    main()
