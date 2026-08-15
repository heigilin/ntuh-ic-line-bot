# Google Cloud Run 部署

Cloud Run 會提供固定 HTTPS URL，可直接作為 LINE Webhook，不需要 ngrok、Cloudflare Tunnel 或 Apps Script Web App。

## 事前準備

需要：

- Google Cloud 專案
- 已啟用 Billing
- 已啟用 Cloud Run API
- 已啟用 Cloud Build API

本專案已具備：

- `Dockerfile`
- `.gcloudignore`
- `app.py` 支援 `HOST` 與 `PORT`
- 知識庫位於 `output/coze_upload`

## 用 Google Cloud Console 部署

1. 開啟 Google Cloud Console。
2. 進入 Cloud Run。
3. 點 Create service。
4. 選 Deploy one revision from an existing container image 或從 GitHub source build。
5. 若從 GitHub source build：
   - Repository：`heigilin/ntuh-ic-line-bot`
   - Branch：`main`
   - Build type：Dockerfile
6. Service name：
   - `ntuh-ic-line-bot`
7. Region：
   - 建議 `asia-east1` 或離台灣近的區域。
8. Authentication：
   - 選 Allow unauthenticated invocations。
   - LINE webhook 必須能不登入呼叫。
9. Container port：
   - `8000`
10. Environment variables：
   - `HOST=0.0.0.0`
   - `PORT=8000`
   - `KNOWLEDGE_DIR=output/coze_upload`
   - `MAX_CONTEXT_CHARS=9000`
   - `MAX_LINE_REPLY_CHARS=4500`
   - `LINE_CHANNEL_SECRET=你的 LINE Channel secret`
   - `LINE_CHANNEL_ACCESS_TOKEN=你的 LINE Channel access token`
   - `OPENAI_MODEL=gpt-4.1-mini`
   - `OPENAI_API_KEY=` 可先留空。
11. Deploy。

## 部署後測試

Cloud Run 會給一個 URL，例如：

```text
https://ntuh-ic-line-bot-xxxxx-uc.a.run.app
```

先測：

```text
https://ntuh-ic-line-bot-xxxxx-uc.a.run.app/health
```

正常會看到：

```json
{"ok": true, "chunks": ..., "openai_enabled": false}
```

再到 LINE Developers 設定 Webhook URL：

```text
https://ntuh-ic-line-bot-xxxxx-uc.a.run.app/line/webhook
```

按 Verify，成功後開啟 Use webhook。

## 注意

- `.env` 不要上傳，也不要放進 Docker image。
- LINE token 請只放 Cloud Run environment variables。
- Cloud Run 若一段時間沒流量可能會冷啟動，第一句可能稍慢。
- 若要讓 Gemini/OpenAI 修飾回答，需設定 `OPENAI_API_KEY` 或另行改接 Gemini API。
