#!/usr/bin/env python3
"""
market_data.py - 台股數據獲取模組（本地優先 + TWSE CSV 歷史 K 線 + MIS API 即時）

功能：
1. 歷史 K 線 — 從 TWSE STOCK_DAY CSV 下載並解析（真實數據）
2. 即時報價 — 透過 TWSE MIS API
3. 推薦股票 — 讀取 recommendations.json
4. 市場大盤 — 上漲/下跌家數、成交量（未來擴充）
5. 個股基本面 — P/E、殖利率（未來擴充）

優先順序：本地 CSV > TWSE STOCK_DAY CSV > 模擬數據
"""

import json
import csv
import os
import urllib.request
import ssl
from datetime import datetime, timedelta
import random
import time
import sys

# ============================================
# 1. 歷史 K 線 (優先從 TWSE CSV 讀取)
# ============================================

def get_historical_kline(ticker, days=60):
    """
    獲取歷史 K 線
    1. 先嘗試從 data/historical/{ticker}.csv 讀取
    2. 若不存在，從 TWSE STOCK_DAY CSV 下載並解析
    3. 若 TWSE 失敗，生成模擬數據並保存
    """
    ticker = ticker.replace('.TW', '')
    csv_path = os.path.join(os.path.dirname(__file__), 'data', 'historical', f'{ticker}.csv')
    
    # 1. 嘗試讀取本地 CSV
    if os.path.exists(csv_path):
        print(f'[K線] 從本地 CSV 讀取: {ticker}')
        return _read_kline_csv(csv_path)
    
    # 2. 從 TWSE STOCK_DAY 下載
    print(f'[K線] 本地 CSV 不存在，從 TWSE 下載: {ticker}')
    candles = _download_twse_stock_day(ticker, days)
    if candles and len(candles) > 0:
        # 保存到本地 CSV
        os.makedirs(os.path.dirname(csv_path), exist_ok=True)
        with open(csv_path, 'w', encoding='utf-8', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=['time', 'open', 'high', 'low', 'close', 'volume'])
            writer.writeheader()
            writer.writerows(candles)
        print(f'[K線] TWSE CSV 下載成功並保存: {csv_path} ({len(candles)} 天)')
        return candles
    
    # 3. 失敗 → 生成模擬數據
    print(f'[K線] TWSE CSV 下載失敗，生成模擬數據: {ticker}')
    return _generate_simulated_kline(ticker, days, csv_path)

def _read_kline_csv(csv_path):
    """讀取本地 K 線 CSV"""
    candles = []
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            candles.append({
                'time': int(row['time']),
                'open': float(row['open']),
                'high': float(row['high']),
                'low': float(row['low']),
                'close': float(row['close']),
                'volume': int(row['volume'])
            })
    return candles

def _download_twse_stock_day(ticker, days=60):
    """
    從 TWSE STOCK_DAY CSV 下載歷史 K 線
    網址: https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=csv&date=YYYYMMDD&stockNo=XXXX
    
    返回: [{time, open, high, low, close, volume}, ...]
    """
    candles = []
    now = datetime.now()
    
    # 優先使用本地手動下載的 CSV
    local_csv = os.path.join(os.path.dirname(__file__), 'data', 'twse_csv', f'{ticker}.csv')
    if os.path.exists(local_csv):
        print(f'[K線] 使用本地 TWSE CSV: {local_csv}')
        return _parse_twse_csv(local_csv, days)
    
    # 否則嘗試從網路下載（可能超時）
    dates_to_try = []
    for i in range(0, min(days, 90), 30):
        date = now - timedelta(days=i)
        dates_to_try.append(date.strftime('%Y%m%d'))
    
    for date_str in dates_to_try:
        url = f'https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=csv&date={date_str}&stockNo={ticker}'
        
        try:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Referer': 'https://www.twse.com.tw/',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            })
            
            # 設置超時 10 秒
            with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
                content = resp.read().decode('utf-8-sig', errors='ignore')
            
            # 解析 CSV
            lines = content.strip().split('\n')
            
            for line in lines:
                line = line.strip()
                if not line or line.startswith('日期') or line.startswith('"日期') or line.startswith('說明:'):
                    continue
                
                # 移除 BOM 和引號
                line = line.replace('\ufeff', '').replace('"', '')
                
                # 格式: 113/01/02,45,952,45,952,45,707,45,750,46,177,114,577,381,6,966,508,736
                parts = line.split(',')
                
                if len(parts) < 9:
                    continue
                
                # 解析日期（民國年轉西元年）
                date_part = parts[0].strip()
                try:
                    year_str, month_str, day_str = date_part.split('/')
                    year = int(year_str) + 1911  # 民國年轉西元年
                    month = int(month_str)
                    day = int(day_str)
                    dt = datetime(year, month, day)
                    timestamp = int(dt.timestamp())
                except:
                    continue
                
                # 解析價格（處理千分位逗號）
                try:
                    # 開盤價
                    open_price = float(parts[1].replace(',', '')) if parts[1].strip() else 0
                    # 最高價
                    high_price = float(parts[2].replace(',', '')) if len(parts) > 2 and parts[2].strip() else 0
                    # 最低價
                    low_price = float(parts[3].replace(',', '')) if len(parts) > 3 and parts[3].strip() else 0
                    # 收盤價
                    close_price = float(parts[4].replace(',', '')) if len(parts) > 4 and parts[4].strip() else 0
                    # 成交股數（千股）→ 成交量（股）
                    volume_str = parts[8].replace(',', '') if len(parts) > 8 else '0'
                    volume = int(float(volume_str) * 1000) if volume_str and volume_str != '0' else 0
                    
                    if close_price > 0:  # 只保留有收盤價的資料
                        candles.append({
                            'time': timestamp,
                            'open': open_price,
                            'high': high_price,
                            'low': low_price,
                            'close': close_price,
                            'volume': volume
                        })
                except (ValueError, IndexError) as e:
                    print(f'[K線] 解析失敗: {line[:50]}... ({e})')
                    continue
        
        except Exception as e:
            print(f'[K線] TWSE CSV 下載失敗 ({date_str}): {e}')
            continue
    
    # 按時間排序並去重
    candles = sorted(candles, key=lambda x: x['time'])
    unique_candles = []
    seen_times = set()
    for c in candles:
        if c['time'] not in seen_times:
            seen_times.add(c['time'])
            unique_candles.append(c)
    
    print(f'[K線] TWSE 下載完成: {len(unique_candles)} 天')
    return unique_candles[-days:] if unique_candles else []

def _parse_twse_csv(csv_path, days=60):
    """
    解析本地 TWSE CSV 檔案
    格式: 日期,開盤價,最高價,最低價,收盤價,成交股數
    範例: 113/01/02,45,952,45,952,45,707,45,750,46,177,114,577,381
    """
    candles = []
    
    with open(csv_path, 'r', encoding='utf-8-sig', errors='ignore') as f:
        lines = f.readlines()
    
    for line in lines:
        line = line.strip()
        if not line or line.startswith('日期') or line.startswith('"日期') or line.startswith('說明:'):
            continue
        
        # 移除 BOM 和引號
        line = line.replace('\ufeff', '').replace('"', '')
        
        parts = line.split(',')
        
        if len(parts) < 9:
            continue
        
        # 解析日期（民國年轉西元年）
        date_part = parts[0].strip()
        try:
            year_str, month_str, day_str = date_part.split('/')
            year = int(year_str) + 1911  # 民國年轉西元年
            month = int(month_str)
            day = int(day_str)
            dt = datetime(year, month, day)
            timestamp = int(dt.timestamp())
        except:
            continue
        
        # 解析價格（處理千分位逗號）
        try:
            open_price = float(parts[1].replace(',', '')) if parts[1].strip() else 0
            high_price = float(parts[2].replace(',', '')) if len(parts) > 2 and parts[2].strip() else 0
            low_price = float(parts[3].replace(',', '')) if len(parts) > 3 and parts[3].strip() else 0
            close_price = float(parts[4].replace(',', '')) if len(parts) > 4 and parts[4].strip() else 0
            volume_str = parts[8].replace(',', '') if len(parts) > 8 else '0'
            volume = int(float(volume_str) * 1000) if volume_str and volume_str != '0' else 0
            
            if close_price > 0:
                candles.append({
                    'time': timestamp,
                    'open': open_price,
                    'high': high_price,
                    'low': low_price,
                    'close': close_price,
                    'volume': volume
                })
        except (ValueError, IndexError) as e:
            print(f'[K線] 解析失敗: {line[:50]}... ({e})')
            continue
    
    # 按時間排序
    candles = sorted(candles, key=lambda x: x['time'])
    print(f'[K線] 解析本地 CSV 完成: {len(candles)} 天')
    return candles[-days:] if candles else []

def _generate_simulated_kline(ticker, days, csv_path):
    """
    生成模擬 K 線並保存到 CSV
    使用隨機漫步 + 今日真實 OHLC（若可獲取）
    """
    # 嘗試獲取即時價格作為基準
    quote = get_realtime_quote(ticker)
    base_price = quote.get('price', 100.0) if quote.get('success') else 100.0
    
    candles = []
    now = datetime.now()
    
    for i in range(days):
        date = now - timedelta(days=days-i)
        timestamp = int(date.timestamp())
        
        # 隨機漫步
        change = random.uniform(-0.03, 0.03)
        price = base_price * (1 + change * (i / days))
        
        open_p = price * (1 + random.uniform(-0.01, 0.01))
        close_p = price * (1 + random.uniform(-0.01, 0.01))
        high_p = max(open_p, close_p) * (1 + random.uniform(0, 0.02))
        low_p = min(open_p, close_p) * (1 - random.uniform(0, 0.02))
        volume = int(random.uniform(5000, 50000))
        
        candles.append({
            'time': timestamp,
            'open': round(open_p, 2),
            'high': round(high_p, 2),
            'low': round(low_p, 2),
            'close': round(close_p, 2),
            'volume': volume
        })
    
    # 保存 CSV
    os.makedirs(os.path.dirname(csv_path), exist_ok=True)
    with open(csv_path, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=['time', 'open', 'high', 'low', 'close', 'volume'])
        writer.writeheader()
        writer.writerows(candles)
    
    print(f'[K線] 已生成並保存: {csv_path}')
    return candles

# ============================================
# 2. 即時報價 (TWSE MIS API)
# ============================================

def get_realtime_quote(ticker):
    """
    獲取即時報價（TWSE MIS API）
    返回: { success, price, change, changePercent, volume, ... }
    """
    ticker = ticker.replace('.TW', '')
    url = f'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_{ticker}.tw&json=1&delay=0'
    
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://mis.twse.com.tw/'
    })
    
    try:
        with urllib.request.urlopen(req, timeout=8, context=ctx) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        
        if data.get('msgArray') and len(data['msgArray']) > 0:
            msg = data['msgArray'][0]
            z = float(msg.get('z', 0))
            y = float(msg.get('y', 0))
            return {
                'success': True,
                'ticker': ticker,
                'name': msg.get('n', ticker),
                'price': z,
                'prevClose': y,
                'change': round(z - y, 2),
                'changePercent': round((z - y) / y * 100, 2) if y > 0 else 0,
                'volume': int(msg.get('tv', 0)),
                'high': float(msg.get('h', 0)),
                'low': float(msg.get('l', 0)),
                'open': float(msg.get('o', 0)),
                'source': 'twse'
            }
    except Exception as e:
        pass
    
    return { 'success': False, 'ticker': ticker }

# ============================================
# 3. 更新當日 K 線（每日 13:30 收盤後呼叫）
# ============================================

def update_daily_kline(ticker):
    """
    更新當日 K 線到本地 CSV
    應在每個交易日 13:30 後呼叫（收盤後）
    """
    ticker = ticker.replace('.TW', '')
    csv_path = os.path.join(os.path.dirname(__file__), 'data', 'historical', f'{ticker}.csv')
    
    # 獲取即時 OHLC
    quote = get_realtime_quote(ticker)
    if not quote.get('success'):
        return { 'success': False, 'error': '無法獲取即時報價' }
    
    today = datetime.now().date()
    timestamp = int(datetime.combine(today, datetime.min.time()).timestamp())
    
    new_candle = {
        'time': timestamp,
        'open': quote['open'],
        'high': quote['high'],
        'low': quote['low'],
        'close': quote['price'],
        'volume': quote['volume']
    }
    
    # 讀取現有 CSV 並附加
    candles = _read_kline_csv(csv_path) if os.path.exists(csv_path) else []
    
    # 檢查今天是否已有資料
    if candles and candles[-1]['time'] == timestamp:
        candles[-1] = new_candle  # 更新
    else:
        candles.append(new_candle)  # 新增
    
    # 保存
    os.makedirs(os.path.dirname(csv_path), exist_ok=True)
    with open(csv_path, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=['time', 'open', 'high', 'low', 'close', 'volume'])
        writer.writeheader()
        writer.writerows(candles)
    
    return { 'success': True, 'candle': new_candle, 'total': len(candles) }

# ============================================
# 4. CLI 測試
# ============================================

if __name__ == '__main__':
    import sys
    
    if len(sys.argv) < 2:
        print('用法: python3 market_data.py <ticker> [update]')
        print('  python3 market_data.py 2330        # 查詢歷史 K 線（輸出 JSON）')
        print('  python3 market_data.py 2330 update # 更新當日 K 線')
        sys.exit(1)
    
    ticker = sys.argv[1]
    
    if 'update' in sys.argv:
        result = update_daily_kline(ticker)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        candles = get_historical_kline(ticker, days=60)
        # 輸出 JSON 陣列（供 server.js 解析）
        print(json.dumps(candles, ensure_ascii=False))
