# GAS + Gemini + LINE 部署

## 檔案

- `Code.gs`：貼到 Google Apps Script。
- `output/gas/kb_index.json`：上傳到 Google Drive 知識庫資料夾。
- `synonyms.json`：常見問法/同義詞字典；已由產生索引腳本嵌入 `kb_index.json`。

## Google Drive

1. 建立一個資料夾，例如 `ntuh_ic_line_kb`。
2. 上傳 `output/gas/kb_index.json`。
3. 複製資料夾 ID。網址格式通常是：
   `https://drive.google.com/drive/folders/資料夾ID`

## Apps Script

1. 到 https://script.google.com 建立新專案。
2. 將 `Code.gs` 全文貼上。
3. 專案設定 > Script properties，新增：
   - `KB_FOLDER_ID`
   - `LINE_CHANNEL_SECRET`
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `GEMINI_API_KEY`
   - `VERIFY_LINE_SIGNATURE=false`
   - `WEBHOOK_TOKEN`：自訂一串長字串，例如 `ntuh-ic-隨機字串`
4. 部署 > 新增部署作業 > 網頁應用程式。
5. 執行身分：我。
6. 存取權：任何人。
7. 複製 Web app URL。

## LINE Developers

Webhook URL 填：

```text
Google Apps Script Web app URL?token=WEBHOOK_TOKEN的值
```

注意：Apps Script Web App 不一定能取得 LINE 的 `X-Line-Signature` header，因此 MVP 先設定 `VERIFY_LINE_SIGNATURE=false`。若後續確認 `e.headers` 可取得 header，再改為 `true`。

如果 Verify 因轉址失敗，需改用 Google Cloud Run / Render / VPS；LINE 對某些會轉址的 webhook endpoint 可能不接受。

## 更新同義詞

常見問法請維護 `gas_line_bot/synonyms.json`，修改後重新產生索引：

```powershell
python scripts\build_gas_kb_index.py
```

再把新的 `output/gas/kb_index.json` 覆蓋上傳到 Google Drive。
