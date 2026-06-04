/**
 * StockAI 認證模組
 * ✅ 修復：統一使用 stockai.db，移除孤立的 stock_users.db
 * ✅ 修復：JWT_SECRET 無生產環境硬編碼 fallback
 * ✅ 修復：登入/註冊 Rate Limiting
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ============================================
// 1. JWT 配置（安全第一）
// ============================================
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('【安全警告】JWT_SECRET 未設置！請在 .env 中設置 process.env.JWT_SECRET');
    console.error('【安全警告】為防止意外，進程將在未設置密鑰時退出（生產環境）。');
    if (process.env.NODE_ENV === 'production') {
        process.exit(1);
    }
    console.warn('【警告】非生產環境，使用臨時密鑰，請尽快設置 JWT_SECRET');
}
const _JWT_SECRET = JWT_SECRET || 'DEV-ONLY-INSUFFICIENT-KEY-PLEASE-SET-JWT_SECRET-ENV';
const JWT_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 天

// ============================================
// 2. Rate Limiting（防暴力破解）
// ============================================
// 記憶體記錄：{ ip: { count, resetAt } }
const _rateLimitMap = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 分鐘窗口
const RATE_MAX_LOGIN = 10;              // 15 分鐘內最多 10 次登入
const RATE_MAX_REGISTER = 5;             // 15 分鐘內最多 5 次註冊

function _checkRateLimit(ip, action) {
    const now = Date.now();
    const max = action === 'login' ? RATE_MAX_LOGIN : RATE_MAX_REGISTER;
    const entry = _rateLimitMap.get(ip);

    if (!entry || now > entry.resetAt) {
        _rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS, action });
        return { allowed: true, remaining: max - 1 };
    }

    if (entry.count >= max) {
        const waitMs = entry.resetAt - now;
        return { allowed: false, remaining: 0, waitSeconds: Math.ceil(waitMs / 1000) };
    }

    entry.count++;
    return { allowed: true, remaining: max - entry.count };
}

// ============================================
// 3. 密碼處理（同步，安全）
// ============================================
function hashPassword(password) {
    const salt = bcrypt.genSaltSync(12); // 升級到 12 輪
    return bcrypt.hashSync(password, salt);
}

function verifyPassword(password, hash) {
    return bcrypt.compareSync(password, hash);
}

// ============================================
// 4. JWT 處理
// ============================================
function signJWT(payload) {
    return jwt.sign(payload, _JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function verifyJWT(token) {
    try {
        return jwt.verify(token, _JWT_SECRET);
    } catch (e) {
        return null;
    }
}

// ============================================
// 5. 認證中間件
// ============================================
function authMiddleware(req, res, next) {
    const reqPath = req.path;
    const token = (req.headers.authorization || '').replace('Bearer ', '') ||
                  req.cookies.token ||
                  req.cookies.stockai_token;

    // /api/auth/me：允許未登入查詢，但有 token 則解析
    if (reqPath === '/api/auth/me') {
        if (token) {
            const decoded = verifyJWT(token);
            if (decoded) req.user = decoded;
        }
        return next();
    }

    // 白名單：公開路由
    const whitelist = [
        '/login.html',
        '/register.html',
        '/api/auth/login',
        '/api/auth/register',
        '/api/auth/logout',
        '/api/version',
        // 市場資料/分析配置為 read-only，可公開；/api/analyze 內部也依賴這些端點
        '/api/config',
        '/api/quote',
        '/api/quotes',
        '/api/market/indices',
        '/api/market/overview',
        '/api/recommend',
        '/favicon.ico',
        '/',
    ];

    if (whitelist.includes(reqPath) ||
        reqPath.startsWith('/api/chart/') ||
        reqPath.startsWith('/api/financial/') ||
        reqPath.startsWith('/api/moat/') ||
        reqPath.startsWith('/css/') ||
        reqPath.startsWith('/js/') ||
        reqPath.startsWith('/images/') ||
        reqPath.endsWith('.css') ||
        reqPath.endsWith('.js')) {
        return next();
    }

    if (!token) {
        if (reqPath.endsWith('.html') || reqPath === '/' || !reqPath.startsWith('/api/')) {
            const prefix = req.headers['x-forwarded-prefix'] || '';
            return res.redirect(prefix + '/login.html');
        }
        return res.status(401).json({ error: '請先登入' });
    }

    const decoded = verifyJWT(token);
    if (!decoded) {
        if (reqPath.endsWith('.html') || reqPath === '/' || !reqPath.startsWith('/api/')) {
            const prefix = req.headers['x-forwarded-prefix'] || '';
            return res.redirect(prefix + '/login.html');
        }
        return res.status(401).json({ error: '無效或已過期的憑證，請重新登入' });
    }

    req.user = decoded;
    next();
}

// ============================================
// 導出
// ============================================
module.exports = {
    hashPassword,
    verifyPassword,
    signJWT,
    verifyJWT,
    authMiddleware,
    JWT_EXPIRY,
    checkRateLimit: _checkRateLimit,
};
