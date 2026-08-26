# GAS + Gemini + LINE 部署

## 檔案

- `Code.gs`：貼到 Google Apps Script。
- `code.gs(9千列版備份_勿使用).txt`：僅作為需求與舊版功能參考，請勿貼到 Google Apps Script。該版本程式量過大，容易造成 LINE webhook 等不到 HTTP 200、訊息不回應或執行逾時。
- `output/gas/kb_index.json`：上傳到 Google Drive 知識庫資料夾。
- `gas_line_bot/audit_clauses.json`：評鑑條文重點、委員提問與 KM 佐證；與知識庫放在同一個 Google Drive 資料夾，不嵌入 `Code.gs`。
- `synonyms.json`：常見問法/同義詞字典；已由產生索引腳本嵌入 `kb_index.json`。
- `intent_rules.json`：可資料化的閒聊、導流、邊界與常見意圖規則；已由產生索引腳本嵌入 `kb_index.json`。

## 部署原則

目前正式部署請只使用 `Code.gs` 這個精簡版。舊版 9 千列檔案中有身分辨識、滿意度、推播、意見箱、Flex card、旅遊門診與大量特殊規則，適合拆成小功能逐步回補，不適合整包貼回 GAS。若需要補回功能，請先確認：

1. 是否會影響 webhook 先回 200。
2. 是否會讓每次訊息都讀取試算表、寄信、推播或呼叫多個外部服務。
3. 是否有明確觸發條件，避免問 A 答 B。
4. 是否能用 `node --check` 通過語法檢查後再貼到 Apps Script。

## Google Drive

1. 建立一個資料夾，例如 `ntuh_ic_line_kb`。
2. 上傳 `output/gas/kb_index.json` 與 `gas_line_bot/audit_clauses.json`。
3. 複製資料夾 ID。網址格式通常是：
   `https://drive.google.com/drive/folders/資料夾ID`

## Apps Script

1. 到 https://script.google.com 建立新專案。
2. 將 `Code.gs` 全文貼上。
3. 專案設定 > Script properties，新增：
   - `KB_FOLDER_ID`
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `GEMINI_API_KEY`
   - `CJD_RECONCILIATION_IMAGE_URL`：CJD 院內／手動勾稽桌面宣導圖的公開 HTTPS 圖片網址。
   - `CJD_TISSUE_IMAGE_URL`：CJD 組織感染力分級圖的公開 HTTPS 圖片網址。

LINE 圖片訊息不能讀取本機 `D:\` 路徑；兩張圖須先放到可公開讀取、直接回傳圖片內容的 HTTPS 網址。若圖片網址尚未設定或不是 HTTPS，CJD 文字回答仍會正常送出，但不附圖。

CJD 圖片上傳來源固定使用專案根目錄中的：

- `桌面宣導_標準版大小.png` → `CJD_RECONCILIATION_IMAGE_URL`
- `投影片11.JPG` → `CJD_TISSUE_IMAGE_URL`

目前公開圖片網址：

- `CJD_RECONCILIATION_IMAGE_URL` = `https://heigilin.github.io/ntuh_cdc/assets/line-bot/cjd/reconciliation-guide.png`
- `CJD_TISSUE_IMAGE_URL` = `https://heigilin.github.io/ntuh_cdc/assets/line-bot/cjd/tissue-infectivity.jpg`
- VRE 解隔補充圖維護於 `clearance_rules.json` 的 `VRE.image_url`，不在 `Code.gs` 新增專屬常數或函式。

`Code.gs` 內含上述已驗證網址作為預設值；若 Script Properties 有同名設定，則以 Script Properties 為準。

疾病解隔規則另存於 `clearance_rules.json`，部署知識庫時須與 `kb_index.json`、`audit_clauses.json` 放在同一個 `KB_FOLDER_ID` 資料夾。

對應關係亦記錄於 `gas_line_bot/cjd_image_assets.json`，避免日後從其他資料夾誤傳同名舊圖。
4. 第一次部署：部署 > 新增部署作業 > 網頁應用程式。
5. 執行身分：我。
6. 存取權：任何人。
7. 複製結尾為 `/exec` 的 Web app URL。

之後修改程式碼時，請不要再按「新增部署作業」。請使用：

1. 部署 > 管理部署作業。
2. 點選既有的網頁應用程式部署。
3. 點右上角鉛筆圖示。
4. 版本選「新版本」。
5. 按「部署」。

這樣 Web app URL 會固定不變。

## GAS 上線測試

把結尾為 `/exec` 的 Web app URL 貼到瀏覽器。

如果畫面顯示：

```text
LINE Bot Webhook 運作正常！
```

代表 GAS 網址與「任何人可存取」設定正常。

## LINE Developers

Webhook URL 填：

```text
Google Apps Script Web app URL
```

請直接貼結尾為 `/exec` 的網址，不要加 `?token=`。目前這版 `Code.gs` 已處理 LINE Verify 的空 `events`，LINE 後台 Verify 應可回 Success。

## 更新同義詞

常見問法請維護 `gas_line_bot/synonyms.json`，修改後重新產生索引：

```powershell
python scripts\build_gas_kb_index.py
```

再把新的 `output/gas/kb_index.json` 覆蓋上傳到 Google Drive；若有更新評鑑條文，也一併覆蓋 `audit_clauses.json`。

## 更新閒聊/導流規則

若要新增「你難聊」「你是男生」「糖尿病可以吃珍奶」這類不應進入感染管制知識庫的常見問法，優先維護 `gas_line_bot/intent_rules.json`，不要直接把大量正則塞回 `Code.gs`。

修改後同樣重新產生索引：

```powershell
python scripts\build_gas_kb_index.py
```

再把新的 `output/gas/kb_index.json` 覆蓋上傳到 Google Drive。`Code.gs` 會從 `kb_index.json.intent_rules.rules` 讀取規則；若 Drive 尚未更新，程式內仍保留最低限度 fallback，不會造成 webhook 失效。
