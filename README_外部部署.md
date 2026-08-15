# 外部部署 LINE Bot

本專案可部署到 Render、Railway、Fly.io、VPS 等外部平台。知識庫內容在 `output/coze_upload`，不包含病人個資；`.env` 內的 LINE token 不可上傳公開倉庫。

## 必填環境變數

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `KNOWLEDGE_DIR=output/coze_upload`
- `HOST=0.0.0.0`
- `PORT=8000`

選填：

- `OPENAI_API_KEY`：未填時使用本機知識庫摘錄式回答。
- `OPENAI_MODEL=gpt-4.1-mini`
- `MAX_CONTEXT_CHARS=9000`
- `MAX_LINE_REPLY_CHARS=4500`

## Render 建議流程

1. 將本資料夾推到 GitHub 私有 repository。
2. 到 Render 建立 Web Service，選擇該 repository。
3. Render 會使用 `Dockerfile` 建置。
4. 在 Render Environment 填入 `LINE_CHANNEL_SECRET` 與 `LINE_CHANNEL_ACCESS_TOKEN`。
5. 部署完成後，確認：
   `https://你的服務網址/health`
6. 到 LINE Developers 將 Webhook URL 改為：
   `https://你的服務網址/line/webhook`
7. 按 Verify，成功後開啟 Use webhook。

## 本機 Docker 測試

```powershell
docker build -t ntuh-ic-line-bot .
docker run --rm -p 8000:8000 --env-file .env -e HOST=0.0.0.0 ntuh-ic-line-bot
```

測試：

```powershell
Invoke-WebRequest http://127.0.0.1:8000/health
```
