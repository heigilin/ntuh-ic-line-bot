import pathlib

p = pathlib.Path('D:/Users/006340/Downloads/台大感管line起來/index.html')
content = p.read_text(encoding='utf-8')

# 替換活動主要起訖日
content = content.replace("2026年10月5日起至12月31日止", "2026年11月5日起至12月31日止")
content = content.replace("2026年10月5日－12月31日", "2026年11月5日－12月31日")

# 替換早鳥加碼說明
content = content.replace("10月5日至10月7日完成", "11月5日至11月7日完成")

# 替換時程表格日期
content = content.replace("2026/10/5 — 2026/10/7", "2026/11/5 — 2026/11/7")
content = content.replace("2026/10/8 — 2026/10/11", "2026/11/8 — 2026/11/11")
content = content.replace("2026/10/12 — 2026/12/31", "2026/11/12 — 2026/12/31")

p.write_text(content, encoding='utf-8')
print("Successfully updated dates in index.html to November 5th!")
