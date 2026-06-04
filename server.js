/**
 * 台股 AI 投顧助手 - 後端服務
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const CORS_ORIGINS = process.env.CORS_ORIGINS || '';
const path = require('path');
const { spawn } = require('child_process');
const { db, stmts } = require('./db');
const { hashPassword, verifyPassword, signJWT, verifyJWT, authMiddleware, JWT_EXPIRY, checkRateLimit } = require('./auth');

// 行業分類映射（台股）
const SECTOR_MAP = {
  // 半導體
  '2330':'半導體','2317':'半導體','2454':'半導體','2303':'半導體','2881':'半導體',
  '3711':'半導體','3034':'半導體','2379':'半導體','6669':'半導體','8046':'半導體',
  // 電子零組件
  '2395':'電子零組件','2498':'電子零組件','2409':'電子零組件','2412':'電子零組件',
  // 電腦及週邊
  '2357':'電腦週邊','2308':'電腦週邊','2382':'電腦週邊','3231':'電腦週邊',
  // 通信網路
  '2412':'通信網路','4904':'通信網路','3045':'通信網路','3694':'通信網路',
  // 軟體服務
  '2498':'軟體服務','4994':'軟體服務','3130':'軟體服務','6213':'軟體服務',
  // 金融
  '2881':'金融','2882':'金融','2884':'金融','2885':'金融','2886':'金融','2891':'金融',
  '2892':'金融','5876':'金融','2883':'金融','2890':'金融',
  // 傳產
  '1301':'傳產','1303':'傳產','1326':'傳產','1216':'傳產','1201':'傳產',
  '1802':'傳產','9910':'傳產','2207':'傳產','2610':'傳產',
  // 光電
  '3481':'光電','2409':'光電','3037':'光電','3450':'光電',
  // 其他
  '9917':'其他','8932':'其他',
};

function getSector(ticker) {
  return SECTOR_MAP[(ticker || '').toUpperCase()] || '其他';
}

const DEFAULT_SECTORS = ['半導體','電子零組件','電腦週邊','通信網路','軟體服務','金融','傳產','光電','其他'];

const app = express();
const PORT = process.env.PORT || 3007;

// AI Gateway 整合 — 所有 AI 請求透過 Gateway 轉發
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:3005';
const GATEWAY_API_PATH = process.env.GATEWAY_API_PATH || '/api/query';
const APP_ID = process.env.APP_ID || 'stock-tw-ai';

// 添加 `/api/moat/:ticker` 端點定義
app.get('/api/moat/:ticker', async (req, res) => {
  const ticker = req.params.ticker?.toUpperCase();
  if (!ticker) return res.status(400).json({ error: '請提供股票代碼' });
  try {
    const result = await new Promise((resolve) => {
      // 傳入 `--moat` 參數調用護城河分析
      const python = spawn('python3', [path.join(__dirname, 'financial_data.py'), ticker, '--moat']);
      let data = '';
      python.stdout.on('data', (chunk) => {
        data += chunk;
      });
      python.stderr.on('data', (chunk) => {
        console.error('護城河數據錯誤:', chunk.toString());
      });
      python.on('close', (code) => {
        if (code === 0 && data) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            console.error('護城河數據解析失敗:', e.message);
            resolve({ success: false, error: '解析失敗', raw: data });
          }
        } else {
          console.error('護城河數據查詢失敗，退出碼:', code);
          resolve({
            success: false,
            error: '護城河數據查詢失敗',
            moat: {
              brand: '✅',
              cost: '⚠️ 需進一步分析成本結構',
              network: '⚠️ 視具體業務模式而定',
              switching: '⚠️ 客戶黏著度待評估'
            }
          });
        }
      });
    });
    
    // 回退模擬數據
    if (!result.success) {
      result.moat = {
        brand: '✅',
        cost: '⚠️ 需進一步分析成本結構',
        network: '⚠️ 視具體業務模式而定',
        switching: '⚠️ 客戶黏著度待評估'
      };
      result.note = '護城河數據為模擬值';
    }
    res.json(result);
  } catch (e) {
    console.error('護城河API錯誤:', e.message);
    res.status(500).json({
      error: '護城河API錯誤',
      moat: {
        brand: '✅',
        cost: '⚠️',
        network: '⚠️',
        switching: '⚠️'
      }
    });
  }
});

/**
 * 透過 AI Gateway 發送 AI 請求
 * Gateway 負責 API Key 池化、速率限制、負載均衡
 */
async function gatewayChat(messages, userId = 'Wilson', retries = 1) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const queryData = lastUserMsg ? lastUserMsg.content : '';
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.log(`[Gateway] 重試 ${attempt}/${retries}，等待 1 秒...`);
      await new Promise(r => setTimeout(r, 1000));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 40000);

    try {
      const response = await fetch(`${GATEWAY_URL}${GATEWAY_API_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: APP_ID,
          user_id: userId,
          query_data: queryData,
          messages: messages,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const errText = await response.text();
        if (response.status === 500) {
          lastError = new Error(`Gateway HTTP 500`);
          if (attempt < retries) continue;
          throw lastError;
        }
        throw new Error(`Gateway HTTP ${response.status}: ${errText.substring(0, 200)}`);
      }

      const data = await response.json();
      if (!data.success) {
        lastError = new Error(data.error || 'Gateway 回覆失敗');
        if (attempt < retries) continue;
        throw lastError;
      }
      return data.response;
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;
      if (err.name === 'AbortError' || err.message.includes('aborted')) {
        if (attempt < retries) continue;
      } else if (attempt >= retries) {
        throw err;
      }
    }
  }
  throw lastError || new Error('Gateway 請求失敗');
}

// 配置
const config = {
  alphaVantageKey: process.env.ALPHA_VANTAGE_KEY || 'demo',
};

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (CORS_ORIGINS === '*') return cb(null, true);
    if (!CORS_ORIGINS) return cb(null, true); // 未設置時默認允許
    const allowed = CORS_ORIGINS.split(',').map(s => s.trim());
    cb(null, allowed.includes(origin));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// 全局安全 header
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.removeHeader('X-Powered-By');
  next();
});

// ============================================
// 財務數據 API（巴菲特/芒格系統，不需要登錄）
// ============================================

// 財務指標 API
app.get('/api/financial/:ticker', async (req, res) => {
  const ticker = req.params.ticker?.toUpperCase();
  if (!ticker) return res.status(400).json({ error: '請提供股票代碼' });
  
  try {
    const result = await new Promise((resolve) => {
      const python = spawn('python3', [path.join(__dirname, 'financial_data.py'), ticker]);
      let data = '';
      python.stdout.on('data', (chunk) => { data += chunk; });
      python.stderr.on('data', (chunk) => { console.error('財務數據錯誤:', chunk.toString()); });
      python.on('close', (code) => {
        if (code === 0 && data) {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve({ success: false, error: '解析失敗' }); }
        } else {
          resolve({ success: false, error: '財務數據查詢失敗' });
        }
      });
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: '財務數據API錯誤' });
  }
});

// 內在價值估算 API
app.get('/api/intrinsic-value/:ticker', async (req, res) => {
  const ticker = req.params.ticker?.toUpperCase();
  const price = parseFloat(req.query.price) || 100;
  if (!ticker) return res.status(400).json({ error: '請提供股票代碼' });
  
  try {
    const result = await new Promise((resolve) => {
      const python = spawn('python3', [path.join(__dirname, 'financial_data.py'), ticker, '--iv', price.toString()]);
      let data = '';
      python.stdout.on('data', (chunk) => { data += chunk; });
      python.on('close', (code) => {
        if (code === 0 && data) {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve({ success: false, error: '解析失敗' }); }
        } else {
          resolve({ success: false, error: '內在價值估算失敗' });
        }
      });
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: '內在價值API錯誤' });
  }
});

// 其他 API 需要認證
app.use(authMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// ===== 行業分類 API =====
app.get('/api/sector/:ticker', (req, res) => {
  const ticker = req.params.ticker?.toUpperCase();
  const sector = SECTOR_MAP[ticker] || '其他';
  res.json({ ticker, sector });
});

app.post('/api/sector/batch', (req, res) => {
  const { tickers } = req.body;
  if (!Array.isArray(tickers)) return res.status(400).json({ error: '需要 tickers 陣列' });
  const result = {};
  tickers.forEach(t => { result[t.toUpperCase()] = SECTOR_MAP[t.toUpperCase()] || '其他'; });
  res.json({ sectors: result });
});

// ===== 版本資訊 API =====
// 從 package.json 讀取版本號，前端用來顯示在最上方
const APP_VERSION = (() => {
  try { return require('./package.json').version || '0.0.0'; }
  catch (e) { return '0.0.0'; }
})();
app.get('/api/version', (req, res) => {
  res.json({ success: true, version: APP_VERSION, name: 'Stock AI' });
});

// ===== 用戶上下文 API（缺失的端點，app.js 依賴此 API）=====
app.get('/api/user-context', (req, res) => {
  if (!req.user) {
    return res.json({ success: true, hasPortfolio: false, hasWatchlist: false, context: '' });
  }
  try {
    const pf = stmts.getPortfolio.all(req.user.userId);
    const wl = stmts.getWatchlist.all(req.user.userId);
    const hasPortfolio = pf.length > 0;
    const hasWatchlist = wl.length > 0;
    const parts = [];
    if (hasPortfolio) parts.push(`持倉 ${pf.length} 支股票`);
    if (hasWatchlist) parts.push(`自選 ${wl.length} 支股票`);
    const context = parts.length ? `用戶目前有：${parts.join('、')}。` : '用戶目前沒有持倉和自選股。';
    res.json({ success: true, hasPortfolio, hasWatchlist, portfolioCount: pf.length, watchlistCount: wl.length, context });
  } catch (e) {
    res.json({ success: false, error: e.message, hasPortfolio: false, hasWatchlist: false, context: '' });
  }
});

// ===== 認證 API =====

// 註冊
app.post('/api/auth/register', (req, res) => {
  const ip = (req.ip || req.connection?.remoteAddress || '').replace('::ffff:', '');
  const rate = checkRateLimit(ip, 'register');
  if (!rate.allowed) {
    return res.status(429).json({
      error: `註冊次數過多，請 ${rate.waitSeconds} 秒後再試`,
      retryAfter: rate.waitSeconds
    });
  }
  try {
    const { username, email, password, display_name } = req.body;
    if (!username || !password) return res.status(400).json({ error: '用戶名和密碼為必填' });
    if (username.length < 3) return res.status(400).json({ error: '用戶名至少 3 字元' });
    if (password.length < 6) return res.status(400).json({ error: '密碼至少 6 字元' });
    // 檢查是否已存在
    if (stmts.getUserByUsername.get(username)) return res.status(409).json({ error: '用戶名已存在' });
    if (email && stmts.getUserByEmail.get(email)) return res.status(409).json({ error: '郵箱已註冊' });
    const passwordHash = hashPassword(password);
    const info = stmts.createUser.run(username, email || null, passwordHash, display_name || username);
    const user = stmts.getUserById.get(info.lastInsertRowid);
    const token = signJWT({ userId: user.id, username: user.username, role: user.role });
    res.cookie('token', token, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
    res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role } });
  } catch (e) {
    console.error('註冊失敗:', e.message);
    res.status(500).json({ error: '註冊失敗：' + e.message });
  }
});

// 登錄
app.post('/api/auth/login', (req, res) => {
  const ip = (req.ip || req.connection?.remoteAddress || '').replace('::ffff:', '');
  const rate = checkRateLimit(ip, 'login');
  if (!rate.allowed) {
    return res.status(429).json({
      error: `登入次數過多，請 ${rate.waitSeconds} 秒後再試`,
      retryAfter: rate.waitSeconds
    });
  }
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '請輸入用戶名和密碼' });
    const user = stmts.getUserByUsername.get(username) || (username.includes('@') ? stmts.getUserByEmail.get(username) : null);
    if (!user || !verifyPassword(password, user.password_hash)) {
      if (user?.id) {
        try { stmts.insertLoginLog.run(user.id, ip, req.headers['user-agent'] || '', 0); } catch(e) {}
      }
      return res.status(401).json({ error: '用戶名或密碼錯誤' });
    }
    try { stmts.updateUserLogin.run(user.id); } catch(e) {}
    try { stmts.insertLoginLog.run(user.id, ip, req.headers['user-agent'] || '', 1); } catch(e) {}
    const token = signJWT({ userId: user.id, username: user.username, role: user.role });
    res.cookie('token', token, {
      httpOnly: true,
      maxAge: JWT_EXPIRY,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
    res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role, cash: user.cash } });
  } catch (e) {
    console.error('登錄失敗:', e.message);
    res.status(500).json({ error: '登錄失敗' });
  }
});

// 登出
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// 獲取當前用戶
app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.json({ loggedIn: false });
  const user = stmts.getUserById.get(req.user.userId);
  if (!user) { res.clearCookie('token'); return res.json({ loggedIn: false }); }
  res.json({
    loggedIn: true,
    user: { id: user.id, username: user.username, displayName: user.display_name, email: user.email, role: user.role, cash: user.cash, avatar: user.avatar }
  });
});

// 更新個人資料
app.put('/api/auth/profile', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const { display_name, email } = req.body;
  const user = stmts.getUserById.get(req.user.userId);
  if (!user) return res.status(404).json({ error: '用戶不存在' });
  // 檢查郵箱唯一性
  if (email && email !== user.email) {
    const existing = stmts.getUserByEmail.get(email);
    if (existing) return res.status(409).json({ error: '郵箱已被使用' });
  }
  stmts.updateProfile.run(display_name || user.display_name, email || user.email, user.settings, req.user.userId);
  res.json({ success: true });
});

// 修改密碼
app.put('/api/auth/password', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) return res.status(400).json({ error: '請輸入舊密碼和新密碼' });
  if (new_password.length < 6) return res.status(400).json({ error: '新密碼至少 6 字元' });
  const user = stmts.getUserById.get(req.user.userId);
  if (!verifyPassword(old_password, user.password_hash)) return res.status(401).json({ error: '舊密碼錯誤' });
  stmts.updatePassword.run(hashPassword(new_password), req.user.userId);
  res.json({ success: true });
});

// ===== 持倉 API =====
app.get('/api/portfolio', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const items = stmts.getPortfolio.all(req.user.userId);
  const user = stmts.getUserById.get(req.user.userId);
  const divs = stmts.getDividendsAll.all(req.user.userId);
  res.json({ success: true, portfolio: items, dividends: divs, cash: user ? user.cash : 0 });
});

app.post('/api/portfolio/buy', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const { ticker, shares, price, stop_loss, take_profit, note, buy_date } = req.body;
  const t = ticker?.toUpperCase();
  if (!t || !shares || !price || shares <= 0 || price <= 0) return res.status(400).json({ error: '無效參數' });
  const cost = shares * price;
  const user = stmts.getUserById.get(req.user.userId);
  if (user.cash < cost) return res.status(400).json({ error: '現金不足，當前餘額 $' + user.cash.toFixed(2) + '，需要 $' + cost.toFixed(2) });
  const existing = stmts.getPortfolioItem.get(req.user.userId, t);
 const createdAt = buy_date ? buy_date.replace('T',' ') : new Date().toISOString().replace('T',' ').split('.')[0];
  try {
    const tx = db.transaction(() => {
      if (existing) {
        const newShares = existing.shares + shares;
        const newAvg = (existing.shares * existing.buy_price + shares * price) / newShares;
        stmts.updatePortfolio.run(newShares, newAvg, stop_loss || existing.stop_loss, take_profit || existing.take_profit, note || existing.note, req.user.userId, t);
      } else {
 db.prepare('INSERT INTO portfolio (user_id, ticker, shares, buy_price, stop_loss, take_profit, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.user.userId, t, shares, price, stop_loss || 0, take_profit || 0, note || '', createdAt);
      }
      // 扣除現金
      stmts.updateCash.run(user.cash - cost, req.user.userId);
 stmts.insertTransaction.run(req.user.userId, 'buy', t, shares, price, cost, createdAt + (note ? ' ' + note : ''));
    });
    tx();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '買入失敗：' + e.message });
  }
});

app.post('/api/portfolio/sell', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const { ticker, shares, price, sell_date } = req.body;
  const t = ticker?.toUpperCase();
  if (!t || !shares || !price || shares <= 0) return res.status(400).json({ error: '無效參數' });
  const existing = stmts.getPortfolioItem.get(req.user.userId, t);
  const createdAt = sell_date ? sell_date.replace('T',' ') : new Date().toISOString().replace('T',' ').split('.')[0];
  if (!existing) return res.status(404).json({ error: '無此持倉' });
  if (shares > existing.shares) return res.status(400).json({ error: '賣出股數超過持倉' });
  const revenue = shares * price;
  const profit = (price - existing.buy_price) * shares;
  try {
    const tx = db.transaction(() => {
      const user = stmts.getUserById.get(req.user.userId);
      if (shares === existing.shares) {
        stmts.deletePortfolio.run(req.user.userId, t);
      } else {
        stmts.updatePortfolio.run(existing.shares - shares, existing.buy_price, existing.stop_loss, existing.take_profit, existing.note, req.user.userId, t);
      }
      stmts.updateCash.run(user.cash + revenue, req.user.userId);
      stmts.insertTransaction.run(req.user.userId, 'sell', t, shares, price, revenue, profit >= 0 ? '盈利 ' + profit.toFixed(2) : '虧損 ' + Math.abs(profit).toFixed(2));
    });
    tx();
    const user = stmts.getUserById.get(req.user.userId);
    res.json({ success: true, cash: user.cash, profit });
  } catch (e) {
    res.status(500).json({ error: '賣出失敗：' + e.message });
  }
});

app.put('/api/portfolio/:ticker/sltp', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const t = req.params.ticker?.toUpperCase();
  const { stop_loss, take_profit } = req.body;
  const existing = stmts.getPortfolioItem.get(req.user.userId, t);
  if (!existing) return res.status(404).json({ error: '無此持倉' });
  stmts.updatePortfolio.run(existing.shares, existing.buy_price, stop_loss || 0, take_profit || 0, existing.note, req.user.userId, t);
  res.json({ success: true });
});

app.put('/api/portfolio/:ticker/note', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const t = req.params.ticker?.toUpperCase();
  const { note } = req.body;
  const existing = stmts.getPortfolioItem.get(req.user.userId, t);
  if (!existing) return res.status(404).json({ error: '無此持倉' });
  stmts.updatePortfolio.run(existing.shares, existing.buy_price, existing.stop_loss, existing.take_profit, note || '', req.user.userId, t);
  res.json({ success: true });
});

app.post('/api/portfolio/:ticker/dividend', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const t = req.params.ticker?.toUpperCase();
  const { amount, date, note } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: '無效股息金額' });
  stmts.insertDividend.run(req.user.userId, t, amount, date || new Date().toISOString().split('T')[0], note || '');
  // 股息加入現金
  const user = stmts.getUserById.get(req.user.userId);
  stmts.updateCash.run(user.cash + amount, req.user.userId);
  stmts.insertTransaction.run(req.user.userId, 'dividend', t, 0, 0, amount, '股息收入');
  res.json({ success: true });
});

app.get('/api/portfolio/:ticker/dividends', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const t = req.params.ticker?.toUpperCase();
  const divs = stmts.getDividends.all(req.user.userId, t);
  res.json({ success: true, dividends: divs });
});

// 存入現金（用戶手動存入模擬資金）
app.post('/api/portfolio/deposit', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: '無效金額' });
  const user = stmts.getUserById.get(req.user.userId);
  stmts.updateCash.run(user.cash + amount, req.user.userId);
  stmts.insertTransaction.run(req.user.userId, 'deposit', '', 0, 0, amount, '存入現金');
  res.json({ success: true, cash: user.cash + amount });
});

// ===== 自選股 API =====
app.get('/api/watchlist', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const items = stmts.getWatchlist.all(req.user.userId);
  const groups = stmts.getWatchlistGroups.all(req.user.userId);
  res.json({ success: true, watchlist: items, groups: groups.map(g => g.name) });
});

app.post('/api/watchlist/add', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const { ticker, group_name, note, target_buy_price, target_sell_price, priority } = req.body;
  const t = ticker?.toUpperCase();
  if (!t) return res.status(400).json({ error: '請提供股票代碼' });
  try {
    stmts.insertWatchlist.run(req.user.userId, t, group_name || '', note || '', target_buy_price || 0, target_sell_price || 0, priority || 0);
    res.json({ success: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: t + ' 已在自選中' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/watchlist/:ticker', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const t = req.params.ticker?.toUpperCase();
  const { group_name, note, target_buy_price, target_sell_price, priority } = req.body;
  const existing = stmts.getWatchlistItem.get(req.user.userId, t);
  if (!existing) return res.status(404).json({ error: '不在自選中' });
  stmts.updateWatchlist.run(group_name ?? existing.group_name, note ?? existing.note, target_buy_price ?? existing.target_buy_price, target_sell_price ?? existing.target_sell_price, priority ?? existing.priority, req.user.userId, t);
  res.json({ success: true });
});

app.delete('/api/watchlist/:ticker', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const t = req.params.ticker?.toUpperCase();
  stmts.deleteWatchlist.run(req.user.userId, t);
  res.json({ success: true });
});

app.post('/api/watchlist/groups', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '請提供分組名稱' });
  try {
    stmts.insertWatchlistGroup.run(req.user.userId, name);
    res.json({ success: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: '分組已存在' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/watchlist/groups/:name', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const name = decodeURIComponent(req.params.name);
  stmts.deleteWatchlistGroup.run(req.user.userId, name);
  res.json({ success: true });
});

// ===== 價格提醒 API =====
app.get('/api/alerts', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const alerts = stmts.getAlerts.all(req.user.userId);
  res.json({ success: true, alerts });
});

app.post('/api/alerts', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const { ticker, price, type } = req.body;
  if (!ticker || !price || !type) return res.status(400).json({ error: '無效參數' });
  stmts.insertAlert.run(req.user.userId, ticker.toUpperCase(), price, type);
  res.json({ success: true });
});

app.delete('/api/alerts/:id', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  stmts.deleteAlert.run(parseInt(req.params.id), req.user.userId);
  res.json({ success: true });
});

// ===== 交易記錄 API =====
app.get('/api/transactions', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const limit = parseInt(req.query.limit) || 100;
  const txs = stmts.getTransactions.all(req.user.userId, limit);
  res.json({ success: true, transactions: txs });
});

// ===== 分析歷史 API =====
app.get('/api/analysis-history', (req, res) => {
  if (!req.user) return res.json({ success: true, records: [] });
  const limit = parseInt(req.query.limit) || 20;
  const records = stmts.getAnalysisHistory.all(req.user.userId, limit);
  res.json({ success: true, records });
});

app.post('/api/analysis-history', (req, res) => {
  if (!req.user) return res.json({ success: true, skipped: true }); // 未登錄靜默跳過
  const { ticker, type, content, recommendation } = req.body;
  try {
    const result = stmts.insertAnalysis.run(req.user.userId, normalizeTicker(ticker), type || 'overview', content || '', recommendation || '');
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ success: false, error: '保存分析失敗: ' + e.message });
  }
});

// ===== localStorage 遷移 API =====
app.post('/api/auth/migrate', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const { portfolio, watchlist, watchlistGroups, transactions, priceAlerts, dividends, cash } = req.body;
  try {
    const tx = db.transaction(() => {
      // 遷移持倉
      if (Array.isArray(portfolio)) {
        portfolio.forEach(p => {
          const existing = stmts.getPortfolioItem.get(req.user.userId, p.ticker);
          if (!existing) {
            stmts.insertPortfolio.run(req.user.userId, p.ticker, p.shares, p.buyPrice, 0, 0, '');
          }
        });
      }
      // 遷移自選
      if (Array.isArray(watchlist)) {
        watchlist.forEach(t => {
          try { stmts.insertWatchlist.run(req.user.userId, t, '', '', 0, 0, 0); } catch(e) {}
        });
      }
      // 遷移分組
      if (Array.isArray(watchlistGroups)) {
        watchlistGroups.forEach(g => {
          try { stmts.insertWatchlistGroup.run(req.user.userId, g); } catch(e) {}
        });
      }
      // 遷移現金
      if (typeof cash === 'number' && cash > 0) {
        const user = stmts.getUserById.get(req.user.userId);
        stmts.updateCash.run(user.cash + cash, req.user.userId);
      }
    });
    tx();
    res.json({ success: true, message: '數據遷移完成' });
  } catch (e) {
    res.status(500).json({ error: '遷移失敗：' + e.message });
  }
});



// K 線 API（使用 Python 爬蟲 + 服務端緩存，無需 API Key）
const klineCache = new Map(); // ticker -> { data, timestamp }
const KLINE_CACHE_TTL = 30 * 60 * 1000; // 30 分鐘

// 批量報價緩存（關鍵修復：收盤後價格不再變動）
const quotesCache = new Map(); // ticker -> { data, timestamp }
const QUOTES_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 小時（美股交易時間外使用緩存）

// 檢查是否在台股交易時間
// 台股交易時間：台北時間 09:00-13:30 = UTC 01:00-05:30
function isTwMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=週日, 1-5=週一到週五
  const hour = now.getUTCHours(); // UTC 小時
  const minute = now.getUTCMinutes();
  
  // 週末不開市
  if (day === 0 || day === 6) {
    return false;
  }
  
  // 台股交易時間：UTC 01:00-05:30（台北 09:00-13:30）
  const nowMinutes = hour * 60 + minute;
  const openMinutes = 1 * 60; // UTC 01:00
  const closeMinutes = 5 * 60 + 30; // UTC 05:30
  
  const isOpen = nowMinutes >= openMinutes && nowMinutes < closeMinutes;
  
  return isOpen;
}

// 保留舊函數名稱向後相容
function isUSMarketOpen() {
  return isTwMarketOpen();
}

app.get('/api/chart/:ticker', async (req, res) => {
  const ticker = req.params.ticker?.toUpperCase();
  if (!ticker) return res.status(400).json({ error: '請提供股票代碼' });

  // 檢查服務端緩存
  const cached = klineCache.get(ticker);
  if (cached && (Date.now() - cached.timestamp) < KLINE_CACHE_TTL) {
    console.log('[K線] 緩存命中: ' + ticker);
    return res.json({ ...cached.data, cached: true });
  }

  // 使用 market_data.py 獲取 K 線（本地 CSV 優先 > TWSE MIS API > 模擬）
  const result = await new Promise((resolve) => {
    const python = spawn('python3', [path.join(__dirname, 'market_data.py'), ticker]);
    let data = '';
    python.stdout.on('data', (chunk) => { data += chunk; });
    python.stderr.on('data', (chunk) => { console.error('K線錯誤:', chunk.toString()); });
    python.on('close', (code) => {
      if (code === 0 && data) {
        try {
          const candles = JSON.parse(data);
          resolve({
            success: true,
            ticker: ticker,
            candles: candles,
            source: 'local_csv',
            note: '從 market_data.py 獲取（本地 CSV 或模擬）'
          });
        } catch (e) {
          resolve({ success: false, error: '解析失敗: ' + e.message });
        }
      } else {
        resolve({ success: false, error: 'market_data.py 執行失敗' });
      }
    });
  });

  // 成功則更新緩存
  if (result.success) {
    klineCache.set(ticker, { data: result, timestamp: Date.now() });
    console.log('[K線] 數據已緩存: ' + ticker + ' (' + (result.source || 'unknown') + ', ' + (result.candles?.length || 0) + ' 天)');
  }

  res.json(result);
});

// 嘗試使用 Alpha Vantage API
async function fetchAlphaVantage(ticker) {
  if (!config.alphaVantageKey || config.alphaVantageKey === 'demo') {
    return null; // 使用備用數據
  }
  
  try {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${config.alphaVantageKey}`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data['Global Quote'] && data['Global Quote']['05. price']) {
      const q = data['Global Quote'];
      return {
        ticker: q['01. symbol'],
        price: parseFloat(q['05. price']),
        change: parseFloat(q['09. change']),
        changePercent: parseFloat(q['10. change percent']?.replace('%', '') || 0),
        prevClose: parseFloat(q['08. previous close']),
        open: parseFloat(q['02. open']),
        high: parseFloat(q['03. high']),
        low: parseFloat(q['04. low']),
        volume: parseInt(q['06. volume']),
        timestamp: new Date().toISOString(),
        source: 'alphavantage',
        note: '實時數據 (Alpha Vantage)'
      };
    }
    return null;
  } catch (e) {
    console.error('Alpha Vantage error:', e.message);
    return null;
  }
}

// 系統提示 - 巴菲特與查理·芒格價值投資系統
const SYSTEM_PROMPT = `# Role
你是一位嚴格遵循巴菲特（Warren Buffett）與查理·芒格（Charlie Munger）價值投資哲學的資深量化與質化股票分析師。你的任務是依據極其严谨的基本面與估值指標，對用戶提供的台股個股數據進行程序化審視，並給出最終的操作評級與具體的止盈區間。

## 核心理念
「以合理的價格買入一家卓越的企業，並與之共同成長」

## Evaluation Framework（四大基石）
請依據以下四大維度對個股進行嚴格審查（定量與定性結合）：

### 1. 盈利能力與回報 (Profitability)
- 近 5 年平均 ROE 必須 >= 15%
- 近 5 年平均 ROIC >= 12%
- 毛利率與淨利率高於行業平均且穩定

### 2. 財務健康度 (Health)
- 自由現金流（FCF）必須為正且持續增長
- 利息保障倍數 > 5
- 總債務 / 股東權益（D/E）< 0.8（金融股除外）

### 3. 資本配置 (Capital)
- 總股本（Shares Outstanding）在過去 5 年內呈下降趨勢（代表持續回購）
- 或股息穩定增長

### 4. 護城河與估值 (Moat & Value)
- 質化評估具備高轉換成本或強大品牌
- 當前市價（Price）相比較於內在價值（IV）的折溢價比例

## Decision Rules（5個操作評級）
請根據以下公式與當前股價（Price）對比，輸出五種操作指令之一：

### 1. 【大量買入】
- 條件：滿足上述所有 1-3 項定量指標，且當前價格 ≤ 內在價值的 70%（安全邊際 ≥ 30%）

### 2. 【持續加倉】
- 條件：已持有該股票，基本面（ROE/FCF）未變差，且內在價值的 70% < 當前價格 ≤ 內在價值的 85%

### 3. 【持有觀望】
- 條件：基本面優良，內在價值的 85% < 當前價格 ≤ 內在價值的 115%（合理估值區間）

### 4. 【減倉】
- 條件：基本面出現輕微惡化（如毛利率連續兩季下滑區間），或價格進入高估區間（內在價值的 115% - 130%）
- 建議止盈價位區間：當價格達到 內在價值 × 1.2 至 內在價值 × 1.3 時，分批止盈 20%-30%

### 5. 【清倉】
- 條件：符合以下任一條件：
  - 價格 > 內在價值的 130%（極度泡沫）
  - 企業護城河永久性消失
  - 管理層誠信出問題
  - ROE 跌破 10%

## Output Format（嚴格輸出格式）
請嚴格按照以下結構輸出分析報告，禁止任何含糊其辭的套話：

---
## 1. 核心指標審查清單
- 5年平均 ROE: [填寫數值]%（符合/不符合）
- 5年平均 ROIC: [填寫數值]%（符合/不符合）
- 自由現金流趨勢: [正/負，增長情況]
- 總股本變動 (過去5年): [減少/增加]%
- 護城河定性評估: [簡述其核心競爭優勢]

## 2. 估值與內在價值（IV）計算
- 當前市場價格 (Price): $[填寫現價]
- 估算內在價值 (IV): $[填寫計算出的IV]（請註明你使用的估值方法，如 DCF 或盈餘折現）
- 當前溢價/折價率: [填寫百分比]%

## 3. 最終操作決策
- **【最終決策】**: [請在此處填寫：大量買入 / 持續加倉 / 持有觀望 / 減倉 / 清倉]
- **決策核心理由**: [列出2-3點最關鍵的量化或質化原因]

## 4. 獲利了結與止盈價位區間建議
- **建議減倉止盈區間**: $[IV * 1.15] - $[IV * 1.30]（在此區間建議分批鎖定利潤）
- **建議清倉止盈價位**: > $[IV * 1.30]（高於此價位，估值嚴重透支未來，建議全數落袋為安）
---

## 格式要求補充
1. 每個章節用 ## 標題
2. 數據和指標預設使用 Markdown 表格呈現（結構清晰、易於閱讀）
3. 若單項指標較少（1~2項），也可用列表：- **指標名稱**：數值 | 評價
4. 重要結論用 **粗體**
5. 分隔線用 ---
6. 免責聲明放最後

## 一致性要求
1. 全程保持同一立場：開頭、中間、結尾的投資建議必須保持一致，不能前後矛盾
2. 所有分析都必須服務於最後的投資結論，前面章節的分析要支持後面的結論
3. 如果不符合巴菲特標準，就不要說"建議買入"，要保持客觀一致
4. 最後必須有明確的操作評級

**免責聲明：** 本分析基於巴菲特/芒格價值投資理念，僅供參考，投資者應自行判斷。`;


// 構建用戶投資上下文（持倉 + 自選股 + 歷史分析）→ 注入 AI system prompt
async function buildUserInvestContext(userId) {
  if (!userId) return '';
  try {
    const pf = stmts.getPortfolio.all(userId);
    const wl = stmts.getWatchlist.all(userId);
    const divs = stmts.getDividendsAll.all(userId);
    const history = stmts.getAnalysisHistory.all(userId, 10); // 最近10次分析
    let ctx = '';
    if (pf.length) {
      // 獲取即時報價以計算正確佔比（使用緩存避免重複請求）
      const tickers = pf.map(p => p.ticker);
      let quotes = {};
      try {
        // 檢查緩存，5分鐘內不重複請求
        const CONTEXT_QUOTES_CACHE_TTL = 5 * 60 * 1000;
        const cacheKey = 'context_quotes_' + tickers.sort().join(',');
        const cachedQ = quotesCache.get(cacheKey);
        if (cachedQ && (Date.now() - cachedQ.timestamp) < CONTEXT_QUOTES_CACHE_TTL) {
          quotes = cachedQ.data;
        } else {
          const resp = await timedFetch(`http://127.0.0.1:${PORT}/api/quotes`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({tickers}) }, 10000);
          const qd = await resp.json();
          if (qd.success && qd.quotes) {
            const qArr = Array.isArray(qd.quotes) ? qd.quotes : Object.values(qd.quotes);
            qArr.forEach(q => { if (q.success && q.ticker) quotes[q.ticker] = q; });
            quotesCache.set(cacheKey, { data: quotes, timestamp: Date.now() });
          }
        }
      } catch(e) { console.warn('[buildUserInvestContext] quotes fetch failed:', e.message); }

      const totalCost = pf.reduce((s, p) => s + p.shares * p.buy_price, 0);
      let totalValue = 0;
      const details = pf.map(p => {
        const cp = quotes[p.ticker]?.price || p.buy_price;
        const mv = p.shares * cp;
        totalValue += mv;
        return { ticker: p.ticker, shares: p.shares, buy_price: p.buy_price, cp, mv, cost: p.shares * p.buy_price };
      });

      const totalPnL = totalValue - totalCost;
      const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost * 100) : 0;

      ctx += '\n## 用戶持倉信息（基於即時報價）\n';
      ctx += '用戶目前持有 ' + pf.length + ' 個股票，';
      ctx += '總本金 $' + totalCost.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) + '，';
      ctx += '總市值 $' + totalValue.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) + '\n';
      ctx += '總損益：$' + totalPnL.toFixed(2) + ' (' + (totalPnLPct >= 0 ? '+' : '') + totalPnLPct.toFixed(2) + '%)\n\n';
      ctx += '| 股票 | 持股 | 成本均價 | 現價 | 本金 | 市值 | 佔比 | 損益 |\n';
      ctx += '|------|------|----------|------|------|------|------|------|\n';
      details.sort((a, b) => b.mv - a.mv).forEach(p => {
        const w = totalValue > 0 ? (p.mv / totalValue * 100) : 0;
        const pnl = p.mv - p.cost;
        const pnlPct = p.cost > 0 ? (pnl / p.cost * 100) : 0;
        ctx += '| ' + p.ticker + ' | ' + p.shares + '股 | $' + p.buy_price.toFixed(2) + ' | $' + p.cp.toFixed(2) + ' | $' + p.cost.toFixed(2) + ' | $' + p.mv.toFixed(2) + ' | ' + w.toFixed(1) + '% | $' + pnl.toFixed(2) + ' (' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%) |\n';
      });
      ctx += '\n';

      // 行業集中度（基於市值佔比）
      const sectorMap = {};
      details.forEach(p => { const s = getSector(p.ticker); sectorMap[s] = (sectorMap[s]||0) + p.mv; });
      const sectorEntries = Object.entries(sectorMap).sort((a,b) => b[1]-a[1]);
      if (sectorEntries.length > 0) {
        ctx += '行業分布（基於市值）：' + sectorEntries.map(([s,v]) => s + '(' + (v/totalValue*100).toFixed(1) + '%)').join('、') + '\n';
      }
      ctx += '請在分析時根據以上真實市值佔比數據給出個性化建議，包括：\n';
 ctx += '1. 個股佔比是否合理（單股>30%屬過度集中）\n';
 ctx += '2. 行業集中度風險\n';
 ctx += '3. 具體加倉/減倉/提倉建議\n';
 ctx += '4. 是否需要新增新的個股標的以分散風險\n';
 ctx += '5. 請在最後提供一段總結，明確指出每支個股的加倉/減倉/提倉/新增建議\n';
    }
    if (wl.length) {
      ctx += '\n## 用戶自選股\n';
      const grouped = {};
      wl.forEach(w => {
        const g = w.group_name || '未分組';
        if (!grouped[g]) grouped[g] = [];
        grouped[g].push(w);
      });
      Object.entries(grouped).forEach(([g, items]) => {
        ctx += '### ' + g + '\n';
        items.forEach(w => {
          ctx += '- **' + w.ticker + '**';
          if (w.target_buy_price) ctx += '，目標買入 $' + w.target_buy_price;
          if (w.target_sell_price) ctx += '，目標賣出 $' + w.target_sell_price;
          if (w.note) ctx += '，備註: ' + w.note;
          if (w.priority) ctx += '，優先級: ' + w.priority;
          ctx += '\n';
        });
      });
      ctx += '請在回答時參考用戶的自選股，尤其是當用戶詢問是否買入某股時，可以對比自選股中的目標價。\n';
    }
    // 新增：歷史分析結果注入上下文
    if (history.length) {
      ctx += '\n## 歷史分析記錄（最近分析）\n';
      ctx += '以下是用戶之前的分析結果，請保持對話連貫性：\n\n';
      history.forEach((h, idx) => {
        ctx += `### ${idx + 1}. ${h.ticker} (${h.type}) - ${h.created_at}\n`;
        if (h.recommendation) {
          ctx += `- 之前建議：${h.recommendation}\n`;
        }
        // 只顯示結論部分（避免太長）
        const conclusionMatch = h.content.match(/## 🎯 投資結論([\s\S]*?)(?=##|$)/);
        if (conclusionMatch) {
          ctx += conclusionMatch[1].substring(0, 500) + '\n';
        } else {
          ctx += h.content.substring(0, 500) + '\n';
        }
        ctx += '\n';
      });
      ctx += '【重要】請注意：\n';
      ctx += '1. 如果用戶繼續詢問之前分析過的股票，請參考之前的建議\n';
      ctx += '2. 如果市場情況沒有重大變化，請保持建議的一致性\n';
      ctx += '3. 如果需要調整建議，請明確說明原因\n';
    }
    if (!ctx) ctx = '\n（用戶目前沒有持倉和自選股）\n';
    return ctx;
  } catch (e) {
    console.error('[buildUserInvestContext] Error:', e.message);
    return '';
  }
}

// 本地備用分析（當 API 失敗時使用）
function generateFallbackAnalysis(ticker, type) {
  const analyses = {
    overview: `## 🏰 經濟護城河分析

| 護城河類型 | 存在與否 | 說明 |
|------------|----------|------|
| 品牌價值 | ✅ | ${ticker} 具有較強品牌認知度 |
| 成本優勢 | ⚠️ | 需進一步分析成本結構 |
| 網絡效應 | ⚠️ | 視具體業務模式而定 |
| 轉換成本 | ⚠️ | 客戶黏著度待評估 |

**護城河評級：** 中等（需更多數據確認）

---

## 💰 財務健康度（巴菲特標準）

| 指標 | 數值 | 標準 | 評價 |
|------|------|------|------|
| ROE | 待查詢 | >15% | ⏳ |
| 毛利率 | 待查詢 | >40% | ⏳ |
| 自由現金流 | 待查詢 | 正數 | ⏳ |
| 負債率 | 待查詢 | <50% | ⏳ |

---

## 📊 估值與安全邊際

| 指標 | 數值 | 評價 |
|------|------|------|
| P/E | 待查詢 | 需對比行業平均 |
| PEG | 待查詢 | 成長性指標 |
| 內在價值估算 | 待計算 | 需要更多財務數據 |
| 當前價格 | 請查看報價 | - |
| **安全邊際** | 待評估 | 需要完整分析 |

---

## 👔 管理層評估

- **誠信度：** 需查閱管理層歷史記錄
- **資本配置：** 觀察過去投資決策
- **股東導向：** 查看股息政策和回購記錄

---

## ⚠️ 風險提示

1. **數據不完整風險**：當前分析基於有限信息
2. **市場風險**：整體市場波動影響
3. **行業風險**：行業週期性變化

---

## 🎯 投資結論（巴菲特標準）

**能力圈判斷：** 建議深入研究公司業務模式

**護城河：** 待確認

**安全邊際：** 待計算

**最終建議：** 🟡 觀望 - 需要更多數據進行完整分析

**理由：** AI 分析服務暫時不可用，建議參考專業財經網站獲取完整分析。

---

**免責聲明：** 本分析為簡化版本，僅供參考。AI 服務暫時不可用，建議使用其他專業工具進行完整分析。`,

    technical: `## 📈 趨勢判斷
- 日線趨勢：請查看 K 線圖
- 週線趨勢：請查看 K 線圖

## 📍 關鍵位置
| 類型 | 價格 | 說明 |
|------|------|------|
| 壓力位 1 | 待計算 | 近期高點 |
| 壓力位 2 | 待計算 | 歷史高點 |
| 支撐位 1 | 待計算 | 近期低點 |
| 支撐位 2 | 待計算 | 歷史低點 |

## 📊 技術指標
| 指標 | 數值 | 信號 |
|------|------|------|
| RSI | 請查看圖表 | - |
| MACD | 請查看圖表 | - |
| 均線 | 請查看圖表 | - |

## 🎯 操作建議
- **短線：** 請參考 K 線圖技術分析
- **中線：** 建議等待更明確趨勢
- **停損點：** 建議設置在支撐位下方 5-8%

---
**注意：** AI 技術分析服務暫時不可用，請參考圖表自行判斷。`,

    fundamental: `## 🏢 商業模式
- 核心產品/服務：請查閱公司年報
- 營收來源結構：請查閱財務報表

## 💰 財務健康度
| 指標 | 數值 | 評分 |
|------|------|------|
| 營收增長率 | 待查詢 | ⏳ |
| 淨利率 | 待查詢 | ⏳ |
| 負債率 | 待查詢 | ⏳ |
| 現金流 | 待查詢 | ⏳ |

## 📊 成長性分析
- 過去3年複合成長率：待計算
- 未來預期成長：請參考分析師預測
- 成長驅動因素：需深入研究

## 💎 估值合理性
- P/E ratio vs 行業平均：待比較
- PEG ratio：待計算
- 是否被低估/高估：需完整分析

## ✅ 投資結論
**長期投資價值：** 待評估
**建議：** 請參考專業財經網站獲取完整基本面分析

---
**注意：** AI 基本面分析服務暫時不可用。`,

    risk: `## ⚠️ 風險評估報告

### 📊 風險評分
| 風險類型 | 評分 (1-10) | 說明 |
|----------|-------------|------|
| 估值風險 | 待評估 | 需要完整財務數據 |
| 業務風險 | 待評估 | 需了解業務模式 |
| 競爭風險 | 待評估 | 需行業分析 |
| 宏觀風險 | 待評估 | 需經濟環境分析 |

### 🔴 主要風險點
1. **數據不完整風險**
   - 影響程度：高
   - 發生概率：確定

2. **AI 服務不可用風險**
   - 影響程度：中
   - 發生概率：暫時性

### 🦢 黑天鵝風險
- 潛在黑天鵝事件：市場系統性風險
- 可能影響：整體投資組合

### 💰 最大虧損評估
- 極端情況下可能跌幅：無法估算
- 建議停損位置：請自行設定

### ✅ 風險結論
**風險等級：** 無法評估（數據不足）
**適合投資者：** 建議等待完整分析

---
**注意：** AI 風險評估服務暫時不可用。`,

    signal: `## 🎯 買賣信號分析

### 📊 綜合評分
| 項目 | 評分 | 說明 |
|------|------|------|
| 技術面 | ⏳ | 請查看 K 線圖 |
| 基本面 | ⏳ | 數據不足 |
| 籌碼面 | ⏳ | 數據不足 |
| 消息面 | ⏳ | 請關注新聞 |

### 💰 價位建議
| 操作 | 價格區間 | 說明 |
|------|----------|------|
| 買入區間 | 待計算 | 請參考技術分析 |
| 目標價 1 | 待計算 | 短期目標 |
| 目標價 2 | 待計算 | 中期目標 |
| 停損價 | 待計算 | 請自行設定 |

### ⚖️ 風險回報比
- 預期收益：無法估算
- 潛在虧損：無法估算
- 風險回報比：無法計算

### 📅 持有建議
- **持有期限：** 建議觀望
- **建議倉位：** 請根據風險承受能力決定

### ✅ 操作結論
**當前建議：** 🟡 觀望
**理由：** AI 分析服務暫時不可用，建議參考其他專業工具

---
**注意：** AI 信號分析服務暫時不可用。`
  };
  
  return analyses[type] || analyses.overview;
}

// 健康檢查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', gateway: GATEWAY_URL, appId: APP_ID });
});

// 插拔式：返回可用分析类型配置
app.get('/api/config', (req, res) => {
  try {
    const cfg = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'analysis-config.json'), 'utf8'));
    res.json({ success: true, config: cfg });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 嘗試獲取實時股價（Python 爬蟲 - 使用更好的 realtime_price.py）
function timedFetch(url, options = {}, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
    fetch(url, { ...options, signal: controller.signal })
      .then(r => { clearTimeout(timer); resolve(r); })
      .catch(() => { clearTimeout(timer); resolve(null); });
  });
}

function normalizeTicker(ticker) {
  return String(ticker || '').trim().toUpperCase();
}

function normalizeQuoteResult(result, ticker) {
  if (!result || typeof result !== 'object') return null;
  if (!result.success && result.price) result.success = true;
  if (result.success && result.price) {
    result.ticker = normalizeTicker(result.ticker || ticker);
    result.price = Number(result.price);
    result.prevClose = Number(result.prevClose || result.previousClose || result.regularMarketPreviousClose || 0);

    // 當日漲跌必須以「現價 vs 前一交易日收盤價」重新計算，避免任何來源回傳的 changePercent 不一致。
    if (Number.isFinite(result.price) && Number.isFinite(result.prevClose) && result.prevClose > 0) {
      const diff = result.price - result.prevClose;
      const pct = diff / result.prevClose * 100;
      // 健全性檢查：若推算出的當日漲跌幅 |pct|>50%，幾乎必定是 prevClose 與 price 跨日對位錯位 ──
      // 直接把 changePercent 設為 null，前端會 fallback 顯示「--」，避免錯誤訊號誤導用戶。
      if (Math.abs(pct) > 50) {
        result.change = null;
        result.changePercent = null;
        result.prevCloseSuspect = true;
      } else {
        result.change = round(diff, 2);
        result.changePercent = round(pct, 2);
      }
    } else {
      // 沒有可信 prevClose 就不要瞎算
      result.change = null;
      result.changePercent = null;
      result.prevCloseSuspect = true;
    }

    result.open = Number(result.open || 0);
    result.high = Number(result.high || 0);
    result.low = Number(result.low || 0);
    result.volume = Number(result.volume || 0);
    result.timestamp = result.timestamp || Date.now();
    result.note = result.note || ((result.source || 'python') + ' 實時數據');
    return result;
  }
  return result;
}

// v2.0.0 報價方式：統一走 realtime_price.py；單股與批量都使用同一個 Python 數據鏈路。
function runRealtimePricePython(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const python = spawn('python3', [path.join(__dirname, 'realtime_price.py'), ...args]);
    let data = '';
    let error = '';
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };

    python.stdout.on('data', (chunk) => { data += chunk; });
    python.stderr.on('data', (chunk) => { error += chunk; });
    python.on('close', (code) => {
      if (code === 0 && data) {
        try {
          finish(JSON.parse(data));
        } catch (e) {
          console.error('[Quote] Python JSON parse failed:', e.message, data.slice(0, 300));
          finish(null);
        }
      } else {
        if (error) console.warn('[Quote] Python failed:', error.slice(0, 300));
        finish(null);
      }
    });

    const timer = setTimeout(() => {
      try { python.kill(); } catch (e) {}
      finish(null);
    }, timeoutMs);
  });
}

async function getStockPricePython(ticker) {
  const t = normalizeTicker(ticker);
  const result = await runRealtimePricePython([t], 20000);
  return normalizeQuoteResult(result, t);
}

async function getStockPricesPythonBatch(tickers) {
  const clean = [...new Set((tickers || []).map(normalizeTicker).filter(Boolean))];
  if (!clean.length) return [];

  // 優先使用 realtime_price.py 內建 --batch，避免 Node 同時啟多個 Python 導致報價源速率限制或結果不穩。
  const batch = await runRealtimePricePython([clean[0], '--batch', clean.join(',')], Math.max(20000, clean.length * 8000));
  if (batch && Array.isArray(batch.quotes)) {
    const byTicker = new Map(batch.quotes.map(q => [normalizeTicker(q.ticker), normalizeQuoteResult(q, q.ticker)]));
    return clean.map(t => byTicker.get(t) || { success: false, ticker: t, error: '批量報價未返回該股票' });
  }

  // fallback：逐個查詢，保留 v2.0.0 的 Python 報價鏈路。
  const results = [];
  for (const t of clean) {
    try {
      const q = await getStockPricePython(t);
      results.push(q && q.success ? q : { success: false, ticker: t, error: q?.error || '無法獲取價格' });
    } catch (e) {
      results.push({ success: false, ticker: t, error: e.message });
    }
  }
  return results;
}

// 模擬股價數據（備用）- 台股主要股票
const stockData = {
  '2330': { name: '台積電', price: 980.00, change: 15.00, changePercent: 1.56, prevClose: 965.00, high: 985.00, low: 960.00, volume: 45630908, pe: 28.5, eps: 34.42, marketCap: 25400000000000, week52High: 1080.00, week52Low: 570.00 },
  '2317': { name: '鴻海', price: 175.50, change: 2.50, changePercent: 1.44, prevClose: 173.00, high: 177.00, low: 172.00, volume: 58500000, pe: 15.2, eps: 11.55, marketCap: 2430000000000, week52High: 205.00, week52Low: 105.00 },
  '2454': { name: '聯發科', price: 1380.00, change: 25.00, changePercent: 1.85, prevClose: 1355.00, high: 1390.00, low: 1345.00, volume: 12100000, pe: 22.8, eps: 60.53, marketCap: 2320000000000, week52High: 1650.00, week52Low: 750.00 },
  '2303': { name: '聯電', price: 52.80, change: 0.70, changePercent: 1.34, prevClose: 52.10, high: 53.20, low: 51.80, volume: 85200000, pe: 12.5, eps: 4.22, marketCap: 660000000000, week52High: 65.00, week52Low: 35.00 },
  '2881': { name: '富邦金', price: 88.50, change: 0.60, changePercent: 0.68, prevClose: 87.90, high: 89.20, low: 87.50, volume: 35200000, pe: 14.2, eps: 6.23, marketCap: 1100000000000, week52High: 95.00, week52Low: 62.00 },
  '2882': { name: '國泰金', price: 65.80, change: -0.20, changePercent: -0.30, prevClose: 66.00, high: 66.30, low: 65.50, volume: 28500000, pe: 18.5, eps: 3.56, marketCap: 950000000000, week52High: 72.00, week52Low: 45.00 },
  '2412': { name: '中華電', price: 128.50, change: 1.20, changePercent: 0.94, prevClose: 127.30, high: 129.00, low: 127.00, volume: 15800000, pe: 26.8, eps: 4.79, marketCap: 990000000000, week52High: 135.00, week52Low: 105.00 },
  '2357': { name: '華碩', price: 595.00, change: 8.00, changePercent: 1.36, prevClose: 587.00, high: 600.00, low: 582.00, volume: 5500000, pe: 18.2, eps: 32.69, marketCap: 440000000000, week52High: 680.00, week52Low: 380.00 },
  '2308': { name: '台達電', price: 385.00, change: 5.50, changePercent: 1.45, prevClose: 379.50, high: 388.00, low: 377.00, volume: 8200000, pe: 21.5, eps: 17.91, marketCap: 1000000000000, week52High: 420.00, week52Low: 280.00 },
  '3711': { name: '日月光投控', price: 158.50, change: 2.80, changePercent: 1.80, prevClose: 155.70, high: 160.00, low: 154.50, volume: 25000000, pe: 16.8, eps: 9.44, marketCap: 660000000000, week52High: 185.00, week52Low: 95.00 },
  '3034': { name: '聯詠', price: 625.00, change: 12.00, changePercent: 1.96, prevClose: 613.00, high: 630.00, low: 610.00, volume: 3500000, pe: 15.5, eps: 40.32, marketCap: 340000000000, week52High: 720.00, week52Low: 380.00 },
  '2379': { name: '瑞昱', price: 485.00, change: 7.50, changePercent: 1.57, prevClose: 477.50, high: 490.00, low: 475.00, volume: 6100000, pe: 20.2, eps: 24.01, marketCap: 240000000000, week52High: 550.00, week52Low: 280.00 },
  '6669': { name: '緯創', price: 118.50, change: 1.80, changePercent: 1.54, prevClose: 116.70, high: 120.00, low: 116.00, volume: 12500000, pe: 12.8, eps: 9.26, marketCap: 340000000000, week52High: 140.00, week52Low: 70.00 },
  '8046': { name: '南電', price: 268.00, change: 4.50, changePercent: 1.71, prevClose: 263.50, high: 270.00, low: 262.00, volume: 1800000, pe: 18.5, eps: 14.49, marketCap: 100000000000, week52High: 310.00, week52Low: 160.00 },
  '2395': { name: '研華', price: 328.00, change: 5.00, changePercent: 1.55, prevClose: 323.00, high: 332.00, low: 320.00, volume: 3500000, pe: 22.8, eps: 14.39, marketCap: 160000000000, week52High: 380.00, week52Low: 220.00 }
};

// 報價 API：套用 v2.0.0 的 realtime_price.py 當前價格獲取方式；GET/POST 都支援，避免子路徑下 GET 被 SPA fallback 成 HTML。
async function quoteHandler(req, res) {
  const ticker = req.method === 'GET' ? req.query.ticker : req.body?.ticker;
  const t = normalizeTicker(ticker);
  if (!t) return res.status(400).json({ success: false, error: '請提供股票代碼' });
  
  try {
    const pythonResult = await getStockPricePython(t);
    if (pythonResult && pythonResult.success && pythonResult.price) {
      return res.json({ success: true, ...pythonResult });
    }
    return res.json({ success: false, ticker: t, error: pythonResult?.error || '無法獲取價格' });
  } catch (e) {
    console.error('Failed to get quote:', e);
    return res.json({ success: false, ticker: t, error: e.message });
  }
}
app.get('/api/quote', quoteHandler);
app.post('/api/quote', quoteHandler);

// 批量報價：優先走 realtime_price.py --batch，確保各頁價格與 v2.0.0 Python 數據源一致。
app.post('/api/quotes', async (req, res) => {
  const { tickers } = req.body || {};
  if (!tickers || !Array.isArray(tickers)) {
    return res.status(400).json({ success: false, error: '請提供股票代碼列表' });
  }
  
  const results = await getStockPricesPythonBatch(tickers);
  res.json({ success: true, quotes: results });
});

function round(num, decimals = 2) {
  return Math.round(num * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

// 市場指數 API（台股指數）
app.get('/api/market/indices', async (req, res) => {
  // 台股指數：加權指數、電子指數、金融指數
  // 使用 TWSE MIS API 獲取即時指數
  const indexMap = {
    'TAIEX': { ex_ch: 'tse_t00.tw', name: '加權指數', ticker: '^TWII' },
    'TELI': { ex_ch: 'tse_t13.tw', name: '電子類指數', ticker: '^TELI' },
    'TFNI': { ex_ch: 'tse_t17.tw', name: '金融保險類', ticker: '^TFNI' },
  };
  const results = [];
  
  for (const [key, info] of Object.entries(indexMap)) {
    try {
      const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${info.ex_ch}&json=1&delay=0`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://mis.twse.com.tw/' }
      });
      const data = await resp.json();
      if (data.msgArray && data.msgArray.length > 0) {
        const msg = data.msgArray[0];
        const z = msg.z && msg.z !== '-' ? parseFloat(msg.z) : 0;
        const y = msg.y && msg.y !== '-' ? parseFloat(msg.y) : 0;
        const o = msg.o && msg.o !== '-' ? parseFloat(msg.o) : 0;
        const h = msg.h && msg.h !== '-' ? parseFloat(msg.h) : 0;
        const l = msg.l && msg.l !== '-' ? parseFloat(msg.l) : 0;
        const change = y > 0 ? z - y : 0;
        const pct = y > 0 ? (change / y * 100) : 0;
        if (z > 0) {
          results.push({
            ticker: info.ticker, name: info.name,
            success: true, price: z, prevClose: y,
            open: o, high: h, low: l,
            change: Math.round(change * 100) / 100,
            changePercent: Math.round(pct * 100) / 100,
            source: 'twse', timestamp: Date.now()
          });
          continue;
        }
      }
    } catch (e) { /* TWSE failed, try fallback */ }
    
    // Fallback: try Yahoo
    const r = await getStockPricePython(info.ticker);
    if (r && r.success && r.price && !r.error) {
      results.push({ ticker: info.ticker, ...r });
    } else {
      const fallback = {
        '^TWII': { name: '加權指數', price: 21500.00, change: 85.20, changePercent: 0.40 },
        '^TELI': { name: '電子指數', price: 1125.50, change: 12.30, changePercent: 1.10 },
        '^TFNI': { name: '金融指數', price: 2185.80, change: -8.50, changePercent: -0.39 },
      };
      const fb = fallback[info.ticker];
      if (fb) results.push({ ticker: info.ticker, ...fb, source: 'demo', timestamp: Date.now() });
    }
  }
  res.json({ success: true, indices: results });
});

// 推薦股票 API
app.get('/api/recommend', async (req, res) => {
  try {
    // 直接讀取 data/recommendations.json (由 recommend_stocks.py 生成)
    const fs = require('fs');
    const path = require('path');
    const recFile = path.join(__dirname, 'data', 'recommendations.json');
    
    if (!fs.existsSync(recFile)) {
      // 若檔案不存在，執行 Python 生成
      const { execSync } = require('child_process');
      try {
        execSync(`python3 "${path.join(__dirname, 'recommend_stocks.py')}" > "${recFile}"`, { cwd: __dirname });
      } catch (e) {
        return res.json({ success: false, error: '推薦數據生成失敗' });
      }
    }
    
    const data = fs.readFileSync(recFile, 'utf8');
    const result = JSON.parse(data);
    res.json(result);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 分析 API
app.post('/api/analyze', async (req, res) => {
  const { ticker, question, type } = req.body;
  const analysisType = type || (question ? 'chat' : 'overview');
  if (!ticker && !question) {
    return res.status(400).json({ error: '請提供股票代碼或問題' });
  }

  // 獲取當前真實價格用於價格建議
  let currentPrice = null;
  let priceData = null;
  if (ticker) {
    try {
      const priceResp = await timedFetch(`http://127.0.0.1:${PORT}/api/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker })
      });
      const priceResult = await priceResp.json();
      if (priceResult.success && priceResult.price) {
        currentPrice = priceResult.price;
        priceData = priceResult;
      }
    } catch (e) {
      console.warn('[Analyze] 獲取價格失敗:', e.message);
    }
  }

  // 獲取K線數據用於分析
  let klineData = null;
  if (ticker) {
    try {
      const klResp = await timedFetch(`http://127.0.0.1:${PORT}/api/chart/` + ticker, {}, 15000);
      const klData = await klResp.json();
      if (klData.success && klData.candles && klData.candles.length > 0) {
        klineData = klData.candles;
      }
    } catch (e) {
      console.log('[Analyze] K線數據獲取失敗:', e.message);
    }
  }

  // 構建價格資訊
  let priceInfo = '';
  if (currentPrice && priceData) {
    priceInfo = `## 📈 當前價格資訊\n- **股票代號**：${ticker}\n- **當前價格**：$${currentPrice.toFixed(2)}\n- **漲跌**：${priceData.change >= 0 ? '+' : ''}${priceData.change?.toFixed(2) || '0.00'} (${priceData.changePercent >= 0 ? '+' : ''}${priceData.changePercent?.toFixed(2) || '0.00'}%)\n- **最高價**：$${priceData.high?.toFixed(2) || '-'}\n- **最低價**：$${priceData.low?.toFixed(2) || '-'}\n- **昨日收盤**：$${priceData.prevClose?.toFixed(2) || '-'}\n\n`;
  }

  // 構建價格建議規則
  let priceRules = `**【價格建議規則（非常重要，嚴格執行）】**：`;
  if (currentPrice) {
    const buyLow = (currentPrice * 0.90).toFixed(2);
    const buyHigh = (currentPrice * 1.10).toFixed(2);
    const addLow = currentPrice.toFixed(2);
    const addHigh = (currentPrice * 1.05).toFixed(2);
    const sellLow = (currentPrice * 0.95).toFixed(2);
    const sellHigh = currentPrice.toFixed(2);
    const holdBuyLow = (currentPrice * 0.90).toFixed(2);
    const holdBuyHigh = (currentPrice * 0.98).toFixed(2);
    const holdSellLow = (currentPrice * 1.02).toFixed(2);
    const holdSellHigh = (currentPrice * 1.10).toFixed(2);
    
    priceRules += `
**🔴 絕對重要：當前真實價格為 $${currentPrice.toFixed(2)}，所有價格建議必須以這個價格為基準，絕對不能偏離！不能出現 $2000+ 這類不合理價格！**

1. **建議買入 [RECOMMENDATION:BUY]**：
   - 提供**目標買入區間** = $${buyLow}-$${buyHigh}
   - 提供**首筆加倉建議價** = $${addLow}-$${addHigh}
   - 說明：「基於當前價格附近的合理區間建議買入」
2. **建議賣出 [RECOMMENDATION:SELL]**：
   - 提供**賣出價格區間** = $${sellLow}-$${sellHigh}
   - 說明：「當前價格附近建議賣出」
3. **建議觀望持有 [RECOMMENDATION:HOLD]**：
   - 提供**合適的加倉價位** = $${holdBuyLow}-$${holdBuyHigh}
   - 提供**合適的減倉價位** = $${holdSellLow}-$${holdSellHigh}
4. **建議避開 [RECOMMENDATION:AVOID]**：
   - 直接說明「不符合巴菲特標準，不建議買入」
   - 不給出任何買入價格建議

**【價格建議格式範例】**（已用當前價格 $${currentPrice.toFixed(2)} 計算好）：
- **買入區間**：$${buyLow}-$${buyHigh}
- **首筆加倉價**：$${addLow}-$${addHigh}
- **理由**：基於當前價格附近的合理區間，適合分批建倉`;
  } else {
    priceRules += `
1. **建議買入 [RECOMMENDATION:BUY]**：
   - 提供**目標買入區間** = 最近一週的價格區間（例如當前 $1.26，給 $1.00-$1.50）
   - 提供**首筆加倉建議價** = 當前價格 至 當前價格×1.10（上浮10%）都建議加倉（例如 $1.26-$1.39）
   - 說明：「基於當前價格附近的合理區間建議買入」
2. **建議賣出 [RECOMMENDATION:SELL]**：
   - 提供**賣出價格區間** = 當前價格 至 當前價格×0.90（下浮10%）都建議賣出（例如 $1.26，給 $1.13-$1.26）
   - 說明：「當前價格附近建議賣出」
3. **建議觀望持有 [RECOMMENDATION:HOLD]**：
   - 提供**合適的加倉價位** = 比當前價格略低（例如 $1.15-$1.25）
   - 提供**合適的減倉價位** = 比當前價格略高（例如 $1.30-$1.40）
4. **建議避開 [RECOMMENDATION:AVOID]**：
   - 直接說明「不符合巴菲特標準，不建議買入」
   - 不給出任何買入價格建議

**【價格建議格式範例】**：
- **買入區間**：$1.00-$1.50
- **首筆加倉價**：$1.26-$1.39（當前價格至上浮10%）
- **理由**：基於最近一週價格區間與當前價格，適合分批建倉`;
  }

  const prompts = {
    overview: `
${klineData ? '## 📊 歷史K線數據摘要（最近30天）' + klineData.slice(-30).map(k => `| ${new Date(k.time * 1000).toLocaleDateString()} | $${k.open} | $${k.high} | $${k.low} | $${k.close} | ${Math.round(k.volume / 1000000)}M |`).join('\n') + '\n' : ''}
${priceInfo}
請對 ${ticker} 進行巴菲特/芒格價值投資分析，格式如下：

## 🏰 經濟護城河分析

| 護城河類型 | 存在與否 | 說明 |
|------------|----------|------|
| 品牌價值 | ✅/❌ | ... |
| 成本優勢 | ✅/❌ | ... |
| 網絡效應 | ✅/❌ | ... |
| 轉換成本 | ✅/❌ | ... |

**護城河評級：** 寬闊 / 狹窄 / 無

---

## 💰 財務健康度（巴菲特標準）

| 指標 | 數值 | 標準 | 評價 |
|------|------|------|------|
| ROE | XX% | >15% | ✅/❌ |
| 毛利率 | XX% | >40% | ✅/❌ |
| 自由現金流 | $XX | 正數 | ✅/❌ |
| 負債率 | XX% | <50% | ✅/❌ |
| 利息覆蓋率 | XXx | >5x | ✅/❌ |

---

## 📊 估值與安全邊際

| 指標 | 數值 | 評價 |
|------|------|------|
| P/E | XX | ... |
| PEG | XX | ... |
| 內在價值估算 | $XXX | ... |
| 當前價格 | $XXX | ... |
| **安全邊際** | XX% | >30% ✅/❌ |

---

## 👔 管理層評估

- **誠信度：** 高/中/低
- **資本配置：** 優秀/良好/一般
- **股東導向：** ✅/❌

---

## ⚠️ 風險提示

1. 護城河風險
2. 估值風險
3. 行業風險

---

## 🎯 投資結論（巴菲特標準）

**能力圈判斷：** 是否在理解範圍內

**護城河：** 寬闊 / 狹窄 / 無

**安全邊際：** 充足 / 不足

**最終建議：** 🟢 買入 / 🟡 觀望持有 / 🔴 不符合標準（避開）

**理由：** XXX

## 💰 具體價格建議

**【價格建議規則（非常重要，嚴格執行）】**：
1. **建議買入 [RECOMMENDATION:BUY]**：
   - 提供**目標買入區間** = 最近一週的價格區間（例如當前 $1.26，給 $1.00-$1.50）
   - 提供**首筆加倉建議價** = 當前價格 至 當前價格×1.10（上浮10%）都建議加倉（例如 $1.26-$1.39）
   - 說明：「基於當前價格附近的合理區間建議買入」
2. **建議賣出 [RECOMMENDATION:SELL]**：
   - 提供**賣出價格區間** = 當前價格 至 當前價格×0.90（下浮10%）都建議賣出（例如當前 $1.26，給 $1.13-$1.26）
   - 說明：「當前價格附近建議賣出」
3. **建議觀望持有 [RECOMMENDATION:HOLD]**：
   - 提供**合適的加倉價位** = 比當前價格略低（例如 $1.15-$1.25）
   - 提供**合適的減倉價位** = 比當前價格略高（例如 $1.30-$1.40）
4. **建議避開 [RECOMMENDATION:AVOID]**：
   - 直接說明「不符合巴菲特標準，不建議買入」
   - 不給出任何買入價格建議

**【價格建議格式範例】**：
- **買入區間**：$1.00-$1.50
- **首筆加倉價**：$1.26-$1.39（當前價格至上浮10%）
- **理由**：基於最近一週價格區間與當前價格，適合分批建倉

**【必須】在最後一行單獨輸出以下標記之一（不可省略）：**
[RECOMMENDATION:BUY]  （適合買入）
[RECOMMENDATION:HOLD] （觀望持有）
[RECOMMENDATION:SELL] （建議賣出）
[RECOMMENDATION:AVOID]（不符合標準，避開）
---

**免責聲明：** 本分析基於巴菲特/芒格價值投資理念，僅供參考，投資者應自行判斷。
`,

    technical: `
請對 ${ticker} 進行技術分析，格式如下：

## 📈 趨勢判斷
- 日線趨勢：上漲 / 震盪 / 下跌
- 週線趨勢：上漲 / 震盪 / 下跌

## 📍 關鍵位置
| 類型 | 價格 | 說明 |
|------|------|------|
| 壓力位 1 | $XXX | ... |
| 壓力位 2 | $XXX | ... |
| 支撐位 1 | $XXX | ... |
| 支撐位 2 | $XXX | ... |

## 📊 技術指標
| 指標 | 數值 | 信號 |
|------|------|------|
| RSI | XX | 超買/超賣/中性 |
| MACD | ... | 金叉/死叉 |
| 均線 | ... | 多頭/空頭排列 |

## 🎯 操作建議
- **短線：** XXX
- **中線：** XXX
- **停損點：** $XXX
`,

    fundamental: `
請對 ${ticker} 進行基本面分析，格式如下：

## 🏢 商業模式
- 核心產品/服務
- 營收來源結構

## 💰 財務健康度
| 指標 | 數值 | 評分 |
|------|------|------|
| 營收增長率 | XX% | ⭐⭐⭐⭐⭐ |
| 淨利率 | XX% | ⭐⭐⭐⭐⭐ |
| 負債率 | XX% | ⭐⭐⭐⭐⭐ |
| 現金流 | XXX | ⭐⭐⭐⭐⭐ |

\`\`\`pie
{"labels":["營收增長","淨利率","低負債","現金流"],"values":[80,70,60,90],"colors":["#22c55e","#3b82f6","#f59e0b","#8b5cf6"]}
\`\`\`

## 📊 成長性分析
- 過去3年複合成長率
- 未來預期成長
- 成長驅動因素

## 💎 估值合理性
- P/E ratio vs 行業平均
- PEG ratio
- 是否被低估/高估

## ✅ 投資結論
**長期投資價值：** ⭐⭐⭐⭐⭐ (5星制)
**建議：** XXX
`,

    risk: `
請對 ${ticker} 進行風險評估，格式如下：

## ⚠️ 風險評估報告

### 📊 風險評分
| 風險類型 | 評分 (1-10) | 說明 |
|----------|-------------|------|
| 估值風險 | X | ... |
| 業務風險 | X | ... |
| 競爭風險 | X | ... |
| 宏觀風險 | X | ... |
| **總評分** | **X** | ... |

\`\`\`pie
{"labels":["估值風險","業務風險","競爭風險","宏觀風險"],"values":[3,5,4,2],"colors":["#22c55e","#f59e0b","#3b82f6","#ef4444"]}
\`\`\`

### 🔴 主要風險點
1. **風險一：** XXX
   - 影響程度：高/中/低
   - 發生概率：高/中/低

2. **風險二：** XXX

### 🦢 黑天鵝風險
- 潛在黑天鵝事件
- 可能影響

### 💰 最大虧損評估
- 極端情況下可能跌幅：XX%
- 建議停損位置：$XXX

### ✅ 風險結論
**風險等級：** 低 / 中 / 高
**適合投資者：** 保守型 / 穩健型 / 積極型
`,

    signal: `
請對 ${ticker} 給出具體買賣信號，格式如下：

## 🎯 買賣信號分析

### 📊 綜合評分
| 項目 | 評分 | 說明 |
|------|------|------|
| 技術面 | ⭐⭐⭐⭐⭐ | ... |
| 基本面 | ⭐⭐⭐⭐⭐ | ... |
| 籌碼面 | ⭐⭐⭐⭐⭐ | ... |
| 消息面 | ⭐⭐⭐⭐⭐ | ... |

\`\`\`pie
{"labels":["技術面","基本面","籌碼面","消息面"],"values":[4,3,3,4],"colors":["#22c55e","#3b82f6","#f59e0b","#8b5cf6"]}
\`\`\`

### 💰 價位建議
| 操作 | 價格區間 | 說明 |
|------|----------|------|
| 買入區間 | $XXX - $XXX | 分批買入 |
| 目標價 1 | $XXX | 短期目標 |
| 目標價 2 | $XXX | 中期目標 |
| 停損價 | $XXX | 跌破則出場 |

### ⚖️ 風險回報比
- 預期收益：XX%
- 潛在虧損：XX%
- 風險回報比：1:X

### 📅 持有建議
- **持有期限：** 短線(X天) / 中線(X週) / 長線(X月)
- **建議倉位：** XX% 資金

### ✅ 操作結論
**當前建議：** 🟢 買入 / 🟡 觀望 / 🔴 賣出

**【必須】在最後一行單獨輸出以下標記之一（不可省略）：**
[RECOMMENDATION:BUY]  （適合買入）
[RECOMMENDATION:HOLD] （觀望持有）
[RECOMMENDATION:SELL] （建議賣出）
[RECOMMENDATION:AVOID]（不符合標準，避開）
**理由：** XXX
`,

    compare: `
請對 ${ticker} 進行比較分析，格式如下：

## 📊 競爭對比分析

### 🏢 公司對比
| 項目 | ${ticker} | 競爭對手A | 競爭對手B |
|------|-----------|-----------|-----------|
| 市值 | $XXX | $XXX | $XXX |
| 營收 | $XXX | $XXX | $XXX |
| 市佔率 | XX% | XX% | XX% |
| P/E | XX | XX | XX |

\`\`\`pie
{"labels":["${ticker}","競爭對手A","競爭對手B"],"values":[50,30,20],"colors":["#22c55e","#3b82f6","#f59e0b"]}
\`\`\`

### ⚖️ 優勢對比
**${ticker} 優勢：**
- ✅ 優勢一
- ✅ 優勢二

**劣勢：**
- ❌ 劣勢一
- ❌ 劣勢二

### 📈 投資價值排序
1. **XXX** - 理由
2. **XXX** - 理由
3. **XXX** - 理由

### ✅ 結論
**推薦順序：** XXX
`,

    portfolio: `
請分析持倉組合：${ticker}，格式如下：

## 💼 投資組合分析

### 📊 持倉結構
| 股票 | 佔比 | 行業 | 評級 |
|------|------|------|------|
| XXX | XX% | 科技 | ⭐⭐⭐⭐⭐ |
| XXX | XX% | 消費 | ⭐⭐⭐⭐⭐ |

\`\`\`pie
{"labels":["XXX-科技","XXX-消費"],"values":[60,40],"colors":["#22c55e","#3b82f6"]}
\`\`\`

### ⚠️ 風險評估
- 行業集中度：高/中/低
- 單一股最大佔比：XX%
- 整體風險等級：高/中/低

### 🔧 調整建議
1. **加碼：** XXX
2. **減碼：** XXX  
3. **新增：** XXX

### ✅ 優化方向
XXX
`,

    // 3個月短期投資策略（專業投顧視角）
    signal3m: `
請對 ${ticker} 進行 3 個月短期專業投資分析：

## 📊 專業投顧 3 個月投資評估

### 🎯 核心策略框架
本分析基於北美資深投顧的短期選股策略，結合：
- 技術面動能分析
- 基本面催化劑識別
- 市場情緒評估
- 風險管理原則

---

## 📈 價格動能分析

| 指標 | 數值 | 信號 |
|------|------|------|
| 20日均線位置 | $XXX | 價格 >/< 均線 |
| 50日均線位置 | $XXX | 趨勢方向 |
| RSI (14日) | XX | <30超賣/ >70超買 |
| MACD 信號 | 金叉/死叉/中性 | 動能方向 |

---

## 💡 短期催化劑識別

### 基本面催化劑
| 催化劑類型 | 是否存在 | 說明 |
|------------|----------|------|
| 財報發布 | 有/無 | 下次財報日期 |
| 產品發布 | 有/無 | 即將發布的產品 |
| 機構增持 | 有/無 | 機構持股變動 |
| 政策利好 | 有/無 | 政府政策影響 |

### 市場情緒
- **散戶情緒：** 樂觀/中性/悲觀
- **機構立場：** 增持/中性/減持
- **分析師評級：** 買入/持有/賣出

---

## 🎯 技術面進場點位

| 價位類型 | 價格 | 說明 |
|----------|------|------|
| 理想買入價 | $XXX | 回調支撐位 |
| 合理買入價 | $XXX | 盤整區間 |
| 目標價 1 (1個月) | $XXX | 預期漲幅 XX% |
| 目標價 2 (3個月) | $XXX | 預期漲幅 XX% |
| 停損價 | $XXX | 跌破止損 |

---

## 📊 3 個月預期收益分析

| 情景 | 概率 | 目標價 | 預期收益 | 說明 |
|------|------|--------|----------|------|
| 樂觀情景 | XX% | $XXX | +XX% | 催化劑如期兌現 |
| 基本情景 | XX% | $XXX | +XX% | 按計劃達成 |
| 保守情景 | XX% | $XXX | XX% | 低於預期 |

**基本情景 3 個月預期收益：** **+XX%**

---

## ⚠️ 風險管理

### 風險評估
| 風險類型 | 等級 | 說明 |
|----------|------|------|
| 市場風險 | 高/中/低 | 整體市場回調 |
| 波動性風險 | 高/中/低 | 歷史波動率 |

### 最大虧損保護
- **建議停損：** $XXX（-XX%）
- **風險回報比：** 1:X
- **頭寸建議：** XX% 資金

---

## 🎯 3 個月操作建議

### 進場策略
1. **首批進場：** 30% 資金 @ $XXX
2. **回調加碼：** 30% 資金 @ $XXX
3. **突破加碼：** 40% 資金 @ $XXX

### 持有期間
- **目標持有：** 60-90 天
- **中期評估：** 30 天後複查
- **紀律執行：** 嚴守停損

### ✅ 最終建議

**綜合評級：** 強烈買入 / 謹慎買入 / 觀望 / 避開

**【必須】在最後一行單獨輸出以下標記之一（不可省略）：**
[RECOMMENDATION:BUY]  （適合買入）
[RECOMMENDATION:HOLD] （觀望持有）
[RECOMMENDATION:SELL] （建議賣出）
[RECOMMENDATION:AVOID]（不符合標準，避開）

**3 個月目標價：** $XXX

**預期收益率：** +XX%

**理由：** 基於專業投顧分析

---

**免責聲明：** 本分析為 3 個月短期投顧建議，基於公開信息和技術分析，僅供參考，不構成投資建議。短期投資風險較高，請謹慎操作。`,

    chat: question || `請分析 ${ticker}`
  }

  try {
    // 透過 AI Gateway 發送分析請求
    const aiMessages = [
      { role: 'system', content: SYSTEM_PROMPT + await buildUserInvestContext(req.user?.userId) },
      { role: 'user', content: prompts[analysisType] || prompts.overview || prompts.chat }
    ];
    const aiResponse = await gatewayChat(aiMessages);

    if (aiResponse) {
      // 提取建議標記保存到數據庫
      let recommendation = '';
      const recMatch = aiResponse.match(/\[RECOMMENDATION:(BUY|HOLD|SELL|AVOID)\]/);
      if (recMatch) {
        recommendation = recMatch[1];
      }
      // 保存分析記錄（如果有用戶登錄）
      if (req.user?.userId) {
        try {
          stmts.insertAnalysis.run(req.user.userId, ticker, analysisType, aiResponse, recommendation);
        } catch (e) {
          console.error('[Analyze] 保存分析記錄失敗:', e.message);
        }
      }
      res.json({ success: true, content: aiResponse, ticker, type: analysisType, model: 'gateway', recommendation });
    } else {
      const fallbackContent = generateFallbackAnalysis(ticker, analysisType);
      res.json({ success: true, content: fallbackContent, ticker, type: analysisType, fallback: true });
    }
  } catch (error) {
    console.error('Analyze error:', error.message);
    const fallbackContent = generateFallbackAnalysis(ticker, analysisType);
    res.json({ success: true, content: fallbackContent, ticker, type: analysisType, fallback: true });
  }
});

// 問答 API
app.post('/api/chat', async (req, res) => {
  const { messages, question } = req.body;
  
  // 支持两种格式：messages 数组或单个 question
  const chatMessages = messages || (question ? [{ role: 'user', content: question }] : null);
  
  if (!chatMessages?.length) {
    return res.status(400).json({ error: '請提供對話內容' });
  }

  try {
    // 注入用戶持倉上下文（與分析 API 一致）
    const userCtx = await buildUserInvestContext(req.user?.userId);
    // 透過 AI Gateway 發送聊天請求
    const aiMessages = [
      { role: 'system', content: SYSTEM_PROMPT + userCtx },
      ...chatMessages
    ];
    const aiResponse = await gatewayChat(aiMessages);

    if (aiResponse) {
      res.json({ success: true, content: aiResponse, model: 'gateway' });
    } else {
      res.json({ success: true, content: `抱歉，AI 分析服務暫時不可用。請稍後重試。`, fallback: true });
    }
  } catch (error) {
    console.error('[Chat] Gateway error:', error.message);
    res.json({ success: true, content: `抱歉，AI 服務暫時不可用。請稍後重試。`, fallback: true, debug: error.message });
  }
});

// 添加收藏
app.post('/api/favorites/add', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const { analysis_id, ticker, type, note, content } = req.body;
  if (!ticker || !type) {
    return res.status(400).json({ error: '缺少必要參數' });
  }
  try {
    // 如果有 content 但沒有 analysis_id，先存入 analysis_history
    let aid = analysis_id || null;
    if (!aid && content) {
      const r = stmts.insertAnalysis.run(req.user.userId, ticker, type, content, '');
      aid = r.lastInsertRowid;
    }
    // 修復：如果 aid 為 falsy，傳入 null 而不是 0
    const result = stmts.addFavorite.run(req.user.userId, aid ? aid : null, ticker, type, note || '');
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: '收藏失敗: ' + e.message });
  }
});

// 移除收藏
app.delete('/api/favorites/:id', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const { id } = req.params;
  try {
    stmts.removeFavorite.run(parseInt(id), req.user.userId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '移除收藏失敗: ' + e.message });
  }
});

// 更新收藏
app.put('/api/favorites/:id', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const { id } = req.params;
  const { note, recommendation } = req.body;
  try {
    const result = stmts.updateFavorite.run(note || '', parseInt(id), req.user.userId);
    if (result.changes === 0) {
      return res.status(404).json({ error: '收藏記錄不存在或無權限' });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '更新收藏失敗: ' + e.message });
  }
});

// 獲取所有收藏
app.get('/api/favorites', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  try {
    const favorites = stmts.getFavorites.all(req.user.userId);
    res.json({ success: true, favorites });
  } catch (e) {
    res.status(500).json({ error: '獲取收藏失敗: ' + e.message });
  }
});

// 按股票代號獲取收藏
app.get('/api/favorites/ticker/:ticker', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const { ticker } = req.params;
  try {
    const favorites = stmts.getFavoritesByTicker.all(req.user.userId, ticker.toUpperCase());
    res.json({ success: true, favorites });
  } catch (e) {
    res.status(500).json({ error: '獲取收藏失敗: ' + e.message });
  }
});

// 按板塊+股票分組獲取收藏（用於收藏頁面樹狀結構）
app.get('/api/favorites/grouped', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  try {
    const favorites = stmts.getFavorites.all(req.user.userId);
    // 按板塊 → 股票 → 日期降序分組
    const grouped = {};
    favorites.forEach(f => {
      const sector = getSector(f.ticker);
      if (!grouped[sector]) grouped[sector] = {};
      if (!grouped[sector][f.ticker]) grouped[sector][f.ticker] = [];
      grouped[sector][f.ticker].push(f);
    });
    // 每個股票內按 created_at 降序（SQL 已排序，這裡再保險一次）
    Object.keys(grouped).forEach(sec => {
      Object.keys(grouped[sec]).forEach(t => {
        grouped[sec][t].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      });
    });
    // 板塊內股票按最新一筆收藏時間降序
    const result = Object.keys(grouped).map(sector => {
      const tickers = Object.keys(grouped[sector]).map(t => ({
        ticker: t,
        latestAt: grouped[sector][t][0].created_at,
        records: grouped[sector][t]
      })).sort((a, b) => new Date(b.latestAt) - new Date(a.latestAt));
      return {
        sector,
        latestAt: tickers[0].latestAt,
        totalCount: tickers.reduce((s, x) => s + x.records.length, 0),
        tickers
      };
    }).sort((a, b) => new Date(b.latestAt) - new Date(a.latestAt));
    res.json({ success: true, groups: result, total: favorites.length });
  } catch (e) {
    res.status(500).json({ error: '獲取收藏失敗: ' + e.message });
  }
});

// ============================================
// 分析记录保存 API（寫入數據庫）
app.post('/api/save-analysis', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '請先登錄' });
  const { ticker, type, content, recommendation } = req.body;
  if (!ticker || !type) {
    return res.status(400).json({ error: '缺少必要參數' });
  }
  try {
    const result = stmts.insertAnalysis.run(req.user.userId, ticker.toUpperCase(), type, content || '', recommendation || '');
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: '保存分析失敗: ' + e.message });
  }
});

// （analysis-history GET 已在前面通過數據庫定義，此處不再重複）

// 啟動服務
// SPA fallback — 必須在所有 API 路由之後註冊，否則會攛先匹配所有 GET 請求
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`📈 台股 AI 投顧助手已啟動（監聽: 0.0.0.0:${PORT}）`);
  console.log(`🔗 Gateway: ${GATEWAY_URL}`);
  console.log(`📱 App ID: ${APP_ID}`);
  console.log(`📊 巴菲特/芒格價值投資系統已就緒`);
});
