/**
 * StockAI - 初始化模組
 * 頁面載入時的事件綁定、定時任務、版本同步等
 */
(function() {
    'use strict';
    
    var $ = window.$;
    
    // ===== 全局錯誤處理 =====
    
    window.onerror = function(m, s, l) {
        console.error('JS Error:', m, 'Line:', l);
        return false;
    };
    
    // ===== DOM 載入後初始化 =====
    
    document.addEventListener('DOMContentLoaded', function() {
        
        // ===== 版本號同步 =====
        
        (async function() {
            try {
                var r = await fetch('api/version');
                var d = await r.json();
                if (d && d.success && d.version) {
                    var tag = document.getElementById('appVersionTag');
                    if (tag) {
                        tag.textContent = 'v' + d.version;
                        tag.title = (d.name || 'Stock AI') + ' v' + d.version;
                    }
                }
            } catch (e) {
                // 靜默：保留 HTML 內預設版本號
            }
        })();

        // ===== 動態創建 recommendPage（如果不存在） =====

        (function() {
            if (!document.getElementById('recommendPage')) {
                var el = document.createElement('main');
                el.id = 'recommendPage';
                el.className = 'main page';
                el.innerHTML = '<div class="section-header" style="margin-bottom:16px"><h2 class="section-title">🎯 板塊推薦</h2></div>' +
                    '<div style="background:#E8F5E9;padding:14px;border-radius:12px;margin-bottom:16px;font-size:13px;color:#1B5E20;line-height:1.6">按行業板塊精選的績優美股，勾選後可單個或批量分析。</div>' +
                    '<div id="recommendActions" style="display:none;flex-wrap:wrap;gap:10px;margin-bottom:16px">' +
                    '<button class="action-btn secondary" onclick="analyzeSelected()">🎯 分析選中的</button>' +
                    '<button class="action-btn primary" onclick="analyzeAll()">🤖 全部分析</button>' +
                    '<button class="action-btn secondary" onclick="clearSelection()">🔄 清空選擇</button></div>' +
                    '<div id="recommendList"></div>';
                document.body.appendChild(el);
            }
        })();
        
        // ===== 搜索功能事件 =====
        
        var tickerInput = $('tickerInput');
        var searchBtn = $('searchBtn');
        
        if (searchBtn && window.analyze) {
            searchBtn.onclick = window.analyze;
        }
        
        if (tickerInput) {
            tickerInput.onkeypress = function(e) {
                if (e.key === 'Enter' && window.analyze) {
                    window.analyze();
                }
            };
        }
        
        // ===== 聊天功能事件 =====
        
        var chatSend = $('chatSend');
        var chatInput = $('chatInput');
        
        if (chatSend && window.sendChat) {
            chatSend.onclick = window.sendChat;
        }
        
        if (chatInput) {
            chatInput.onkeypress = function(e) {
                if (e.key === 'Enter' && window.sendChat) {
                    window.sendChat();
                }
            };
        }
        
        // ===== 底部導航事件 =====
        
        document.querySelectorAll('.nav-item').forEach(function(btn) {
            btn.onclick = function() {
                var page = btn.dataset.page;
                if (page && window.showPage) {
                    window.showPage(page);
                }
            };
        });
        
        // ===== 快捷晶片點擊 =====
        
        document.querySelectorAll('.chip').forEach(function(chip) {
            chip.onclick = function() {
                var ticker = chip.dataset.ticker;
                if (ticker && tickerInput) {
                    tickerInput.value = ticker;
                    if (window.analyze) window.analyze();
                }
            };
        });
        
        // ===== 自選頁面輸入框回車 =====
        
        var wlInput = $('wlTickerInput');
        if (wlInput) {
            wlInput.onkeypress = function(e) {
                if (e.key === 'Enter' && window.addToWatchlistDirect) {
                    window.addToWatchlistDirect();
                }
            };
        }
        
        // ===== 持倉頁面進入時刷新 =====
        
        var pfPage = $('portfolioPage');
        if (pfPage && window.renderPortfolio) {
            var obs = new MutationObserver(function() {
                if (pfPage.classList.contains('active')) {
                    window.renderPortfolio();
                }
            });
            obs.observe(pfPage, { attributes: true, attributeFilter: ['class'] });
        }
        
        // ===== 初始化市場指數 =====
        
        if (window.loadMarketIndices) {
            window.loadMarketIndices();
            // 每 5 分鐘刷新
            setInterval(window.loadMarketIndices, 300000);
        }
        
        // ===== 初始化價格提醒檢查 =====
        
        if (window.checkPriceAlerts) {
            setInterval(window.checkPriceAlerts, 60000);
            // 10 秒後首次檢查
            setTimeout(window.checkPriceAlerts, 10000);
        }
        
        // ===== 渲染初始歷史記錄 =====
        
        if (window.renderHistory) {
            window.renderHistory();
        }
        
        // ===== 檢查認證狀態 =====
        
        if (window.checkAuth) {
            window.checkAuth();
        }
        
        // ===== 處理 sessionStorage 中的待分析股票 =====
        
        var pendingTicker = sessionStorage.getItem('pendingTicker');
        if (pendingTicker) {
            sessionStorage.removeItem('pendingTicker');
            if (tickerInput) tickerInput.value = pendingTicker;
            if (window.analyze) {
                setTimeout(window.analyze, 100);
            }
        }
        
    });
    
    // ===== 收藏頁面初始化（由 index.html 中的內聯腳本處理） =====
    
    // 此模組負責確保收藏相關函數在 window 上可用
    // 實際渲染邏輯在 index.html 的內聯腳本中
    
    /**
     * 收藏功能包裝函數
     */
    window.showAddFavoriteDialog = window.showAddFavoriteDialog || function() {
        if (!window.lastAnalysisTicker) {
            window.showToast('請先分析股票');
            return;
        }
        window.showModal(
            '<div class="modal-title">📚 收藏分析</div>' +
            '<div class="modal-label">股票</div>' +
            '<input class="modal-input" value="' + window.lastAnalysisTicker + '" disabled>' +
            '<div class="modal-label">備註（選填）</div>' +
            '<input class="modal-input" id="favNote" placeholder="添加備註...">' +
            '<div class="modal-btn-row">' +
            '<button class="modal-btn cancel" onclick="closeModal()">取消</button>' +
            '<button class="modal-btn primary" onclick="addFavorite()">收藏</button>' +
            '</div>'
        );
    };
    
    /**
     * 添加收藏
     */
    window.addFavorite = async function() {
        if (!window.lastAnalysisTicker) return;
        
        try {
            var noteEl = $('favNote');
            var note = noteEl ? noteEl.value.trim() : '';
            
            var resp = await fetch('api/favorites/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    analysis_id: window.lastAnalysisId || null,
                    ticker: window.lastAnalysisTicker,
                    type: window.lastAnalysisType || 'overview',
                    content: window.lastAnalysisContent,
                    note: note
                })
            });
            var d = await resp.json();
            
            if (!d.success) throw new Error(d.error || '收藏失敗');
            
            window.closeModal();
            window.showToast('✅ 收藏成功');
            window.lastFavoriteId = d.id || null;
            
        } catch (e) {
            window.showToast('收藏失敗：' + (e.message || ''));
        }
    };
    
    /**
     * 渲染收藏列表
     */
    window.renderFavorites = async function() {
        var container = $('favoritesList');
        if (!container) return;
        
        if (!window.currentUser) {
            container.innerHTML = '<div class="empty"><div class="empty-icon">🔒</div><div class="empty-text">請先登錄</div></div>';
            return;
        }
        
        container.innerHTML = '<div class="loading show"><div class="spinner"></div></div>';
        
        try {
            var viewMode = $('favViewMode') ? $('favViewMode').value : 'sector';
            
            if (viewMode === 'sector') {
                var r = await fetch('api/favorites/grouped');
                var d = await r.json();
                if (!d.success) throw new Error(d.error);
                
                if (!d.groups || !d.groups.length) {
                    container.innerHTML = '<div class="empty"><div class="empty-icon">📚</div><div class="empty-text">還沒有收藏的分析</div></div>';
                    return;
                }
                
                // 按板塊渲染
                var SECTOR_ICONS = {
                    '半導體': '💡', '電子零組件': '🔌', '電腦週邊': '💻', '通信網路': '📡',
                    '金融': '🏦', '傳產': '🏭', '光電': '💡', '其他': '📌'
                };
                
                container.innerHTML = '<div class="fav-summary">共 ' + d.total + ' 筆收藏，分佈於 ' + d.groups.length + ' 個板塊</div>' +
                    d.groups.map(function(g) {
                        var icon = SECTOR_ICONS[g.sector] || '📌';
                        return '<div class="fav-sector-group">' +
                            '<div class="fav-sector-header" onclick="toggleFavSector(this)">' +
                            '<div class="fav-sector-left"><span class="fav-sector-icon">' + icon + '</span><span class="fav-sector-name">' + g.sector + '</span><span class="fav-sector-count">' + g.totalCount + ' 筆</span></div>' +
                            '<span class="fav-sector-arrow">▸</span></div>' +
                            '<div class="fav-sector-body" style="display:none">' +
                            g.tickers.map(function(t) {
                                return '<div class="fav-ticker-group">' +
                                    '<div class="fav-ticker-header" onclick="toggleFavTicker(this)">' +
                                    '<div class="fav-ticker-left"><span class="fav-ticker-badge">' + t.ticker + '</span><span class="fav-ticker-count">' + t.records.length + ' 筆分析</span></div>' +
                                    '<span class="fav-ticker-arrow">▸</span></div>' +
                                    '<div class="fav-ticker-body" style="display:none">' +
                                    t.records.map(function(f) {
                                        var dateStr = f.created_at ? new Date(f.created_at).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
                                        var typeLabel = { overview: '全面分析', technical: '技術面', fundamental: '基本面', compare: '比較', risk: '風險', signal: '信號' }[f.type] || f.type;
                                        var recBadge = f.recommendation ? '<span class="fav-rec-badge">' + f.recommendation + '</span>' : '';
                                        return '<div class="fav-record" onclick="loadFavAnalysis(' + f.id + ',\'' + f.ticker + '\',\'' + f.type + '\')">' +
                                            '<div class="fav-record-left">' +
                                            '<span class="fav-record-type">' + typeLabel + '</span>' + recBadge +
                                            (f.note ? '<span class="fav-record-note">📝 ' + f.note + '</span>' : '') +
                                            '</div>' +
                                            '<div class="fav-record-right">' +
                                            '<span class="fav-record-date">' + dateStr + '</span>' +
                                            '<button class="fav-remove-btn" onclick="event.stopPropagation();removeFavorite(' + f.id + ')">✕</button>' +
                                            '</div></div>';
                                    }).join('') +
                                    '</div></div>';
                            }).join('') +
                            '</div></div>';
                    }).join('');
            } else {
                // 最近模式
                var r = await fetch('api/favorites');
                var d = await r.json();
                if (!d.success) throw new Error(d.error);
                
                if (!d.favorites.length) {
                    container.innerHTML = '<div class="empty"><div class="empty-icon">📚</div><div class="empty-text">還沒有收藏的分析</div></div>';
                    return;
                }
                
                container.innerHTML = '<div class="fav-summary">共 ' + d.favorites.length + ' 筆收藏</div>' +
                    d.favorites.map(function(f) {
                        var dateStr = f.created_at ? new Date(f.created_at).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
                        var typeLabel = { overview: '全面分析', technical: '技術面', fundamental: '基本面', compare: '比較', risk: '風險', signal: '信號' }[f.type] || f.type;
                        var recBadge = f.recommendation ? '<span class="fav-rec-badge">' + f.recommendation + '</span>' : '';
                        return '<div class="wl-card" onclick="loadFavAnalysis(' + f.id + ',\'' + f.ticker + '\',\'' + f.type + '\')">' +
                            '<div class="wl-header"><div><div class="wl-ticker">' + f.ticker + '</div><div class="wl-name">' + typeLabel + ' • ' + dateStr + '</div></div>' + recBadge + '</div>' +
                            (f.note ? '<div class="wl-note"><div class="wl-note-text">📝 ' + f.note + '</div></div>' : '') +
                            '<div class="wl-actions">' +
                            '<button class="wl-btn analyze" onclick="event.stopPropagation();loadFavAnalysis(' + f.id + ',\'' + f.ticker + '\',\'' + f.type + '\')">📄 查看</button>' +
                            '<button class="wl-btn remove" onclick="event.stopPropagation();removeFavorite(' + f.id + ')">✕ 移除</button>' +
                            '</div></div>';
                    }).join('');
            }
        } catch (e) {
            container.innerHTML = '<div class="empty"><div class="empty-icon">❌</div><div class="empty-text">載入失敗</div></div>';
        }
    };
    
    /**
     * 展開/收起收藏板塊
     */
    window.toggleFavSector = function(el) {
        var body = el.nextElementSibling;
        var arrow = el.querySelector('.fav-sector-arrow');
        if (body.style.display === 'none') {
            body.style.display = 'block';
            arrow.textContent = '▾';
        } else {
            body.style.display = 'none';
            arrow.textContent = '▸';
        }
    };
    
    /**
     * 展開/收起收藏個股
     */
    window.toggleFavTicker = function(el) {
        var body = el.nextElementSibling;
        var arrow = el.querySelector('.fav-ticker-arrow');
        if (body.style.display === 'none') {
            body.style.display = 'block';
            arrow.textContent = '▾';
        } else {
            body.style.display = 'none';
            arrow.textContent = '▸';
        }
    };
    
    /**
     * 移除收藏
     */
    window.removeFavorite = async function(id) {
        if (!confirm('確定要刪除此收藏？')) return;
        try {
            await fetch('api/favorites/' + id, { method: 'DELETE' });
            window.showToast('✅ 已移除');
            if (window.renderFavorites) window.renderFavorites();
        } catch (e) {
            window.showToast('移除失敗');
        }
    };
    
    /**
     * 載入收藏的分析
     */
    window.loadFavAnalysis = async function(id, t, type) {
        try {
            var r = await fetch('api/favorites');
            var d = await r.json();
            var fav = d.favorites.find(function(f) { return f.id == id; });
            
            if (fav && fav.content) {
                var tickerInput = $('tickerInput');
                var loading = $('loading');
                var resultView = $('resultView');
                
                if (tickerInput) tickerInput.value = t;
                if (loading) loading.classList.add('show');
                if (resultView) resultView.classList.remove('show');
                
                setTimeout(function() {
                    window.renderResult(t, type || 'overview', fav.content, null);
                    if (loading) loading.classList.remove('show');
                }, 300);
            } else {
                var tickerInput = $('tickerInput');
                if (tickerInput) tickerInput.value = t;
                if (type) window.currentType = type;
                window.showPage('home');
                window.analyze();
            }
        } catch (e) {
            window.showToast('載入失敗');
        }
    };
    
    // ===== 記錄當前分析信息（供收藏功能使用） =====
    
    window.lastAnalysisId = null;
    window.lastAnalysisTicker = null;
    window.lastAnalysisType = null;
    window.lastAnalysisContent = null;
    
    // 攔截 renderResult 保存分析信息
    var _originalRenderResult = window.renderResult;
    window.renderResult = function(t, type, content, q) {
        // 保存信息
        window.lastAnalysisTicker = t;
        window.lastAnalysisType = type;
        window.lastAnalysisContent = content;
        
        // 調用原始函數
        if (_originalRenderResult) {
            _originalRenderResult(t, type, content, q);
        }
    };
    
    // ===== 函數存在性檢查（調試用） =====
    
    window.__checkFunctions = function() {
        var required = [
            'fmtP', 'fmtPct', 'fmtD', 'fmtDays', 'saveLS', 'udC', 'udA', 'getSector',
            'closeModal', 'showModal', 'showPage', 'backToHome',
            'checkAuth', 'renderUserArea', 'showAuthModal', 'doLogin', 'doRegister', 'doLogout',
            'showProfileModal', 'doUpdateProfile', 'showPasswordModal', 'doChangePwd',
            'checkLocalMigration', 'doMigrate', 'clearLocalData',
            'loadSrvData', 'loadAnalysisTypes', 'loadUserInvestCtx', 'renderMarketStats',
            'loadMarketIndices', 'checkPriceAlerts',
            'renderMarkdown', 'analyze', 'renderQuoteOnly', 'renderResult', 'loadChart',
            'renderHistory', 'addToHistory', 'quickAnalyze', 'sendChat',
            'renderWatchlist', 'addToWatchlistDirect', 'removeFromWatchlist', 'toggleWatchlist',
            'showBuyDialog', 'updateBuyCost', 'doBuy', 'showSellDialog', 'doSell',
            'showSLTPDialog', 'saveSLTP', 'toggleTxPanel', 'renderTxPanel',
            'analyzePortfolioAll', 'renderPortfolio', 'showHoldingNote', 'saveHoldingNote',
            'loadRecommend', 'renderRecommend', 'toggleSelect', 'analyzeSelected', 'analyzeAll',
            'gPF', 'gCash', 'gWL', 'gWLI', 'gWLGroups', 'gTx'
        ];
        
        var missing = [];
        required.forEach(function(name) {
            if (typeof window[name] !== 'function') {
                missing.push(name);
            }
        });
        
        if (missing.length) {
            console.warn('Missing functions:', missing);
        } else {
            console.log('All ' + required.length + ' required functions are available.');
        }
        
        return missing.length === 0;
    };
    
    // ===== v2.2.2: 搜尋成功後自動收藏 =====
    
    // 自動收藏開關（預設開，可由用戶關閉）
    window.autoFavoriteEnabled = function() {
        var v = localStorage.getItem('stock_auto_favorite');
        return v === null || v === '1';
    };
    
    // 靜默自動收藏當前分析（不彈 modal、不跳頁；返回結果供驗證）
    window.autoFavoriteCurrent = async function(ticker, type, content) {
        var t = String(ticker || window.lastAnalysisTicker || '').toUpperCase();
        var analysisType = type || window.lastAnalysisType || 'overview';
        var analysisContent = content || window.lastAnalysisContent || '';
        if (!t || !analysisContent) return { success: false, skipped: true, error: '缺少收藏內容' };

        try {
            var resp = await fetch('api/favorites/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    analysis_id: window.lastAnalysisId || null,
                    ticker: t,
                    type: analysisType,
                    content: analysisContent,
                    note: 'auto-collected'
                })
            });
            var d = await resp.json();
            if (d.success) {
                window.lastFavoriteId = d.id || null;
                // 不自動打開收藏頁，避免干擾；不額外 toast，保留「分析完成！」
            } else {
                console.warn('[Favorite] 自動收藏失敗:', d.error || d);
            }
            return d;
        } catch(e) {
            console.warn('[Favorite] 自動收藏異常:', e);
            return { success: false, error: e.message || String(e) };
        }
    };
    
})();
