#!/usr/bin/env python3
"""
market_data.py - 台股數據獲取模組（TWSE OpenAPI + MIS API）

功能：
1. 歷史 K 線 — 從 TWSE OpenAPI (STOCK_DAY_ALL) 取當日數據，累積到本地 CSV
2. 即時報價 — 透過 TWSE MIS API
3. 更新當日 K 線 — 每日收盤後呼叫

優先順序：本地 CSV > TWSE OpenAPI > MIS API 即時 > 模擬數據

TWSE OpenAPI 端點（可從 Mac mini 連線）：
- STOCK_DAY_ALL: https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL
  返回所有上市股票當日 OHLCV，民國年日期格式 (1150603 = 2026/06/03)
- FMTQIK: https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK
  返回大盤統計（成交值/指數）
"""

import json
import sys
import csv
import os
import urllib.request
import ssl
from datetime import datetime, timedelta
import random
import time

# ============================================
# 共用 SSL 與 HTTP 工具
# ============================================

_ctx = ssl.create_default_context()
_ctx.check_hostname = False
_ctx.verify_mode = ssl.CERT_NONE

_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    'Accept': 'application/json',
    'If-Modified-Since': '0'
}

def _fetch_json(url, timeout=15):
    """通用 JSON API 請求"""
    req = urllib.request.Request(url, headers=_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ctx) as resp:
            raw = resp.read()
            return json.loads(raw.decode('utf-8'))
    except Exception as e:
        sys.stderr.write(f'[market_data] fetch failed: {url} → {e}\n')
        return None

def _roc_to_ad(roc_date_str):
    """民國年日期轉西元 (1150603 → 20260603 → datetime)"""
    try:
        roc = int(roc_date_str)
        year = roc // 10000 + 1911
        rest = roc % 10000
        month = rest // 100
        day = rest % 100
        return datetime(year, month, day)
    except:
        return None

def _safe_float(val):
    """安全轉 float，處理空字串和千分位逗號"""
    if not val or val in ('--', 'X', ''):
        return 0.0
    try:
        return float(str(val).replace(',', ''))
    except:
        return 0.0

# ============================================
# 1. TWSE OpenAPI: STOCK_DAY_ALL（當日全部上市股票）
# ============================================

_openapi_cache = {}
_openapi_cache_time = 0

def _fetch_stock_day_all():
    """
    從 TWSE OpenAPI 取得當日全部上市股票數據
    有 60 秒快取，避免過度請求
    """
    global _openapi_cache, _openapi_cache_time
    
    now = time.time()
    if _openapi_cache and (now - _openapi_cache_time) < 60:
        return _openapi_cache
    
    data = _fetch_json('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL')
    if data and isinstance(data, list):
        _openapi_cache = data
        _openapi_cache_time = now
        return data
    return _openapi_cache or None

def _get_today_from_openapi(ticker):
    """
    從 STOCK_DAY_ALL 取得單一股票當日 OHLCV
    返回: { date, open, high, low, close, volume } 或 None
    """
    ticker = ticker.replace('.TW', '')
    data = _fetch_stock_day_all()
    if not data:
        return None
    
    for row in data:
        if row.get('Code') == ticker:
            close = _safe_float(row.get('ClosingPrice'))
            if close <= 0:
                return None
            dt = _roc_to_ad(row.get('Date', ''))
            return {
                'date': dt,
                'timestamp': int(dt.timestamp()) if dt else 0,
                'open': _safe_float(row.get('OpeningPrice')),
                'high': _safe_float(row.get('HighestPrice')),
                'low': _safe_float(row.get('LowestPrice')),
                'close': close,
                'volume': int(_safe_float(row.get('TradeVolume'))),
                'source': 'openapi'
            }
    return None

# ============================================
# 2. 歷史 K 線
# ============================================

def get_historical_kline(ticker, days=60):
    """
    獲取歷史 K 線（快速模式，只用本地 CSV + MIS API 即時）
    
    ⚠️ 不主動呼叫 OpenAPI STOCK_DAY_ALL（1.2MB JSON 會超時）
    OpenAPI 更新由 batch_update_from_openapi() 定時任務處理
    
    優先順序：本地 CSV → MIS API 即時補充 → 模擬數據
    """
    ticker = ticker.replace('.TW', '')
    csv_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'historical')
    csv_path = os.path.join(csv_dir, f'{ticker}.csv')
    
    # 1. 讀取本地 CSV
    candles = []
    if os.path.exists(csv_path):
        candles = _read_kline_csv(csv_path)
        sys.stderr.write(f'[K線] 本地 CSV: {ticker}, {len(candles)} 根\n')
    
    # 2. 用 MIS API 快速補充當日數據（輕量，<1KB）
    if not candles or (candles and _is_stale(candles)):
        quote = get_realtime_quote(ticker)
        if quote.get('success') and quote.get('price', 0) > 0:
            today = datetime.now().date()
            today_ts = int(datetime.combine(today, datetime.min.time()).timestamp())
            
            already_has_today = any(c['time'] == today_ts for c in candles)
            
            today_candle = {
                'time': today_ts,
                'open': quote['open'],
                'high': quote['high'],
                'low': quote['low'],
                'close': quote['price'],
                'volume': quote['volume']
            }
            
            if already_has_today:
                for i, c in enumerate(candles):
                    if c['time'] == today_ts:
                        candles[i] = today_candle
                        break
            else:
                candles.append(today_candle)
            
            sys.stderr.write(f'[K線] MIS API 補充當日: {ticker} close={quote["price"]}\n')
    
    # 3. 有數據就保存並返回
    if candles:
        candles = _deduplicate_sort(candles)
        os.makedirs(csv_dir, exist_ok=True)
        _save_kline_csv(csv_path, candles)
        return candles[-days:]
    
    # 4. 無數據 → 模擬
    sys.stderr.write(f'[K線] 無數據，生成模擬: {ticker}\n')
    return _generate_simulated_kline(ticker, days, csv_path)

def _is_stale(candles):
    """檢查 K 線數據是否過時（最新一根不是今天或昨天）"""
    if not candles:
        return True
    latest_ts = candles[-1]['time']
    latest_date = datetime.fromtimestamp(latest_ts).date()
    today = datetime.now().date()
    return (today - latest_date).days > 1

def _read_kline_csv(csv_path):
    """讀取本地 K 線 CSV"""
    candles = []
    try:
        with open(csv_path, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                candles.append({
                    'time': int(row['time']),
                    'open': float(row['open']),
                    'high': float(row['high']),
                    'low': float(row['low']),
                    'close': float(row['close']),
                    'volume': int(float(row['volume']))
                })
    except Exception as e:
        sys.stderr.write(f'[K線] CSV 讀取失敗: {e}\n')
    return candles

def _save_kline_csv(csv_path, candles):
    """保存 K 線到 CSV"""
    os.makedirs(os.path.dirname(csv_path), exist_ok=True)
    with open(csv_path, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=['time', 'open', 'high', 'low', 'close', 'volume'])
        writer.writeheader()
        writer.writerows(candles)

def _deduplicate_sort(candles):
    """去重 + 排序"""
    seen = {}
    for c in candles:
        seen[c['time']] = c
    return sorted(seen.values(), key=lambda x: x['time'])

def _generate_simulated_kline(ticker, days, csv_path):
    """生成模擬 K 線並保存"""
    quote = get_realtime_quote(ticker)
    base_price = quote.get('price', 100.0) if quote.get('success') else 100.0
    
    candles = []
    now = datetime.now()
    price = base_price * 0.95  # 從稍低的價格開始
    
    for i in range(days):
        date = now - timedelta(days=days - i)
        if date.weekday() >= 5:
            continue
        timestamp = int(date.replace(hour=0, minute=0, second=0).timestamp())
        change = random.gauss(0, 0.015)
        price = price * (1 + change)
        high = price * (1 + random.uniform(0, 0.01))
        low = price * (1 - random.uniform(0, 0.01))
        vol = int(random.uniform(5000, 50000))
        candles.append({
            'time': timestamp,
            'open': round(price * (1 - random.uniform(0, 0.005)), 2),
            'high': round(high, 2),
            'low': round(low, 2),
            'close': round(price, 2),
            'volume': vol
        })
    
    _save_kline_csv(csv_path, candles)
    sys.stderr.write(f'[K線] 模擬數據已保存: {csv_path}\n')
    return candles

# ============================================
# 3. 批量更新歷史 K 線（從 OpenAPI 取多天數據）
# ============================================

def batch_update_from_openapi(tickers=None):
    """
    批量從 OpenAPI 取得當日數據並更新本地 CSV
    用於每日定時任務（13:30 收盤後）
    
    參數:
      tickers: 股票代碼列表，None 表示取全部上市股票
    返回:
      { success, updated, total, errors }
    """
    data = _fetch_stock_day_all()
    if not data:
        return {'success': False, 'error': 'OpenAPI 無數據'}
    
    csv_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'historical')
    os.makedirs(csv_dir, exist_ok=True)
    
    updated = 0
    errors = 0
    total = 0
    
    # 篩選目標股票
    target_codes = set(t.replace('.TW', '') for t in (tickers or []))
    
    for row in data:
        code = row.get('Code', '')
        
        # 如果有指定 tickers，只處理那些
        if target_codes and code not in target_codes:
            continue
        
        close = _safe_float(row.get('ClosingPrice'))
        if close <= 0:
            continue
        
        total += 1
        dt = _roc_to_ad(row.get('Date', ''))
        if not dt:
            continue
        
        timestamp = int(dt.timestamp())
        csv_path = os.path.join(csv_dir, f'{code}.csv')
        
        # 讀取現有 CSV
        candles = _read_kline_csv(csv_path) if os.path.exists(csv_path) else []
        
        # 檢查今天是否已有
        already_has = any(c['time'] == timestamp for c in candles)
        
        new_candle = {
            'time': timestamp,
            'open': _safe_float(row.get('OpeningPrice')),
            'high': _safe_float(row.get('HighestPrice')),
            'low': _safe_float(row.get('LowestPrice')),
            'close': close,
            'volume': int(_safe_float(row.get('TradeVolume')))
        }
        
        if already_has:
            # 更新
            for i, c in enumerate(candles):
                if c['time'] == timestamp:
                    candles[i] = new_candle
                    break
        else:
            candles.append(new_candle)
        
        # 去重排序保存
        candles = _deduplicate_sort(candles)
        _save_kline_csv(csv_path, candles)
        updated += 1
    
    return {
        'success': True,
        'updated': updated,
        'total': total,
        'errors': errors,
        'date': datetime.now().isoformat()
    }

# ============================================
# 4. 即時報價 (TWSE MIS API)
# ============================================

def get_realtime_quote(ticker):
    """獲取即時報價（TWSE MIS API）"""
    ticker = ticker.replace('.TW', '')
    url = f'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_{ticker}.tw&json=1&delay=0'
    
    try:
        data = _fetch_json(url, timeout=8)
        if data and data.get('msgArray') and len(data['msgArray']) > 0:
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
    except:
        pass
    
    return {'success': False, 'ticker': ticker}

# ============================================
# 5. 更新當日 K 線
# ============================================

def update_daily_kline(ticker):
    """更新當日 K 線到本地 CSV"""
    ticker = ticker.replace('.TW', '')
    csv_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'historical')
    csv_path = os.path.join(csv_dir, f'{ticker}.csv')
    
    # 優先從 OpenAPI 取（更穩定）
    today = _get_today_from_openapi(ticker)
    if today and today['timestamp'] > 0:
        candles = _read_kline_csv(csv_path) if os.path.exists(csv_path) else []
        already_has = any(c['time'] == today['timestamp'] for c in candles)
        
        new_candle = {
            'time': today['timestamp'],
            'open': today['open'],
            'high': today['high'],
            'low': today['low'],
            'close': today['close'],
            'volume': today['volume']
        }
        
        if already_has:
            for i, c in enumerate(candles):
                if c['time'] == today['timestamp']:
                    candles[i] = new_candle
                    break
        else:
            candles.append(new_candle)
        
        candles = _deduplicate_sort(candles)
        os.makedirs(csv_dir, exist_ok=True)
        _save_kline_csv(csv_path, candles)
        return {'success': True, 'candle': new_candle, 'total': len(candles), 'source': 'openapi'}
    
    # Fallback: MIS API
    quote = get_realtime_quote(ticker)
    if not quote.get('success'):
        return {'success': False, 'error': '無法獲取即時報價'}
    
    today_date = datetime.now().date()
    timestamp = int(datetime.combine(today_date, datetime.min.time()).timestamp())
    
    new_candle = {
        'time': timestamp,
        'open': quote['open'],
        'high': quote['high'],
        'low': quote['low'],
        'close': quote['price'],
        'volume': quote['volume']
    }
    
    candles = _read_kline_csv(csv_path) if os.path.exists(csv_path) else []
    
    if candles and candles[-1]['time'] == timestamp:
        candles[-1] = new_candle
    else:
        candles.append(new_candle)
    
    candles = _deduplicate_sort(candles)
    os.makedirs(csv_dir, exist_ok=True)
    _save_kline_csv(csv_path, candles)
    return {'success': True, 'candle': new_candle, 'total': len(candles), 'source': 'mis_api'}

# ============================================
# 6. 獲取漲跌家數（從 OpenAPI STOCK_DAY_ALL 計算）
# ============================================

def get_advance_decline():
    """
    從 STOCK_DAY_ALL 計算上漲/下跌/平盤家數
    返回: { advance, decline, unchanged, total }
    """
    data = _fetch_stock_day_all()
    if not data:
        return None
    
    advance = 0
    decline = 0
    unchanged = 0
    total_valid = 0
    
    for row in data:
        close = _safe_float(row.get('ClosingPrice'))
        open_p = _safe_float(row.get('OpeningPrice'))
        change_sign = row.get('ChangeSign', '')
        
        if close <= 0 or open_p <= 0:
            continue
        
        total_valid += 1
        
        # 用 ChangeSign 判斷（如果有的話）
        # 或者用收盤 vs 開盤
        # OpenAPI 的 Change 不一定存在，用 close vs open 比較可靠
        if close > open_p:
            advance += 1
        elif close < open_p:
            decline += 1
        else:
            unchanged += 1
    
    return {
        'advance': advance,
        'decline': decline,
        'unchanged': unchanged,
        'total': total_valid
    }

# ============================================
# 7. CLI 測試
# ============================================

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('用法:')
        print('  python3 market_data.py <ticker>          # 查詢歷史 K 線 (JSON)')
        print('  python3 market_data.py <ticker> update    # 更新當日 K 線')
        print('  python3 market_data.py batch              # 批量更新全部股票')
        print('  python3 market_data.py advance-decline    # 漲跌家數')
        sys.exit(1)
    
    cmd = sys.argv[1]
    
    if cmd == 'batch':
        result = batch_update_from_openapi()
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif cmd == 'advance-decline':
        result = get_advance_decline()
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif cmd == 'update' or (len(sys.argv) > 2 and sys.argv[2] == 'update'):
        ticker = cmd if cmd != 'update' else sys.argv[2]
        if ticker == 'update':
            ticker = sys.argv[1]
        result = update_daily_kline(ticker)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        ticker = cmd
        candles = get_historical_kline(ticker, days=60)
        print(json.dumps(candles, ensure_ascii=False))
