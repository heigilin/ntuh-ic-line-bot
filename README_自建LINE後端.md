# 自建 LINE 後端最小版

這個資料夾已建立一個最小可用的 LINE Webhook 後端。它會讀取 `output/coze_upload/*.md`，先做本機知識庫檢索，再回覆 LINE。

## 1. 確認 Python

```powershell
cd "D:\Users\006340\Downloads\台大感管line起來"
python --version
```

目前 `app.py` 使用 Python 標準庫，不需安裝額外套件。

## 2. 建立 .env

複製 `.env.example` 為 `.env`，填入 LINE Developers 的密鑰。

```powershell
Copy-Item .env.example .env
notepad .env
```

需要填：

```text
LINE_CHANNEL_SECRET=你的 Channel secret
LINE_CHANNEL_ACCESS_TOKEN=你的 long-lived Channel access token
```

`OPENAI_API_KEY` 可先空白。空白時會用知識庫摘錄式回答；填入後會改由 AI 依知識庫整理中文回答。

## 3. 本機測試

```powershell
python app.py
```

開另一個 PowerShell 測試：

```powershell
Invoke-RestMethod "http://127.0.0.1:8000/health"
Invoke-RestMethod "http://127.0.0.1:8000/ask?q=登革熱環境怎麼消毒"
```

## 4. 暫時接 LINE 測試

本機電腦需要一個公開 HTTPS 網址才能給 LINE Webhook 使用。可用 cloudflared 或 ngrok。

cloudflared 範例：

```powershell
cloudflared tunnel --url http://127.0.0.1:8000
```

它會產生類似：

```text
https://xxxxx.trycloudflare.com
```

到 LINE Developers 的 Messaging API channel，把 Webhook URL 改成：

```text
https://xxxxx.trycloudflare.com/line/webhook
```

然後確認 `Use webhook` 是 Enabled，並關閉 LINE 後台自動回應，避免和 Webhook 搶回覆。

## 5. 注意事項

- 不要把 `.env` 傳給別人，也不要貼到聊天視窗。
- LINE 上請提醒同仁不要輸入病人姓名、病歷號、床號等個資。
- 若正式上線，建議部署到院內 VM 或可信任的 HTTPS 主機，不要長期依賴臨時 tunnel。
