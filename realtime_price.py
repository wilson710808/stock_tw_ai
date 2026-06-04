#!/usr/bin/env python3
"""
台股實時股價 - Yahoo Finance 主導 + Twelve Data 備用
支援：單股報價、批量報價、K線數據
台股 ticker 格式：2330.TW 或 ^TWII（指數）
"""
import sys
import json
import urllib.request
import urllib.error
import ssl
import re
import time
from datetime import datetime, timedelta as _timedelta

# 全局 SSL context（跳過證書驗證，適用於伺服器環境）
_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE

_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

# ============================================
# Yahoo Finance（主力，免費無需 API Key）
# ============================================

def _yahoo_chart(ticker, range='2d', interval='1d'):
    """Yahoo Finance chart API - 核心數據源"""
    # 台股 ticker 格式轉換：2330 -> 2330.TW
    if ticker and not ticker.startswith('^') and '.' not in ticker and ticker.isdigit():
        ticker = f"{ticker}.TW"
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range={range}&interval={interval}'
    req = urllib.request.Request(url, headers={'User-Agent': _UA})
    with urllib.request.urlopen(req, timeout=10, context=_ssl_ctx) as response:
        return json.loads(response.read().decode())

def get_quote_yahoo(ticker):
    """Yahoo Finance 完整報價（含正確的漲跌幅）"""
    try:
        data = _yahoo_chart(ticker, range='2d', interval='1d')
        result = data.get('chart', {}).get('result', [{}])[0]
        meta = result.get('meta', {})
        price = meta.get('regularMarketPrice', 0)
        prev = meta.get('chartPreviousClose', 0)  # 前一交易日收盤價
        change = round(price - prev, 2) if prev else 0
        change_pct = round(change / prev * 100, 2) if prev else 0

        return {
            'success': True,
            'ticker': ticker,
            'name': meta.get('longName', meta.get('shortName', ticker)),
            'price': round(price, 2),
            'change': change,
            'changePercent': change_pct,
            'prevClose': round(prev, 2),
            'open': round(meta.get('regularMarketDayHigh', 0) or 0, 2),  # Yahoo v8 chart 沒有直接 open
            'high': round(meta.get('regularMarketDayHigh', 0), 2),
            'low': round(meta.get('regularMarketDayLow', 0), 2),
            'volume': meta.get('regularMarketVolume', 0),
            'fiftyTwoWeekHigh': round(meta.get('fiftyTwoWeekHigh', 0), 2),
            'fiftyTwoWeekLow': round(meta.get('fiftyTwoWeekLow', 0), 2),
            'timestamp': int(datetime.now().timestamp() * 1000),
            'source': 'yahoo',
            'note': 'Yahoo Finance 實時數據'
        }
    except urllib.error.HTTPError as e:
        if e.code == 429:
            return {'error': 'Yahoo: 速率限制 (429)，請稍後再試'}
        return {'error': f'Yahoo HTTP {e.code}'}
    except Exception as e:
        return {'error': f'Yahoo error: {str(e)}'}


def get_quotes_yahoo_batch(tickers):
    """批量報價 - 逐個查詢 Yahoo（帶 0.5s 間隔避免 429）"""
    results = []
    for i, t in enumerate(tickers):
        t = t.upper().strip()
        if i > 0:
            time.sleep(1.5)  # Yahoo 429 閾值約 1req/s，保守 1.5s
        quote = get_quote_yahoo(t)
        if quote.get('success'):
            results.append(quote)
        else:
            results.append({
                'success': False,
                'ticker': t,
                'error': quote.get('error', '查詢失敗')
            })
    return results


def get_kline_yahoo(ticker, days=90):
    """Yahoo Finance K線數據"""
    try:
        data = _yahoo_chart(ticker, range=f'{days}d', interval='1d')
        result = data.get('chart', {}).get('result', [{}])[0]
        ts = result.get('timestamp', [])
        q = result.get('indicators', {'quote': [{}]}).get('quote', [{}])[0]
        candles = []
        for i in range(len(ts)):
            if q.get('open', [None])[i] is not None:
                candles.append({
                    'time': ts[i],
                    'open': round(q['open'][i], 2),
                    'high': round(q['high'][i], 2),
                    'low': round(q['low'][i], 2),
                    'close': round(q['close'][i], 2),
                    'volume': q.get('volume', [0])[i] or 0
                })
        return {
            'success': True,
            'ticker': ticker,
            'candles': candles,
            'source': 'yahoo',
            'note': f'Yahoo Finance K線 ({len(candles)} 天)'
        }
    except urllib.error.HTTPError as e:
        if e.code == 429:
            return {'success': False, 'error': 'Yahoo K線: 速率限制 (429)'}
        return {'success': False, 'error': f'Yahoo K線 HTTP {e.code}'}
    except Exception as e:
        return {'success': False, 'error': f'Yahoo K線錯誤: {str(e)}'}


# ============================================
# Stooq.com（免費 CSV 報價，無需 API Key）
# ============================================
# 常見股票名稱映射（Stooq 不返回公司名稱，用此表補全）
_TICKER_NAMES = {
    # 科技
    "AAPL": "Apple Inc.", "NVDA": "NVIDIA Corporation", "MSFT": "Microsoft Corporation",
    "GOOGL": "Alphabet Inc.", "GOOG": "Alphabet Inc. (Class C)", "AMZN": "Amazon.com Inc.",
    "META": "Meta Platforms Inc.", "TSLA": "Tesla Inc.", "AMD": "Advanced Micro Devices",
    "INTC": "Intel Corporation", "CRM": "Salesforce Inc.", "ADBE": "Adobe Inc.",
    "NFLX": "Netflix Inc.", "PYPL": "PayPal Holdings", "AVGO": "Broadcom Inc.",
    "ORCL": "Oracle Corporation", "IBM": "IBM Corporation", "CSCO": "Cisco Systems",
    "QCOM": "QUALCOMM Inc.", "TXN": "Texas Instruments", "NOW": "ServiceNow Inc.",
    "SNOW": "Snowflake Inc.", "PLTR": "Palantir Technologies",
    # 消費
    "WMT": "Walmart Inc.", "COST": "Costco Wholesale", "HD": "The Home Depot",
    "NKE": "Nike Inc.", "MCD": "McDonald's Corporation", "SBUX": "Starbucks Corporation",
    "TGT": "Target Corporation", "LOW": "Lowe's Companies", "DIS": "The Walt Disney Company",
    "GM": "General Motors Company", "F": "Ford Motor Company",
    # 金融
    "JPM": "JPMorgan Chase & Co.", "V": "Visa Inc.", "MA": "Mastercard Inc.",
    "BRK.B": "Berkshire Hathaway", "GS": "Goldman Sachs", "MS": "Morgan Stanley",
    "BAC": "Bank of America", "WFC": "Wells Fargo", "AXP": "American Express",
    "BLK": "BlackRock Inc.", "C": "Citigroup Inc.",
    # 醫療
    "UNH": "UnitedHealth Group", "JNJ": "Johnson & Johnson", "LLY": "Eli Lilly and Company",
    "PFE": "Pfizer Inc.", "ABBV": "AbbVie Inc.", "MRK": "Merck & Co.",
    "TMO": "Thermo Fisher Scientific", "ABT": "Abbott Laboratories", "AMGN": "Amgen Inc.",
    # 能源
    "XOM": "Exxon Mobil Corporation", "CVX": "Chevron Corporation",
    "COP": "ConocoPhillips", "SLB": "Schlumberger Limited",
    # 工業
    "CAT": "Caterpillar Inc.", "BA": "Boeing Company", "HON": "Honeywell International",
    "GE": "General Electric", "UPS": "United Parcel Service", "MMM": "3M Company",
    "RTX": "RTX Corporation", "LMT": "Lockheed Martin",
    # 材料/地產/公用
    "LIN": "Linde plc", "APD": "Air Products & Chemicals", "SHW": "Sherwin-Williams",
    "PLD": "Prologis Inc.", "AMT": "American Tower", "EQIX": "Equinix Inc.",
    "NEE": "NextEra Energy", "DUK": "Duke Energy", "SO": "Southern Company",
    # 指數 ETF
    "SPY": "SPDR S&P 500 ETF", "QQQ": "Invesco QQQ Trust", "DIA": "SPDR Dow Jones ETF",
    "VTI": "Vanguard Total Stock Market ETF", "IWM": "iShares Russell 2000 ETF",
    "VIX": "CBOE Volatility Index",
    # 其他知名股票
    "ARM": "ARM Holdings plc", "CI": "Cigna Group", "EPAM": "EPAM Systems",
    "GPRO": "GoPro Inc.", "SNAP": "Snap Inc.", "UBER": "Uber Technologies",
    "COIN": "Coinbase Global", "RIVN": "Rivian Automotive",
}

def get_quote_stooq(ticker):
    """Stooq.com CSV 報價 — 最可靠的免費數據源"""
    try:
        url = f'https://stooq.com/q/l/?s={ticker.lower()}.us&f=sd2t2ohlcvp&h&e=csv'
        req = urllib.request.Request(url, headers={'User-Agent': _UA})
        with urllib.request.urlopen(req, timeout=10, context=_ssl_ctx) as response:
            data = response.read().decode('utf-8').strip()
            lines = data.split('\n')
            if len(lines) < 2:
                return {'error': 'Stooq: CSV 格式異常'}
            parts = lines[1].split(',')
            # parts: Symbol,Date,Time,Open,High,Low,Close,Volume,PrevClose
            if len(parts) < 9:
                return {'error': 'Stooq: 數據不完整'}
            date_s, time_s, open_s, high_s, low_s, close_s, vol_s, prev_s = parts[1], parts[2], parts[3], parts[4], parts[5], parts[6], parts[7], parts[8]
            price = float(close_s)
            prev_close = float(prev_s)
            change = round(price - prev_close, 2)
            change_pct = round(change / prev_close * 100, 2) if prev_close else 0
            return {
                'success': True,
                'ticker': ticker,
                'name': _TICKER_NAMES.get(ticker, ticker),
                'price': round(price, 2),
                'change': change,
                'changePercent': change_pct,
                'prevClose': round(prev_close, 2),
                'open': round(float(open_s), 2),
                'high': round(float(high_s), 2),
                'low': round(float(low_s), 2),
                'volume': int(vol_s),
                'timestamp': int(datetime.now().timestamp() * 1000),
                'source': 'stooq',
                'note': 'Stooq 實時數據'
            }
    except Exception as e:
        return {'error': f'Stooq error: {str(e)}'}

# ============================================
# Twelve Data（備用，需 API Key）
# ============================================

def get_quote_twelvedata(ticker, apikey='demo'):
    """Twelve Data 完整報價（備用）"""
    try:
        url = f"https://api.twelvedata.com/quote?symbol={ticker}&apikey={apikey}"
        req = urllib.request.Request(url, headers={'User-Agent': _UA})
        with urllib.request.urlopen(req, timeout=10, context=_ssl_ctx) as response:
            data = json.loads(response.read().decode())
        if 'status' in data and data['status'] == 'error':
            return {'error': f"Twelve Data: {data.get('message', 'Unknown error')}"}
        close = float(data.get('close', 0))
        prev = float(data.get('previous_close', close))
        change = round(close - prev, 2) if prev else 0
        change_pct = round(change / prev * 100, 2) if prev else 0
        return {
            'success': True,
            'ticker': ticker,
            'name': data.get('name', ticker),
            'price': close,
            'change': change,
            'changePercent': change_pct,
            'prevClose': prev,
            'open': float(data.get('open', 0)),
            'high': float(data.get('high', 0)),
            'low': float(data.get('low', 0)),
            'volume': int(data.get('volume', 0)),
            'fiftyTwoWeekHigh': float(data.get('fifty_two_week', {}).get('high', 0)),
            'fiftyTwoWeekLow': float(data.get('fifty_two_week', {}).get('low', 0)),
            'timestamp': int(datetime.now().timestamp() * 1000),
            'source': 'twelvedata',
            'note': 'Twelve Data 實時數據'
        }
    except Exception as e:
        return {'error': f'Twelve Data error: {str(e)}'}


def get_kline_twelvedata(ticker, days=90, apikey='demo'):
    """Twelve Data K線（備用）"""
    try:
        url = f"https://api.twelvedata.com/time_series?symbol={ticker}&interval=1day&outputsize={days}&format=JSON&apikey={apikey}"
        req = urllib.request.Request(url, headers={'User-Agent': _UA})
        with urllib.request.urlopen(req, timeout=15, context=_ssl_ctx) as response:
            data = json.loads(response.read().decode())
        if 'status' in data and data['status'] == 'error':
            return {'success': False, 'error': f"Twelve Data K線: {data.get('message', 'Unknown')}"}
        values = data.get('values', [])
        candles = []
        for v in reversed(values):
            dt = datetime.strptime(v['datetime'], '%Y-%m-%d')
            ts = int(dt.timestamp())
            candles.append({
                'time': ts,
                'open': float(v['open']),
                'high': float(v['high']),
                'low': float(v['low']),
                'close': float(v['close']),
                'volume': int(v['volume']) if 'volume' in v else 0
            })
        return {
            'success': True,
            'ticker': ticker,
            'candles': candles,
            'source': 'twelvedata',
            'note': f'Twelve Data K線 ({len(candles)} 天)'
        }
    except Exception as e:
        return {'success': False, 'error': f'Twelve Data K線錯誤: {str(e)}'}


# ============================================
# EODHD（免費無需 API Key，demo 即可取 K 線）
# ============================================
import os as _os
import tempfile as _tempfile

# 磁盤緩存目錄（修復：使用項目本地目錄而非系統 temp）
# 系統 temp 目錄在重啟後會被清空，改為項目本地緩存
_CACHE_DIR = _os.path.join(_os.path.dirname(__file__), '.kline_cache')
try:
    _os.makedirs(_CACHE_DIR, exist_ok=True)
except Exception:
    # fallback 到系統 temp
    _CACHE_DIR = _os.path.join(_tempfile.gettempdir(), 'stockai_kline_cache')
    _os.makedirs(_CACHE_DIR, exist_ok=True)

def _cache_path(ticker, days):
    return _os.path.join(_CACHE_DIR, f'{ticker}_{days}d.json')

def _read_cache(ticker, days, max_age_seconds=300):
    cp = _cache_path(ticker, days)
    if _os.path.exists(cp):
        age = time.time() - _os.path.getmtime(cp)
        if age < max_age_seconds:
            try:
                with open(cp, 'r') as f:
                    return json.load(f)
            except:
                pass
    return None

def _write_cache(ticker, days, data):
    cp = _cache_path(ticker, days)
    try:
        with open(cp, 'w') as f:
            json.dump(data, f)
    except:
        pass

def get_kline_eodhd(ticker, days=90):
    """EODHD K線數據（免費無需 API Key，demo key 即可）
    緩存 30 分鐘避免重複請求"""
    cached = _read_cache(ticker, days, max_age_seconds=1800)
    if cached:
        cached['cached'] = True
        return cached

    try:
        end_date = datetime.now().strftime('%Y-%m-%d')
        start_date = (datetime.now() - _timedelta(days=days + 10)).strftime('%Y-%m-%d')
        url = f'https://eodhd.com/api/eod/{ticker}.US?from={start_date}&to={end_date}&period=d&api_token=demo&fmt=json'
        req = urllib.request.Request(url, headers={'User-Agent': _UA})
        with urllib.request.urlopen(req, timeout=15, context=_ssl_ctx) as response:
            data = json.loads(response.read().decode())

        if not data or not isinstance(data, list):
            return {'success': False, 'error': 'EODHD: 無數據返回'}

        candles = []
        for row in data:
            dt = datetime.strptime(row['date'], '%Y-%m-%d')
            ts = int(dt.timestamp())
            candles.append({
                'time': ts,
                'open': round(row['open'], 2),
                'high': round(row['high'], 2),
                'low': round(row['low'], 2),
                'close': round(row['close'], 2),
                'volume': int(row.get('volume', 0) or 0)
            })

        result = {
            'success': True,
            'ticker': ticker,
            'candles': candles,
            'source': 'eodhd',
            'note': f'EODHD K線 ({len(candles)} 天，免費無需 API Key)'
        }

        _write_cache(ticker, days, result)
        return result

    except Exception as e:
        return {'success': False, 'error': f'EODHD K線錯誤: {str(e)}'}

# ============================================
# 備用模擬數據（最後防線）
# ============================================

def get_simulated_data(ticker):
    """使用統一中央價格庫（stock_prices.json），確保所有價格一致且正確

    修復：當所有 API 均不可用時，使用 stock_prices.json 中的固定價格，
    避免 random 導致每次請求結果不同（價格漂移問題）
    """
    import os
    ticker = ticker.upper()
    ticker = ticker.replace('.', '-')  # 統一格式（BRK.B → BRK-B）

    # 優先從 stock_prices.json 讀取（中央價格庫）
    price_file = os.path.join(os.path.dirname(__file__), 'stock_prices.json')
    try:
        with open(price_file, 'r', encoding='utf-8') as f:
            PRICE_DB = json.load(f)
    except:
        PRICE_DB = {}

    # 嘗試精確匹配
    if ticker in PRICE_DB:
        data = PRICE_DB[ticker]
        return _build_quote_response(ticker, data)

    # 嘗試備用格式
    alt_ticker = ticker.replace('-', '.')
    if alt_ticker in PRICE_DB:
        data = PRICE_DB[alt_ticker]
        return _build_quote_response(ticker, data)

    # 未知股票：返回一個基於股票代碼哈希的固定值，避免每次 random 不同
    # 修復：使用股票代碼的字元哈希作為 seed，避免每次調用 random 值不同
    ticker_hash = hash(ticker) % 1000  # 0-999 的固定哈希
    base_price = 50.0 + (ticker_hash / 1000.0) * 300.0  # 50-350 範圍內的固定值
    return {
        'success': True,
        'ticker': ticker,
        'name': _TICKER_NAMES.get(ticker, ticker),
        'price': round(base_price, 2),
        'change': 0.0,
        'changePercent': 0.0,
        'prevClose': round(base_price, 2),
        'open': round(base_price, 2),
        'high': round(base_price * 1.02, 2),
        'low': round(base_price * 0.98, 2),
        'volume': 5000000 + ticker_hash * 10000,
        'timestamp': int(datetime.now().timestamp() * 1000),
        'source': 'simulated_fallback',
        'note': f'⚠️ API 均不可用，使用哈希固定值（${base_price:.2f}）'
    }


def _build_quote_response(ticker, data):
    """統一構造報價回應格式"""
    price = data.get('price', 0)
    return {
        'success': True,
        'ticker': ticker,
        'name': data.get('name', ticker),
        'price': data.get('price', 0),
        'change': data.get('change', 0),
        'changePercent': data.get('changePercent', 0),
        'prevClose': data.get('prevClose', data.get('price', 0)),
        'open': data.get('open', data.get('price', 0)),
        'high': data.get('high', data.get('price', 0)),
        'low': data.get('low', data.get('price', 0)),
        'volume': data.get('volume', 0),
        'timestamp': int(datetime.now().timestamp() * 1000),
        'source': 'central_db',
        'note': '從 stock_prices.json 中央價格庫讀取'
    }


# ============================================
# CLI 入口
# ============================================

def _quote_from_eodhd_kline(ticker):
    """從 EODHD 日線取最新兩根 close → price/prevClose 同源同語意，避免跨源計算偏差。"""
    try:
        kline = get_kline_eodhd(ticker, 30)
        if not (kline.get('success') and kline.get('candles') and len(kline['candles']) >= 2):
            return None
        last_candle = kline['candles'][-1]
        prev_candle = kline['candles'][-2]
        price = float(last_candle['close'])
        prev_close = float(prev_candle['close'])
        if prev_close <= 0:
            return None
        change = round(price - prev_close, 2)
        change_percent = round((price - prev_close) / prev_close * 100, 2)
        name = _TICKER_NAMES.get(ticker.upper(), ticker.upper())
        return {
            'success': True,
            'ticker': ticker.upper(),
            'name': name,
            'price': round(price, 2),
            'change': change,
            'changePercent': change_percent,
            'prevClose': round(prev_close, 2),
            'open': round(float(last_candle.get('open', price)), 2),
            'high': round(float(last_candle.get('high', price)), 2),
            'low': round(float(last_candle.get('low', price)), 2),
            'volume': int(last_candle.get('volume', 0) or 0),
            'timestamp': int(datetime.now().timestamp() * 1000),
            'source': 'eodhd_kline',
            'note': 'EODHD 日線（price=最新交易日收盤、prevClose=前一交易日收盤，同源計算當日漲幅）'
        }
    except Exception:
        return None


def _validate_quote_pair(q):
    """檢查 quote 的 price/prevClose 是否語意一致；不一致直接丟棄改用下一個資料源。

    判定不可信的情況：
    - prevClose 缺失、<=0 或等於 price（fallback 模擬常見）
    - |changePercent| > 50%（極端值，多半是跨日對位錯了）
    """
    if not isinstance(q, dict) or not q.get('success'):
        return False
    try:
        price = float(q.get('price') or 0)
        prev = float(q.get('prevClose') or 0)
    except Exception:
        return False
    if price <= 0 or prev <= 0:
        return False
    if abs(price - prev) < 1e-6:
        return False
    pct = abs((price - prev) / prev * 100)
    if pct > 50:
        return False
    return True


def _attach_prev_close_from_kline(q, ticker):
    """當盤中現價可信但 prevClose 不可信時，用 EODHD 日線倒數第二根 close 補正。

    這對 Yahoo regularMarketPrice + chartPreviousClose 在跨夜/盤前盤後時的偏差特別有效。
    """
    try:
        kline = get_kline_eodhd(ticker, 10)
        if not (kline.get('success') and kline.get('candles') and len(kline['candles']) >= 2):
            return q
        candles = kline['candles']
        last_close = float(candles[-1]['close'])
        prev_close = float(candles[-2]['close'])
        price = float(q.get('price') or 0)
        # 啟發式：若現價已是「今天」（與 EODHD 最後一根日線差異 > 0.5%），則用「最後一根」當 prevClose；否則用「倒數第二根」。
        # 這樣不論盤中或收盤都能對齊。
        if price > 0 and last_close > 0 and abs(price - last_close) / last_close > 0.005:
            new_prev = last_close
        else:
            new_prev = prev_close
        if new_prev > 0 and abs(new_prev - price) > 1e-6:
            q['prevClose'] = round(new_prev, 2)
            q['change'] = round(price - new_prev, 2)
            q['changePercent'] = round((price - new_prev) / new_prev * 100, 2)
            q['note'] = (q.get('note', '') + ' + EODHD prevClose 校正').strip()
    except Exception:
        pass
    return q


def get_quote(ticker):
    """主流程：以「現價與前一交易日收盤同源、可驗證」為核心，避免跨源 prevClose 對位偏差。

    1) Yahoo Finance（盤中現價最即時）→ 若 prevClose 不一致就用 EODHD 日線補正。
    2) EODHD K 線（最穩定，price/prevClose 必同源）。
    3) Stooq EOD（兩個 close 同源）。
    4) TwelveData（previous_close 與 close 同源）。
    5) 模擬資料（最後防線）。
    """
    # Step 1: Yahoo（即時現價優先，prevClose 由 EODHD 校正）
    y = get_quote_yahoo(ticker)
    if y.get('success') and float(y.get('price') or 0) > 0:
        if not _validate_quote_pair(y):
            y = _attach_prev_close_from_kline(y, ticker)
        if _validate_quote_pair(y):
            return y

    # Step 2: EODHD K 線推算（price/prevClose 必同源、穩定）
    eod = _quote_from_eodhd_kline(ticker)
    if _validate_quote_pair(eod):
        return eod

    # Step 3: Stooq EOD
    stooq = get_quote_stooq(ticker)
    if _validate_quote_pair(stooq):
        return stooq

    # Step 4: TwelveData
    td = get_quote_twelvedata(ticker)
    if _validate_quote_pair(td):
        return td

    # Step 5: 若 Yahoo 拿到價格但 prevClose 始終缺，至少回 Yahoo 的數據（changePercent 可能為 0）
    if y.get('success') and float(y.get('price') or 0) > 0:
        return y

    # Step 6: 最後防線 - 模擬數據
    return get_simulated_data(ticker)


def get_kline(ticker, days=90):
    """主流程：EODHD（免費穩定）→ Yahoo → Twelve Data → 模擬 K 線，最後一根蠟燭與實時價格一致"""
    # Step 1: EODHD（免費無需 API Key，帶 5 分鐘緩存，最穩定）
    result = get_kline_eodhd(ticker, days)
    if result.get('success'):
        # 嘗試獲取最新實時價格，更新最後一根蠟燭
        try:
            q = get_quote(ticker)
            if q.get('success') and len(result['candles']) >= 1:
                last_candle = result['candles'][-1]
                real_price = float(q.get('price'))
                # 更新最後一根蠟燭的 close 為實時價格，high/low 也調整包含這個價格
                last_candle['close'] = round(real_price, 2)
                last_candle['high'] = round(max(last_candle['high'], real_price), 2)
                last_candle['low'] = round(min(last_candle['low'], real_price), 2)
                # 更新 note 說明
                result['note'] = 'EODHD K線 + 實時價格補償（最後一根蠟燭與當前價格一致）'
        except:
            pass
        return result

    # Step 2: Yahoo Finance（可能被 429 限制）
    result = get_kline_yahoo(ticker, days)
    if result.get('success'):
        # 同步更新最後一根蠟燭
        try:
            q = get_quote(ticker)
            if q.get('success') and len(result['candles']) >= 1:
                last_candle = result['candles'][-1]
                real_price = float(q.get('price'))
                last_candle['close'] = round(real_price, 2)
                last_candle['high'] = round(max(last_candle['high'], real_price), 2)
                last_candle['low'] = round(min(last_candle['low'], real_price), 2)
        except:
            pass
        return result

    # Step 3: Twelve Data（demo key 有限制）
    result = get_kline_twelvedata(ticker, days)
    if result.get('success'):
        # 同步更新最後一根蠟燭
        try:
            q = get_quote(ticker)
            if q.get('success') and len(result['candles']) >= 1:
                last_candle = result['candles'][-1]
                real_price = float(q.get('price'))
                last_candle['close'] = round(real_price, 2)
                last_candle['high'] = round(max(last_candle['high'], real_price), 2)
                last_candle['low'] = round(min(last_candle['low'], real_price), 2)
        except:
            pass
        return result

    # Step 4: 生成模擬 K 線（最後防線），基於當前真實價格
    return _get_simulated_kline(ticker, days)


def _get_simulated_kline(ticker, days=90):
    """模擬 K 線數據（最後防線），基於當前真實價格生成，讓 K 線與當前價格匹配"""
    import random

    # 首先嘗試獲取當前真實價格作為基準
    base_price = 150.0
    try:
        q = get_quote(ticker)
        if q.get('success'):
            base_price = float(q.get('price', base_price))
    except:
        pass

    candles = []
    price = base_price
    now = datetime.now()
    for i in range(days):
        dt = now - _timedelta(days=days - i)
        if dt.weekday() >= 5:
            continue
        ts = int(dt.timestamp())
        change_pct = random.uniform(-0.03, 0.03)
        open_p = price
        close_p = round(price * (1 + change_pct), 2)
        high_p = round(max(open_p, close_p) * (1 + random.uniform(0, 0.015)), 2)
        low_p = round(min(open_p, close_p) * (1 - random.uniform(0, 0.015)), 2)
        candles.append({
            'time': ts,
            'open': round(open_p, 2),
            'high': high_p,
            'low': low_p,
            'close': close_p,
            'volume': random.randint(10000000, 80000000)
        })
        price = close_p

    # 確保最後一根 K 線的收盤價與當前真實價格一致
    if candles:
        candles[-1]['close'] = round(base_price, 2)
        candles[-1]['high'] = max(candles[-1]['high'], candles[-1]['close'])
        candles[-1]['low'] = min(candles[-1]['low'], candles[-1]['close'])

    return {
        'success': True,
        'ticker': ticker,
        'candles': candles,
        'source': 'simulated',
        'note': f'⚠️ 模擬 K 線 ({len(candles)} 天，基於當前價格)'
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': '用法: realtime_price.py TICKER [--kline] [--batch TICKER1,TICKER2,...]'}))
        sys.exit(1)

    ticker = sys.argv[1].upper()

    if '--kline' in sys.argv:
        days = 90
        for i, arg in enumerate(sys.argv):
            if arg == '--days' and i + 1 < len(sys.argv):
                days = int(sys.argv[i + 1])
        print(json.dumps(get_kline(ticker, days)))
    elif '--batch' in sys.argv:
        # 批量模式: --batch AAPL,MSFT,GOOGL
        for i, arg in enumerate(sys.argv):
            if arg == '--batch' and i + 1 < len(sys.argv):
                tickers = [t.strip() for t in sys.argv[i + 1].split(',') if t.strip()]
                # 使用 get_quote 逐個查詢（含 Stooq 備用）
                results = []
                for t in tickers:
                    results.append(get_quote(t))
                    time.sleep(0.3)  # 避免速率限制
                print(json.dumps({'success': True, 'quotes': results}))
                break
    else:
        print(json.dumps(get_quote(ticker)))
