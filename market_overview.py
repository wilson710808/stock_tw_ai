#!/usr/bin/env python3
"""
market_overview.py - 台股大盤概覽（上漲/下跌家數、成交量）

功能：
1. 獲取市場大盤概覽（上漲/下跌/平盤家數）
2. 大盤指數（加權/電子/金融）
3. 成交金額（單位：億元）
4. 外資買賣超（未來擴充）

數據源：
- TWSE MIS API (即時)
- TWSE FMTQIK API (大盤統計)
"""

import json
import urllib.request
import ssl
from datetime import datetime

# ============================================
# 1. 市場大盤概覽
# ============================================

def get_market_overview():
    """
    獲取市場大盤概覽
    返回: {
      success: bool,
      timestamp: ISO,
      indices: { twii, electronic, financial },
      stocks: { advance, decline, unchanged, total },
      volume: { amount: 億元, unit: '億元' },
      note: string
    }
    """
    # 獲取三大指數
    indices = _get_indices()
    
    # 獲取上漲/下跌家數（模拟數據，實際需要 TWSE FMTQIK API）
    stocks = _get_advance_decline()
    
    # 獲取成交金額（模拟數據）
    volume = _get_market_volume()
    
    return {
        'success': True,
        'timestamp': datetime.now().isoformat(),
        'indices': indices,
        'stocks': stocks,
        'volume': volume,
        'note': '市場大盤概覽（部分數據為模擬）'
    }

def _get_indices():
    """獲取三大指數"""
    indices = {}
    
    # 加權指數
    url = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0'
    data = _fetch_twse_api(url)
    if data and data.get('msgArray'):
        msg = data['msgArray'][0]
        indices['twii'] = {
            'price': float(msg.get('z', 0)),
            'change': float(msg.get('a', 0)),
            'changePercent': float(msg.get('b', 0))
        }
    
    # 電子類指數
    url = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t13.tw&json=1&delay=0'
    data = _fetch_twse_api(url)
    if data and data.get('msgArray'):
        msg = data['msgArray'][0]
        indices['electronic'] = {
            'price': float(msg.get('z', 0)),
            'change': float(msg.get('a', 0)),
            'changePercent': float(msg.get('b', 0))
        }
    
    # 金融保險類指數
    url = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t17.tw&json=1&delay=0'
    data = _fetch_twse_api(url)
    if data and data.get('msgArray'):
        msg = data['msgArray'][0]
        indices['financial'] = {
            'price': float(msg.get('z', 0)),
            'change': float(msg.get('a', 0)),
            'changePercent': float(msg.get('b', 0))
        }
    
    return indices

def _get_advance_decline():
    """
    獲取上漲/下跌家數
    ⚠️ 注意：TWSE FMTQIK API 需要解析 HTML，目前使用模擬數據
    未來可改為真實數據
    """
    # 模擬數據（基於典型分布）
    import random
    total = 1740  # 上市 + 上櫃約 1740 家
    advance = random.randint(800, 1000)
    decline = random.randint(500, 700)
    unchanged = total - advance - decline
    
    return {
        'advance': advance,
        'decline': decline,
        'unchanged': unchanged,
        'total': total,
        'advancePercent': round(advance / total * 100, 1),
        'declinePercent': round(decline / total * 100, 1)
    }

def _get_market_volume():
    """
    獲取大盤成交金額
    ⚠️ 注意：需要從 TWSE API 獲取，目前使用模擬數據
    """
    # 模擬數據（台股日均成交約 3000-4000 億元）
    import random
    amount = random.randint(3000, 4500)
    
    return {
        'amount': amount,
        'unit': '億元'
    }

def _fetch_twse_api(url):
    """通用 TWSE API 請求"""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://mis.twse.com.tw/'
    })
    
    try:
        with urllib.request.urlopen(req, timeout=8, context=ctx) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f'[市場大盤] API 請求失敗: {e}')
        return None

# ============================================
# 2. CLI 測試
# ============================================

if __name__ == '__main__':
    import sys
    import json
    
    print('=== 台股大盤概覽 ===')
    overview = get_market_overview()
    print(json.dumps(overview, ensure_ascii=False, indent=2))
