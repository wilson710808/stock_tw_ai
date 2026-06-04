# TWSE 歷史 K 線 CSV 下載指南

**最後更新**: 2026-06-04 14:00

---

## 🎯 目的

讓 `market_data.py` 能夠獲取**真實的歷史 K 線數據**（非模擬數據），以便技術分析指標（MA, MACD, RSI 等）能正確計算。

---

## 📋 下載步驟

### 方法 1: 手動下載（推薦）

1. **前往 TWSE 網站**  
   [https://www.twse.com.tw/zh/page/trading/exchange/STOCK_DAY.html](https://www.twse.com.tw/zh/page/trading/exchange/STOCK_DAY.html)

2. **選擇查詢條件**
   - 股票代號：輸入 4 位數字（例如：2330, 2317, 2454）
   - 查詢年度：選擇「全部」或指定年度
   - 查詢月份：選擇「全部」或指定月份

3. **下載 CSV**
   - 點擊「查詢」→ 點擊「下載 CSV」按鈕
   - 儲存到 `stock_tw_ai/data/twse_csv/` 目錄

4. **重新命名**
   - 將 CSV 重新命名為 `{ticker}.csv`（例如：`2330.csv`）

---

### 方法 2: 使用 Python 腳本（進階）

```bash
# 安裝依賴
pip3 install pandas requests --break-system-packages

# 執行下載腳本（範例）
python3 -c "
import pandas as pd
import requests

ticker = '2330'
url = f'https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=csv&date=20240101&stockNo={ticker}'
df = pd.read_csv(url)
df.to_csv(f'data/twse_csv/{ticker}.csv', index=False, encoding='utf-8-sig')
print(f'✅ 已下載: data/twse_csv/{ticker}.csv')
"
```

---

## 📂 目錄結構

```
stock_tw_ai/
├── data/
│   ├── twse_csv/          # ← TWSE 原始 CSV（手動下載）
│   │   ├── 2330.csv
│   │   ├── 2317.csv
│   │   └── ...
│   ├── historical/        # ← 解析後的 CSV（供 API 使用）
│   │   ├── 2330.csv
│   │   ├── 2317.csv
│   │   └── ...
│   └── recommendations.json
├── market_data.py        # ← 會自動讀取 data/twse_csv/{ticker}.csv
└── ...
```

---

## 🔧 技術細節

### CSV 格式（TWSE 原始）

```
日期,開盤價,最高價,最低價,收盤價,成交股數,成交金額,漲跌價差,漲跌幅,本益比,殖利率,股價淨值比
113/01/02,45,952,45,952,45,707,45,750,46,177,114,577,381,6,966,508,736,-145,-0.31,20.5,2.8,3.2
```

### 解析後格式（market_data.py 使用）

```csv
time,open,high,low,close,volume
1717276800,45952,45952,45707,45750,46177381000
...
```

**轉換邏輯**:
1. 民國年轉西元年（`113/01/02` → `2024-01-02`）
2. 移除千分位逗號（`45,952` → `45952`）
3. 成交股數 → 成交量（股）（`114,577,381` → `114577381`）
4. 日期轉 Unix timestamp

---

## 🧪 驗證

下載 CSV 後，執行以下指令驗證：

```bash
cd /Users/here/.qclaw/workspace/stock_tw_ai

# 測試單檔股票
python3 market_data.py 2330

# 檢查輸出
cat data/historical/2330.csv | head -10
```

**預期結果**:
- 輸出 60 根蠟燭（JSON 格式）
- `data/historical/2330.csv` 有真實歷史數據（非模擬）

---

## 📊 推薦下載清單（40 檔）

### 半導體（5 檔）
```
2330.csv  (台積電)
2317.csv  (鴻海)
2454.csv  (聯發科)
2303.csv  (聯電)
2379.csv  (瑞昱)
```

### 電子零組件（5 檔）
```
2308.csv  (台達電)
2382.csv  (廣達)
2324.csv  (仁寶)
2353.csv  (宏碁)
2354.csv  (崇越)
```

### 電腦週邊（5 檔）
```
2356.csv  (英業達)
2385.csv  (群光)
2498.csv  (宏達電)
3231.csv  (緯創)
2352.csv  (佳世達)
```

### 通信網路（5 檔）
```
2412.csv  (中華電)
3045.csv  (台灣大)
4904.csv  (遠傳)
3443.csv  (創第)
3596.csv  (統振)
```

### 金融（5 檔）
```
2881.csv  (富邦金)
2882.csv  (國泰金)
2886.csv  (兆豐金)
2812.csv  (台新金)
2880.csv  (華南金)
```

### 傳產（5 檔）
```
1301.csv  (台塑)
1303.csv  (南亞)
1326.csv  (台化)
2105.csv  (正新)
2207.csv  (厚生)
```

### 光電（5 檔）
```
2409.csv  (友達)
2408.csv  (群創)
2466.csv  (開發)
2355.csv  (敬鵬)
3481.csv  (群創)
```

### 其他（5 檔）
```
1476.csv  (儒鴻)
1483.csv  (環球)
1516.csv  (川湖)
2371.csv  (大聯大)
3448.csv  (燿華)
```

---

## ⚠️ 注意事項

1. **時效性**: TWSE CSV 通常延遲 1-2 個交易日
2. **資料完整性**: 早期資料（2010 年以前）可能不完整
3. **編碼問題**: TWSE CSV 使用 Big5 編碼，需用 `utf-8-sig` 讀取
4. **更新頻率**: 建議每週更新一次

---

## 🚀 自動化建議

### 使用 OpenClaw Cron 定時下載

```json
{
  "name": "TWSE CSV 每週更新",
  "schedule": { "kind": "cron", "expr": "0 18 * * 5", "tz": "Asia/Taipei" },
  "payload": {
    "kind": "agentTurn",
    "message": "執行 TWSE CSV 下載：cd {workspace_root_dir}/stock_tw_ai && python3 download_twse_csv.py --all"
  },
  "delivery": { "mode": "announce", "channel": "openclaw-weixin" }
}
```

---

## 📞 聯絡

如有問題，請檢查：
1. `market_data.py` 是否正確讀取 `data/twse_csv/{ticker}.csv`
2. CSV 格式是否符合預期（民國年日期、千分位逗號）
3. 檔案編碼是否為 UTF-8 with BOM (`utf-8-sig`)

---

**祝下載順利！** 🎉
