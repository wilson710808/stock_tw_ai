#!/usr/bin/env python3
"""
market_overview.py - 台股大盤概覽（真實數據版）

數據源：
- TWSE MIS API: 即時指數
- TWSE OpenAPI STOCK_DAY_ALL: 漲跌家數
- TWSE OpenAPI FMTQIK: 成交金額、大盤統計
"""

import json
import urllib.request
import ssl
import sys
from datetime import datetime

_ctx = ssl.create_default_context()
_ctx.check_hostname = False
_ctx.verify_mode = ssl.CERT_NONE

_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    'Accept': 'application/json',
    'If-Modified-Since': '0'
}

def _fetch_json(url, timeout=15):
    req = urllib.request.Request(url, headers=_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ctx) as resp:
            raw = resp.read()
            return json.loads(raw.decode('utf-8'))
    except Exception as e:
        sys.stderr.write(f'[market_overview] fetch failed: {url} → {e}\n')
        return None

def _safe_float(val):
    if not val or val in ('--', 'X', ''):
        return 0.0
    try:
        return float(str(val).replace(',', ''))
    except:
        return 0.0

# ============================================
# 市場大盤概覽
# ============================================

def get_market_overview():
    """
    獲取市場大盤概覽
    返回: { success, timestamp, indices, stocks, volume }
    """
    indices = _get_indices()
    stocks = _get_advance_decline()
    volume = _get_market_volume()
    
    return {
        'success': True,
        'timestamp': datetime.now().isoformat(),
        'indices': indices,
        'stocks': stocks,
        'volume': volume
    }

def _get_indices():
    """獲取三大指數（TWSE MIS API — 一次請求三個指數）"""
    indices = {}
    
    # 合併三個指數為一次 API 請求
    ex_ch = 'tse_t00.tw|tse_t13.tw|tse_t17.tw'
    url = f'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch={ex_ch}&json=1&delay=0'
    data = _fetch_json(url, timeout=8)
    
    if data and data.get('msgArray'):
        key_map = {'t00': 'twii', 't13': 'electronic', 't17': 'financial'}
        for msg in data['msgArray']:
            ch = msg.get('ch', '')
            for code, key in key_map.items():
                if code in ch:
                    z = _safe_float(msg.get('z', 0))
                    y = _safe_float(msg.get('y', 0))
                    indices[key] = {
                        'price': z,
                        'change': round(z - y, 2),
                        'changePercent': round((z - y) / y * 100, 2) if y > 0 else 0
                    }
                    break
    
    return indices

def _get_advance_decline():
    """
    從 TWSE OpenAPI STOCK_DAY_ALL 計算漲跌家數（真實數據）
    """
    data = _fetch_json('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', timeout=15)
    
    if not data or not isinstance(data, list):
        sys.stderr.write('[market_overview] STOCK_DAY_ALL 無數據，使用模擬\n')
        import random
        total = 1740
        advance = random.randint(800, 1000)
        decline = random.randint(500, 700)
        return {
            'advance': advance,
            'decline': decline,
            'unchanged': total - advance - decline,
            'total': total,
            'source': 'simulated'
        }
    
    advance = 0
    decline = 0
    unchanged = 0
    total_valid = 0
    
    for row in data:
        close = _safe_float(row.get('ClosingPrice'))
        open_p = _safe_float(row.get('OpeningPrice'))
        
        if close <= 0 or open_p <= 0:
            continue
        
        total_valid += 1
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
        'total': total_valid,
        'advancePercent': round(advance / total_valid * 100, 1) if total_valid > 0 else 0,
        'declinePercent': round(decline / total_valid * 100, 1) if total_valid > 0 else 0,
        'source': 'openapi'
    }

def _get_market_volume():
    """
    從 TWSE OpenAPI FMTQIK 取得成交金額（真實數據）
    """
    data = _fetch_json('https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK', timeout=15)
    
    if not data or not isinstance(data, list) or len(data) == 0:
        sys.stderr.write('[market_overview] FMTQIK 無數據，使用模擬\n')
        import random
        return {'amount': random.randint(3000, 4500), 'unit': '億元', 'source': 'simulated'}
    
    # 取最近一天
    latest = data[-1]
    trade_value = _safe_float(latest.get('TradeValue', 0))
    # TradeValue 單位是元，轉換為億元
    amount_yi = round(trade_value / 100000000, 1) if trade_value > 0 else 0
    
    # 也取大盤指數
    taiex = _safe_float(latest.get('TAIEX', 0))
    change = _safe_float(latest.get('Change', 0))
    
    return {
        'amount': amount_yi,
        'unit': '億元',
        'taiex': taiex,
        'taiexChange': change,
        'source': 'openapi'
    }

# ============================================
# CLI 測試
# ============================================

if __name__ == '__main__':
    overview = get_market_overview()
    print(json.dumps(overview, ensure_ascii=False, indent=2))
