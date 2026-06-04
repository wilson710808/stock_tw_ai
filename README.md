# 📈 Stock TW AI - 台股 AI 投顧助手

> 智能台股投資顧問，整合即時股價、K線圖表、AI 深度分析與模擬交易

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## ✨ 功能特色

| 功能 | 說明 |
|------|------|
| 📊 **即時股價** | 輸入台股代碼，立即查詢股價、漲跌幅、成交量等 |
| 📈 **K 線圖表** | TradingView 專業級圖表，支援縮放拖曳 |
| 🤖 **AI 深度分析** | 8 種分析模式：全面、技術、基本面、風險評估等 |
| 💬 **AI 問答** | 與 AI 投顧顧問即時對話 |
| 💰 **模擬下單** | 100 萬台幣虛擬資金，練習投資策略 |
| 🛡️ **健康監控** | 自動監控服務狀態，異常時自動重啟 |

---

## 🚀 快速開始

### 1. 安裝依賴

```bash
git clone https://github.com/wilson710808/stock_tw_ai.git
cd stock_tw_ai
npm install
```

### 2. 配置環境變數

建立 `.env` 文件：

```env
# AI Gateway
GATEWAY_URL=http://127.0.0.1:3005
APP_ID=stock-tw-ai

# 服務端口
PORT=3007
```

### 3. 啟動服務

```bash
node server.js
```

### 4. 訪問應用

- 本機：http://localhost:3007
- 區域網路：http://你的IP:3007

---

## 📖 使用指南

### 查詢股價

1. 在搜尋框輸入股票代碼（如 `2330`、`2317`、`2454`）
2. 點擊「查詢」或按 Enter
3. 查看即時股價資訊

### AI 分析模式

| 模式 | 說明 | 適用場景 |
|------|------|----------|
| 全面分析 | 公司基本面 + 財務 + 技術 + 投資建議 | 了解股票全貌 |
| 技術分析 | 趨勢、支撐壓力、技術指標 | 短期操作 |
| 基本面分析 | 商業模式、財務健康、估值 | 長期投資 |
| 競爭對比 | 與同行業公司對比 | 選股決策 |
| 風險評估 | 估值/業務/競爭/宏觀風險 | 風險管理 |
| 買賣信號 | 具體買入價、止損價、目標價 | 執行交易 |

### 模擬下單

- 初始資金：1,000,000 台幣
- 支援買入、賣出、部分賣出
- 交易記錄自動保存（localStorage）

---

## 🔧 API 文檔

### 健康檢查

```http
GET /api/health
```

### 單股報價

```http
POST /api/quote
Content-Type: application/json

{ "ticker": "2330" }
```

### K 線數據

```http
GET /api/chart/:ticker
```

### AI 分析

```http
POST /api/analyze
Content-Type: application/json

{ 
  "ticker": "2330",
  "type": "overview"  // overview|technical|fundamental|risk|signal
}
```

### AI 問答

```http
POST /api/chat
Content-Type: application/json

{ 
  "messages": [
    { "role": "user", "content": "現在適合買入台積電嗎？" }
  ]
}
```

---

## 🛡️ 健康監控機制

### 自動監控

本專案內建健康監控腳本 `monitor.sh`，可搭配 OpenClaw Cron 或其他定時任務使用：

```bash
# 手動執行健康檢查
bash monitor.sh
```

### 監控功能

- **健康檢查**：定期檢測 `/api/health` 端點
- **自動重啟**：服務無響應時自動重啟
- **重試機制**：失敗重試 3 次（間隔 10 秒）
- **日誌記錄**：所有操作記錄到日誌文件

---

## 📁 專案結構

```
stock_tw_ai/
├── server.js           # 後端服務 (Express)
├── monitor.sh          # 健康監控腳本
├── public/
│   ├── index.html      # 前端 SPA
│   ├── app-config.js   # 配置文件
│   └── app-init.js     # 初始化模組
├── realtime_price.py   # 股價爬蟲 (Yahoo Finance)
├── recommend_stocks.py # 推薦股票列表
├── financial_data.py   # 財務數據獲取
├── db.js               # SQLite 數據庫
├── auth.js             # 認證模組
├── package.json
├── .env.example
└── .gitignore
```

---

## ⚠️ 風險聲明

1. 本系統所有資訊僅供參考，不構成投資建議
2. 股票投資有風險，可能導致本金虧損
3. 過往績效不代表未來表現
4. 投資前請諮詢專業人士

---

## 📄 授權

MIT License

---

## 🤝 貢貢獻

歡迎提交 Issue 和 Pull Request！

---

*最後更新：2026-06-04*
