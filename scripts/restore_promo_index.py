import subprocess
import pathlib

cwd = pathlib.Path('D:/Users/006340/Downloads/台大感管line起來')

# 1. 取得 commit 191dd2f 的原版 index.html
p = subprocess.Popen(['git', 'show', '191dd2f:index.html'], cwd=cwd, stdout=subprocess.PIPE)
out, _ = p.communicate()
content = out.decode('utf-8', errors='ignore')

# 2. 在主要導覽列補上「感控不踩雷」連結，兩者兼得
target_nav = '<a href="#features">服務亮點</a><a href="#promo-video">影片漫畫</a><a href="#event">活動辦法</a>'
replacement_nav = '<a href="#features">服務亮點</a><a href="#promo-video">影片漫畫</a><a href="#event">活動辦法</a><a href="learning.html">感控不踩雷</a>'
if target_nav in content:
    content = content.replace(target_nav, replacement_nav)

# 3. 寫入 index.html
(cwd / 'index.html').write_text(content, encoding='utf-8')
print("Successfully restored promotional index.html! Bytes:", len(content.encode('utf-8')))
