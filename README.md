# 可可掃描

手機文件掃描 PWA：自動抓文件邊框、透視校正（含真實長寬比還原）、去陰影、四種增強模式、多頁管理、匯出 PDF／圖片。所有資料只存在手機瀏覽器裡，不會上傳。

## 架設到 GitHub Pages

1. 在 GitHub 新增一個 repo（例如 `scanner`），設為 Public。
2. 把這個資料夾裡的**所有檔案與子資料夾**（`index.html`、`app.js`、`worker.js`、`sw.js`、`manifest.webmanifest`、`lib/`、`icons/`）上傳到 repo 根目錄。
   - `lib/opencv.js` 約 10 MB，網頁上傳可以接受（上限 25 MB）。
3. repo 的 **Settings → Pages**，Source 選 `Deploy from a branch`，Branch 選 `main`、資料夾 `/ (root)`，按 Save。
4. 約一分鐘後網址會是 `https://andywu1101.github.io/scanner/`。

## 加到手機桌面

- **iPhone**：用 Safari 開網址 → 分享按鈕 → 加入主畫面。
- **Android**：用 Chrome 開網址 → 右上選單 → 安裝應用程式／加到主畫面。

第一次開啟會下載影像引擎（約 10 MB），之後離線也能用。

## 兩種拍攝方式

| | 即時掃描 | 高畫質拍照 |
|---|---|---|
| 操作 | 對準文件，穩定約 1 秒自動拍，可連續多頁 | 開啟手機相機拍一張，再微調四角 |
| Android 畫質 | 相機全解析度 | 相機全解析度 |
| iPhone 畫質 | 受限於網頁相機串流（約 1080p–4K） | 相機全解析度（最清楚） |

## 增強模式

- **彩色**：提亮紙張、去除陰影、略微銳利化
- **灰階**：去陰影後轉灰階
- **黑白**：純黑白，最適合樂譜、講義；匯出 PDF 時以 1-bit 無損嵌入
- **原圖**：只裁切校正

## 更新版本

修改程式後，把 `sw.js` 第一行的 `cocoscan-v1` 改成 `cocoscan-v2`（依此類推）再上傳，手機重開 App 兩次就會換成新版。
