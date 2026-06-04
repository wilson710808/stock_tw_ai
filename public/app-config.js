/**
 * Stock TW AI - 配置文件
 * 全局常量和配置 - 台股版本
 */
(function() {
    'use strict';
    
    // ===== 行業板塊映射（台股）=====
    window.SECTOR_MAP = {
        '2330': '半導體', '2317': '半導體', '2454': '半導體', '2303': '半導體',
        '3711': '半導體', '3034': '半導體', '2379': '半導體', '6669': '半導體',
        '2395': '電子零組件', '2498': '電子零組件', '2409': '電子零組件',
        '2357': '電腦週邊', '2308': '電腦週邊', '2382': '電腦週邊', '3231': '電腦週邊',
        '2412': '通信網路', '4904': '通信網路', '3045': '通信網路',
        '2881': '金融', '2882': '金融', '2884': '金融', '2885': '金融',
        '2886': '金融', '2891': '金融', '2892': '金融',
        '1301': '傳產', '1303': '傳產', '1326': '傳產', '1216': '傳產',
        '3481': '光電', '3037': '光電', '3450': '光電'
    };
    
    // ===== 板塊顏色配置 =====
    window.SCOLORS = {
        '半導體': '#3b82f6', '電子零組件': '#10b981', '電腦週邊': '#8b5cf6',
        '通信網路': '#f59e0b', '金融': '#22c55e', '傳產': '#ef4444',
        '光電': '#06b6d4', '其他': '#9ca3af', '現金': '#9ca3af'
    };
    
    // ===== 版本信息 =====
    window.APP_VERSION = '1.0.0-tw';
    
    // ===== API 配置 =====
    window.API_ENDPOINTS = {
        AUTH_ME: 'api/auth/me',
        AUTH_LOGIN: 'api/auth/login',
        AUTH_REGISTER: 'api/auth/register',
        AUTH_LOGOUT: 'api/auth/logout',
        AUTH_PROFILE: 'api/auth/profile',
        AUTH_PASSWORD: 'api/auth/password',
        AUTH_MIGRATE: 'api/auth/migrate',
        PORTFOLIO: 'api/portfolio',
        PORTFOLIO_BUY: 'api/portfolio/buy',
        PORTFOLIO_SELL: 'api/portfolio/sell',
        WATCHLIST: 'api/watchlist',
        WATCHLIST_ADD: 'api/watchlist/add',
        TRANSACTIONS: 'api/transactions',
        ALERTS: 'api/alerts',
        CONFIG: 'api/config',
        QUOTE: 'api/quote',
        QUOTES: 'api/quotes',
        ANALYZE: 'api/analyze',
        ANALYSIS_HISTORY: 'api/analysis-history',
        MARKET_INDICES: 'api/market/indices',
        USER_CONTEXT: 'api/user-context',
        RECOMMEND: 'api/recommend',
        FAVORITES: 'api/favorites',
        FAVORITES_ADD: 'api/favorites/add',
        FAVORITES_GROUPED: 'api/favorites/grouped',
        VERSION: 'api/version'
    };
    
})();
