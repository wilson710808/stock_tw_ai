/**
 * StockAI - 持倉模組
 * 買入、賣出、止損止盈、持倉渲染、交易記錄等
 */
(function() {
    'use strict';
    
    var $ = window.$;
    
    // ===== 買入對話框 =====
    
    /**
     * 顯示買入股票對話框
     * @param {string} tickerPreset - 預填的股票代碼
     * @param {number} pricePreset - 預填的價格
     */
    window.showBuyDialog = function(tickerPreset, pricePreset) {
        var t = tickerPreset || '';
        var p = pricePreset || 0;
        var today = new Date().toISOString().split('T')[0];
        
        window.showModal(
            '<div class="modal-title">📈 新增持倉</div>' +
            '<div class="modal-info">記錄買入的股票持倉</div>' +
            
            '<div class="modal-label">股票代碼</div>' +
            '<input class="modal-input" id="buyTicker" value="' + t + '" placeholder="2330" style="text-transform:uppercase">' +
            
            '<div class="modal-label">買入價格</div>' +
            '<input class="modal-input" type="number" id="buyPrice" step="0.01" value="' + (p ? p.toFixed(2) : '') + '" placeholder="0.00" oninput="updateBuyCost()">' +
            
            '<div class="modal-label">買入股數</div>' +
            '<input class="modal-input" type="number" id="buyShares" min="1" value="1" oninput="updateBuyCost()">' +
            
            '<div class="modal-cost" id="buyCostEst">預估本金: $0.00</div>' +
            
            '<div class="modal-label">買入時間</div>' +
            '<input class="modal-input" type="date" id="buyDate" value="' + today + '">' +
            
            '<div class="modal-label">止損價（選填）</div>' +
            '<input class="modal-input" type="number" id="buySL" step="0.01" placeholder="止損價">' +
            
            '<div class="modal-label">止盈價（選填）</div>' +
            '<input class="modal-input" type="number" id="buyTP" step="0.01" placeholder="止盈價">' +
            
            '<div class="modal-btn-row">' +
            '<button class="modal-btn cancel" onclick="closeModal()">取消</button>' +
            '<button class="modal-btn primary" onclick="doBuy()">確認加倉</button>' +
            '</div>'
        );
    };
    
    // ===== 更新買入成本估算 =====
    
    /**
     * 更新買入成本估算顯示
     */
    window.updateBuyCost = function() {
        var sharesEl = $('buyShares');
        var priceEl = $('buyPrice');
        var costEl = $('buyCostEst');
        
        if (!sharesEl || !priceEl || !costEl) return;
        
        var s = parseInt(sharesEl.value) || 0;
        var pr = parseFloat(priceEl.value) || 0;
        var total = s * pr;
        
        costEl.textContent = '預估本金: ' + window.fmtP(total);
    };
    
    // ===== 執行買入 =====
    
    /**
     * 執行買入操作
     */
    window.doBuy = async function() {
        var tEl = $('buyTicker');
        var pEl = $('buyPrice');
        var sEl = $('buyShares');
        var slEl = $('buySL');
        var tpEl = $('buyTP');
        var dateEl = $('buyDate');
        
        if (!tEl || !pEl || !sEl) return;
        
        var t = tEl.value.trim().toUpperCase();
        var p = parseFloat(pEl.value);
        var s = parseInt(sEl.value);
        var sl = parseFloat(slEl ? slEl.value : '') || 0;
        var tp = parseFloat(tpEl ? tpEl.value : '') || 0;
        var buyDate = dateEl ? dateEl.value : '';
        
        if (!t || !p || p <= 0 || !s || s <= 0) {
            window.showToast('請填寫股票代碼、價格和股數');
            return;
        }
        
        var cost = s * p;
        
        if (window.currentUser) {
            // 服務器模式
            try {
                var body = { ticker: t, shares: s, price: p, stop_loss: sl, take_profit: tp };
                if (buyDate) body.buy_date = buyDate;
                
                var r = await fetch('api/portfolio/buy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                var d = await r.json();
                
                if (d.success) {
                    window.showToast('✅ 已買入 ' + t + ' ' + s + '股 @ ' + window.fmtP(p));
                    window.closeModal();
                    if (window.loadSrvData) await window.loadSrvData();
                    if (window.renderPortfolio) window.renderPortfolio();
                } else {
                    window.showToast(d.error || '買入失敗');
                }
            } catch (e) {
                window.showToast('買入失敗：' + e.message);
            }
        } else {
            // 離線模式
            var exist = window.offPortfolio.find(function(x) { return x.ticker === t; });
            var buyTs = buyDate ? new Date(buyDate + 'T12:00:00').getTime() : Date.now();
            
            if (exist) {
                var ts = exist.shares + s;
                var tc = exist.shares * exist.buyPrice + s * p;
                exist.shares = ts;
                exist.buyPrice = tc / ts;
                exist.transactions = exist.transactions || [];
                exist.transactions.push({ type: 'buy', shares: s, price: p, date: buyTs });
            } else {
                window.offPortfolio.push({
                    ticker: t,
                    shares: s,
                    buyPrice: p,
                    date: buyTs,
                    transactions: [{ type: 'buy', shares: s, price: p, date: buyTs }]
                });
            }
            
            window.saveLS('stock_portfolio', window.offPortfolio);
            
            // 記錄交易
            window.offTx.push({ type: 'buy', ticker: t, shares: s, price: p, cost: cost, date: buyTs });
            window.saveLS('stock_transactions', window.offTx);
            
            window.closeModal();
            if (window.renderPortfolio) window.renderPortfolio();
            window.showToast('✅ 已買入 ' + t + ' ' + s + '股 @ ' + window.fmtP(p));
        }
    };
    
    // ===== 賣出對話框 =====
    
    /**
     * 顯示賣出股票對話框
     * @param {string} t - 股票代碼
     * @param {number} shares - 持股數
     * @param {number} cp - 當前價格
     */
    window.showSellDialog = async function(t, shares, cp) {
        var h = window.gPF().find(function(x) { return x.ticker === t; });
        if (!h) return;
        
        var realShares = window.currentUser ? h.shares : h.shares;
        var avgPrice = window.currentUser ? h.buy_price : h.buyPrice;
        var sl = window.currentUser ? h.stop_loss : h.stopLoss;
        var tp = window.currentUser ? h.take_profit : h.takeProfit;
        
        var html = '<div class="modal-title">📉 賣出 ' + t + '</div>' +
            '<div class="modal-info">持有: ' + realShares + '股 | 成本均價: ' + window.fmtP(avgPrice) + ' | 當前: ' + window.fmtP(cp) + '</div>' +
            '<div class="modal-label">賣出股數（最多 ' + realShares + '）</div>' +
            '<input class="modal-input" type="number" id="sellShares" min="1" max="' + realShares + '" value="' + realShares + '">' +
            '<div class="modal-cost" id="sellRevEst">預估收入: ' + window.fmtP(realShares * cp) + '</div>';
        
        if (sl) {
            html += '<div style="font-size:12px;color:#ef4444;margin-bottom:8px">🛑 止損: ' + window.fmtP(sl) + (cp <= sl ? ' ⚠️已觸及！' : '') + '</div>';
        }
        if (tp) {
            html += '<div style="font-size:12px;color:#22c55e;margin-bottom:8px">🎯 止盈: ' + window.fmtP(tp) + (cp >= tp ? ' ⚠️已觸及！' : '') + '</div>';
        }
        
        html += '<div class="modal-btn-row">' +
            '<button class="modal-btn cancel" onclick="closeModal()">取消</button>' +
            '<button class="modal-btn danger" onclick="doSell(\'' + t + '\')">確認賣出</button>' +
            '</div>';
        
        window.showModal(html);
    };
    
    // ===== 執行賣出 =====
    
    /**
     * 執行賣出操作
     * @param {string} t - 股票代碼
     */
    window.doSell = async function(t) {
        var sEl = $('sellShares');
        if (!sEl) return;
        
        var s = parseInt(sEl.value);
        
        if (!s || s <= 0) {
            window.showToast('無效股數');
            return;
        }
        
        if (window.currentUser) {
            // 服務器模式
            var h = window.srvPortfolio.find(function(x) { return x.ticker === t; });
            if (!h || s > h.shares) {
                window.showToast('無效股數');
                return;
            }
            
            try {
                // 獲取當前價格
                var qr = await fetch('api/quote', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ticker: t })
                });
                var q = await qr.json();
                
                if (!q.success) {
                    window.showToast('無法獲取價格');
                    return;
                }
                
                var r = await fetch('api/portfolio/sell', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ticker: t, shares: s, price: q.price })
                });
                var d = await r.json();
                
                if (d.success) {
                    window.showToast('✅ 已賣出 ' + t + ' ' + s + '股' + (d.profit >= 0 ? ' 賺' : ' 虧') + ' ' + window.fmtP(Math.abs(d.profit)));
                    window.closeModal();
                    if (window.loadSrvData) await window.loadSrvData();
                    if (window.renderPortfolio) window.renderPortfolio();
                } else {
                    window.showToast(d.error);
                }
            } catch (e) {
                window.showToast('賣出失敗');
            }
        } else {
            // 離線模式
            var h = window.offPortfolio.find(function(x) { return x.ticker === t; });
            if (!h || s > h.shares) {
                window.showToast('無效股數');
                return;
            }
            
            h.shares -= s;
            var profit = s * (h.currentPrice || h.buyPrice) - s * h.buyPrice;
            
            if (h.transactions) {
                h.transactions.push({ type: 'sell', shares: s, price: h.currentPrice || h.buyPrice, date: Date.now() });
            }
            
            if (h.shares <= 0) {
                window.offPortfolio = window.offPortfolio.filter(function(x) { return x.ticker !== t; });
            }
            
            window.saveLS('stock_portfolio', window.offPortfolio);
            window.offTx.push({ type: 'sell', ticker: t, shares: s, price: h.currentPrice || h.buyPrice, date: Date.now() });
            window.saveLS('stock_transactions', window.offTx);
            
            window.closeModal();
            if (window.renderPortfolio) window.renderPortfolio();
            window.showToast('✅ 已賣出 ' + t + ' ' + s + '股' + (profit >= 0 ? ' 賺' : ' 虧') + ' ' + window.fmtP(Math.abs(profit)));
        }
    };
    
    // ===== 止損止盈對話框 =====
    
    /**
     * 顯示止損止盈設置對話框
     * @param {string} t - 股票代碼
     * @param {number} cp - 當前價格
     */
    window.showSLTPDialog = function(t, cp) {
        var h = window.gPF().find(function(x) { return x.ticker === t; });
        var sl = h ? (window.currentUser ? h.stop_loss : h.stopLoss) : 0;
        var tp = h ? (window.currentUser ? h.take_profit : h.takeProfit) : 0;
        
        window.showModal(
            '<div class="modal-title">🛑🎯 止損止盈設置 - ' + t + '</div>' +
            '<div class="modal-info">當前價格: ' + window.fmtP(cp) + '</div>' +
            '<div class="modal-label">止損價 (Stop Loss)</div>' +
            '<input class="modal-input" type="number" id="slInput" step="0.01" value="' + (sl || '') + '" placeholder="低於此價自動提醒">' +
            '<div class="modal-label">止盈價 (Take Profit)</div>' +
            '<input class="modal-input" type="number" id="tpInput" step="0.01" value="' + (tp || '') + '" placeholder="高於此價自動提醒">' +
            '<div class="modal-btn-row">' +
            '<button class="modal-btn cancel" onclick="closeModal()">取消</button>' +
            '<button class="modal-btn primary" onclick="saveSLTP(\'' + t + '\')">儲存</button>' +
            '</div>'
        );
    };
    
    /**
     * 保存止損止盈設置
     * @param {string} t - 股票代碼
     */
    window.saveSLTP = async function(t) {
        var slEl = $('slInput');
        var tpEl = $('tpInput');
        
        if (!slEl || !tpEl) return;
        
        var sl = parseFloat(slEl.value) || 0;
        var tp = parseFloat(tpEl.value) || 0;
        
        if (window.currentUser) {
            await fetch('api/portfolio/' + t + '/sltp', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stop_loss: sl, take_profit: tp })
            });
            if (window.loadSrvData) await window.loadSrvData();
        } else {
            var h = window.offPortfolio.find(function(x) { return x.ticker === t; });
            if (h) {
                h.stopLoss = sl;
                h.takeProfit = tp;
                window.saveLS('stock_portfolio', window.offPortfolio);
            }
        }
        
        window.closeModal();
        if (window.renderPortfolio) window.renderPortfolio();
        window.showToast('✅ 止損止盈已設置');
    };
    
    // ===== 持倉頁面渲染 =====
    
    /**
     * 渲染持倉頁面
     */
    window.renderPortfolio = async function() {
        var pf = window.gPF();
        var summaryEl = $('pfSummary');
        var listEl = $('portfolioList');
        
        if (!summaryEl || !listEl) return;
        
        // 空持倉
        if (!pf.length) {
            summaryEl.innerHTML = '<div class="pf-summary-grid">' +
                '<div class="pf-stat"><div class="pf-stat-label">總本金</div><div class="pf-stat-value">$0.00</div></div>' +
                '<div class="pf-stat"><div class="pf-stat-label">總市值</div><div class="pf-stat-value">$0.00</div></div>' +
                '<div class="pf-stat"><div class="pf-stat-label">總損益</div><div class="pf-stat-value">$0.00</div></div>' +
                '<div class="pf-stat"><div class="pf-stat-label">損益比例</div><div class="pf-stat-value">0.00%</div></div>' +
                '</div>';
            listEl.innerHTML = '<div class="empty"><div class="empty-icon">💼</div><div class="empty-text">尚無持倉，點擊「買入股票」新增持倉</div></div>';
            return;
        }
        
        listEl.innerHTML = '<div class="loading show"><div class="spinner"></div></div>';
        
        try {
            // 獲取實時報價
            var tickers = pf.map(function(p) { return window.currentUser ? p.ticker : p.ticker; });
            var quotes = {};
            
            if (tickers.length) {
                var r = await fetch('api/quotes', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tickers: tickers })
                });
                var d = await r.json();
                if (d.quotes) {
                    d.quotes.forEach(function(q) {
                        if (q.success) quotes[q.ticker] = q;
                    });
                }
            }
            
            // 計算持倉統計
            var totalCost = 0, totalValue = 0;
            pf.forEach(function(p) {
                var bp = window.currentUser ? p.buy_price : p.buyPrice;
                var sh = window.currentUser ? p.shares : p.shares;
                totalCost += sh * bp;
                var tk = window.currentUser ? p.ticker : p.ticker;
                totalValue += sh * (quotes[tk] ? quotes[tk].price : bp);
            });
            
            var totalPnL = totalValue - totalCost;
            var totalPnLPct = totalCost > 0 ? (totalPnL / totalCost * 100) : 0;
            
            // 行業分布計算
            var sectorAlloc = {};
            pf.forEach(function(p) {
                var tk = window.currentUser ? p.ticker : p.ticker;
                var sh = window.currentUser ? p.shares : p.shares;
                var bp = window.currentUser ? p.buy_price : p.buyPrice;
                var v = sh * (quotes[tk] ? quotes[tk].price : bp);
                var sector = window.getSector(tk);
                sectorAlloc[sector] = (sectorAlloc[sector] || 0) + v;
            });
            
            // 健康評分計算
            var healthScore = 3;
            var maxRatio = pf.length ? Math.max.apply(null, pf.map(function(p) {
                var tk = window.currentUser ? p.ticker : p.ticker;
                var sh = window.currentUser ? p.shares : p.shares;
                var bp = window.currentUser ? p.buy_price : p.buyPrice;
                return sh * (quotes[tk] ? quotes[tk].price : bp) / totalValue;
            })) : 0;
            
            if (maxRatio < 0.2) healthScore++;
            if (maxRatio < 0.3) healthScore++;
            if (pf.every(function(p) { return window.currentUser ? p.stop_loss : p.stopLoss; })) healthScore++;
            if (pf.length >= 3) healthScore--;
            if (healthScore > 5) healthScore = 5;
            if (healthScore < 1) healthScore = 1;
            
            var healthDesc = '';
            if (healthScore >= 5) healthDesc = '🟢 組合極度均衡，分散風險表現優異，值得保持';
            else if (healthScore >= 4) healthDesc = '🟢 組合分散良好，個股集中度可控，可繼續持有';
            else if (healthScore >= 3) healthDesc = '🟡 組合適中，部分個股佔比偏高，建議關注集中度風險';
            else if (healthScore >= 2) healthDesc = '🟠 組合偏集中，單一股位影響過大，建議適度減碼分散';
            else healthDesc = '🔴 組合高度集中，風險暴露顯著，強烈建議分散持倉';
            
            // 渲染摘要
            var summaryHtml = '<div class="pf-summary-grid">' +
                '<div class="pf-stat"><div class="pf-stat-label">總本金</div><div class="pf-stat-value">' + window.fmtP(totalCost) + '</div></div>' +
                '<div class="pf-stat"><div class="pf-stat-label">總市值</div><div class="pf-stat-value">' + window.fmtP(totalValue) + '</div></div>' +
                '<div class="pf-stat"><div class="pf-stat-label">總損益</div><div class="pf-stat-value ' + (totalPnL >= 0 ? 'up' : 'down') + '">' + window.fmtP(totalPnL) + '</div></div>' +
                '<div class="pf-stat"><div class="pf-stat-label">損益比例</div><div class="pf-stat-value ' + (totalPnL >= 0 ? 'up' : 'down') + '">' + window.fmtPct(totalPnLPct) + '</div></div>' +
                '</div>' +
                '<div style="margin-top:16px"><div style="display:flex;gap:16px;align-items:center">' +
                '<div style="flex-shrink:0"><canvas id="pieChart" width="160" height="160"></canvas></div>' +
                '<div style="flex:1"><div style="font-size:12px;opacity:.8;margin-bottom:8px">持倉佔比</div>' +
                pf.map(function(p) {
                    var tk = window.currentUser ? p.ticker : p.ticker;
                    var sh = window.currentUser ? p.shares : p.shares;
                    var bp = window.currentUser ? p.buy_price : p.buyPrice;
                    var v = sh * (quotes[tk] ? quotes[tk].price : bp);
                    var pct = totalValue > 0 ? (v / totalValue * 100) : 0;
                    var sector = window.getSector(tk);
                    var color = window.SCOLORS ? window.SCOLORS[sector] : '#9ca3af';
                    return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px">' +
                        '<span class="sector-dot" style="background:' + color + '"></span>' +
                        '<span>' + tk + '</span>' +
                        '<span style="opacity:.7">' + pct.toFixed(1) + '%</span></div>';
                }).join('') +
                '</div></div></div>' +
                '<div class="health-score" style="margin-top:12px;font-size:12px;opacity:.9">持倉健康度: ' + '★'.repeat(healthScore) + '☆'.repeat(5 - healthScore) +
                '<div style="margin-top:4px;font-size:11px;opacity:.8;line-height:1.4">' + healthDesc + '</div></div>';
            
            summaryEl.innerHTML = summaryHtml;
            
            // 渲染持倉列表
            listEl.innerHTML = pf.map(function(p) {
                var tk = window.currentUser ? p.ticker : p.ticker;
                var sh = window.currentUser ? p.shares : p.shares;
                var bp = window.currentUser ? p.buy_price : p.buyPrice;
                var q = quotes[tk];
                var cp = q ? q.price : bp;
                var cost = sh * bp;
                var value = sh * cp;
                var profit = value - cost;
                var profitPct = cost > 0 ? (profit / cost * 100) : 0;
                var ratio = totalValue > 0 ? (value / totalValue * 100) : 0;
                var up = profit >= 0;
                // 當日漲跌幅一律透過 window.dailyChange 以「現價 - 前一交易日收盤」計算，保證持倉/自選/分析三處完全一致。
                var dc = window.dailyChange(q);
                var chg = dc.change;
                var chgPct = dc.changePercent;
                var sl = window.currentUser ? p.stop_loss : p.stopLoss;
                var tp = window.currentUser ? p.take_profit : p.takeProfit;
                var note = window.currentUser ? p.note : (p.note || '');
                var holdDays = window.fmtDays(window.currentUser ? p.created_at : p.date);
                var sector = window.getSector(tk);
                var sectorColor = window.SCOLORS ? window.SCOLORS[sector] : '#9ca3af';
                
                return '<div class="holding-card">' +
                    '<div class="holding-header">' +
                    '<div>' +
                    '<div class="holding-ticker">' + tk + ' <span class="wl-group-tag" style="background:' + sectorColor + '22;color:' + sectorColor + '">' + sector + '</span></div>' +
                    '<div class="holding-name">' + (q ? q.name : '') + '</div>' +
                    '</div>' +
                    '<div style="text-align:right">' +
                    '<div class="holding-current" style="color:' + window.udC(chg) + '">' + window.fmtP(cp) + '</div>' +
                    '<div class="holding-change" style="color:' + window.udC(chg) + '">' + window.udA(chg) + ' ' + window.fmtPct(chgPct) + '</div>' +
                    '</div>' +
                    '</div>' +
                    '<div class="holding-details">' +
                    '<div><div class="holding-detail-label">持股數</div><div class="holding-detail-value">' + sh + '</div></div>' +
                    '<div><div class="holding-detail-label">成本均價</div><div class="holding-detail-value">' + window.fmtP(bp) + '</div></div>' +
                    '<div><div class="holding-detail-label">持倉佔比</div><div class="holding-detail-value">' + ratio.toFixed(1) + '%' + (ratio > 40 ? ' 🔴' : ratio > 25 ? ' ⚠️' : '') + '</div></div>' +
                    '<div><div class="holding-detail-label">買入時間</div><div class="holding-detail-value" style="font-size:10px">' + new Date(window.currentUser ? p.created_at : p.date).toLocaleDateString('zh-TW', { year: 'numeric', month: 'short', day: 'numeric' }) + '</div></div>' +
                    '<div><div class="holding-detail-label">持有天數</div><div class="holding-detail-value" style="color:' + (parseInt(holdDays) < 30 ? '#f59e0b' : parseInt(holdDays) < 180 ? '#3b82f6' : '#22c55e') + '">' + holdDays + '</div></div>' +
                    '<div><div class="holding-detail-label">成本總額</div><div class="holding-detail-value">' + window.fmtP(cost) + '</div></div>' +
                    '<div><div class="holding-detail-label">損益</div><div class="holding-detail-value holding-pnl" style="color:' + window.udC(profit) + '">' + (up ? '+' : '') + window.fmtP(profit) + ' (' + window.fmtPct(profitPct) + ')</div></div>' +
                    '</div>' +
                    (ratio > 25 ? '<div class="risk-warn ' + (ratio > 40 ? 'high' : 'mid') + '">' + (ratio > 40 ? '🔴 高度集中風險 (>40%)' : '⚠️ 集中度偏高 (>25%)') + '</div>' : '') +
                    (sl ? '<span class="sl-tp-tag sl-tag">🛑 SL ' + window.fmtP(sl) + (cp <= sl ? ' ⚠️觸及' : '') + '</span>' : '') +
                    (tp ? '<span class="sl-tp-tag tp-tag">🎯 TP ' + window.fmtP(tp) + (cp >= tp ? ' ⚠️觸及' : '') + '</span>' : '') +
                    (note ? '<div style="font-size:11px;color:#6b7280;margin-top:6px;font-style:italic">📝 ' + note + '</div>' : '') +
                    '<div class="holding-actions">' +
                    '<button class="h-btn analyze" onclick="quickAnalyze(\'' + tk + '\')">🎯 分析</button>' +
                    '<button class="h-btn buy" onclick="showBuyDialog(\'' + tk + '\',' + cp + ')">📈 加碼</button>' +
                    '<button class="h-btn sell" onclick="showSellDialog(\'' + tk + '\',' + sh + ',' + cp + ')">📉 賣出</button>' +
                    '<button class="h-btn" onclick="showSLTPDialog(\'' + tk + '\',' + cp + ')">🛑🎯 止損止盈</button>' +
                    '<button class="h-btn" onclick="showHoldingNote(\'' + tk + '\')">📝 備註</button>' +
                    '</div></div>';
            }).join('');
            
            // 延遲渲染餅圖
            setTimeout(function() { window.renderPieChart(pf, quotes, totalValue); }, 150);
            
        } catch (e) {
            listEl.innerHTML = '<div class="empty"><div class="empty-icon">❌</div><div class="empty-text">載入失敗：' + e.message + '</div></div>';
        }
    };
    
    // ===== 備註功能 =====
    
    /**
     * 顯示持倉備註對話框
     * @param {string} t - 股票代碼
     */
    window.showHoldingNote = function(t) {
        var h = window.gPF().find(function(x) { return x.ticker === t; });
        if (!h) return;
        
        var note = window.currentUser ? h.note : (h.note || '');
        
        window.showModal(
            '<div class="modal-title">📝 ' + t + ' 投資備註</div>' +
            '<div class="modal-label">買入理由 / 後續計劃</div>' +
            '<textarea class="modal-input" id="holdingNoteTA" rows="3" style="resize:vertical">' + note + '</textarea>' +
            '<div class="modal-btn-row">' +
            '<button class="modal-btn cancel" onclick="closeModal()">取消</button>' +
            '<button class="modal-btn primary" onclick="saveHoldingNote(\'' + t + '\')">儲存</button>' +
            '</div>'
        );
    };
    
    /**
     * 保存持倉備註
     * @param {string} t - 股票代碼
     */
    window.saveHoldingNote = async function(t) {
        var noteEl = $('holdingNoteTA');
        if (!noteEl) return;
        
        var note = noteEl.value.trim();
        
        if (window.currentUser) {
            await fetch('api/portfolio/' + t + '/note', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ note: note })
            });
            if (window.loadSrvData) await window.loadSrvData();
        } else {
            var h = window.offPortfolio.find(function(x) { return x.ticker === t; });
            if (h) {
                h.note = note;
                window.saveLS('stock_portfolio', window.offPortfolio);
            }
        }
        
        window.closeModal();
        if (window.renderPortfolio) window.renderPortfolio();
        window.showToast('備註已儲存');
    };
    
    // ===== 圖表渲染 =====
    
    /**
     * 渲染持倉餅圖
     * @param {Array} pf - 持倉數組
     * @param {Object} quotes - 報價映射
     * @param {number} totalValue - 總市值
     */
    window.renderPieChart = function(pf, quotes, totalValue) {
        var canvas = document.getElementById('pieChart');
        if (!canvas || typeof Chart === 'undefined') return;
        
        if (window.pieChartInstance) {
            window.pieChartInstance.destroy();
        }
        
        var colors = ['#3b82f6', '#f59e0b', '#22c55e', '#8b5cf6', '#ec4899', '#f97316', '#06b6d4', '#84cc16', '#a855f7', '#64748b', '#ef4444', '#14b8a6'];
        var labels = [], data = [], bgColors = [];
        
        pf.forEach(function(p, i) {
            var tk = window.currentUser ? p.ticker : p.ticker;
            var sh = window.currentUser ? p.shares : p.shares;
            var bp = window.currentUser ? p.buy_price : p.buyPrice;
            var v = sh * (quotes[tk] ? quotes[tk].price : bp);
            labels.push(tk);
            data.push(v);
            bgColors.push(colors[i % colors.length]);
        });
        
        window.pieChartInstance = new Chart(canvas, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: bgColors,
                    borderWidth: 0,
                    hoverOffset: 6
                }]
            },
            options: {
                responsive: false,
                cutout: '55%',
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(ctx) {
                                var pct = totalValue > 0 ? (ctx.parsed / totalValue * 100) : 0;
                                return ctx.label + ': ' + window.fmtP(ctx.parsed) + ' (' + pct.toFixed(1) + '%)';
                            }
                        }
                    }
                }
            }
        });
    };
    
    // ===== AI 組合分析 =====
    
    /**
     * 對全部持倉進行 AI 分析
     */
    window.analyzePortfolioAll = async function() {
        var pf = window.gPF();
        if (!pf.length) {
            window.showToast('尚無持倉');
            return;
        }
        
        var list = $('portfolioList');
        if (!list) return;
        
        // 添加載入指示器
        list.innerHTML += '<div class="loading show" id="pfAILoading">' +
            '<div class="spinner"></div>' +
            '<div style="text-align:center;padding:16px;color:var(--text-secondary)">🤖 AI 正在獲取即時報價並分析持倉...</div></div>';
        
        try {
            var tickers = pf.map(function(p) { return window.currentUser ? p.ticker : p.ticker; });
            
            // 獲取報價
            var qr = await fetch('api/quotes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tickers: tickers })
            });
            var qd = await qr.json();
            var quotes = {};
            if (qd.success && Array.isArray(qd.quotes)) {
                qd.quotes.forEach(function(q) { if (q && q.success) quotes[q.ticker] = q; });
            }
            
            // 計算持倉明細
            var totalValue = 0, totalCost = 0;
            var details = pf.map(function(p) {
                var tk = window.currentUser ? p.ticker : p.ticker;
                var sh = window.currentUser ? p.shares : p.shares;
                var bp = window.currentUser ? p.buy_price : p.buyPrice;
                var cp = quotes[tk] ? quotes[tk].price : bp;
                var mv = sh * cp;
                var cost = sh * bp;
                var pnl = mv - cost;
                var pnlPct = cost > 0 ? (pnl / cost * 100) : 0;
                totalValue += mv;
                totalCost += cost;
                return { ticker: tk, shares: sh, bp: bp, cp: cp, mv: mv, cost: cost, pnl: pnl, pnlPct: pnlPct };
            });
            
            var totalPnL = totalValue - totalCost;
            var totalPnLPct = totalCost > 0 ? (totalPnL / totalCost * 100) : 0;
            
            // 生成分析摘要
            var summary = '持倉組合明細（基於即時報價）：\n\n';
            summary += '總本金：$' + totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '\n';
            summary += '總市值：$' + totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '\n';
            summary += '總損益：$' + totalPnL.toFixed(2) + ' (' + (totalPnLPct >= 0 ? '+' : '') + totalPnLPct.toFixed(2) + '%)\n\n';
            summary += '| 股票 | 持股 | 成本均價 | 現價 | 本金 | 市值 | 佔比 | 損益金額 | 損益比例 |\n';
            summary += '|------|------|----------|------|------|------|------|----------|----------|\n';
            
            details.sort(function(a, b) { return b.mv - a.mv; }).forEach(function(d) {
                var w = totalValue > 0 ? (d.mv / totalValue * 100) : 0;
                summary += '| ' + d.ticker + ' | ' + d.shares + '股 | $' + d.bp.toFixed(2) + ' | $' + d.cp.toFixed(2) + ' | $' + d.cost.toFixed(2) + ' | $' + d.mv.toFixed(2) + ' | ' + w.toFixed(1) + '% | $' + d.pnl.toFixed(2) + ' | ' + (d.pnlPct >= 0 ? '+' : '') + d.pnlPct.toFixed(2) + '% |\n';
            });
            
            summary += '\n請基於以上**真實市值佔比數據**進行分析，重點關注：\n';
            summary += '1. 個股佔比是否合理（單股>30%屬過度集中）\n';
            summary += '2. 行業集中度風險\n';
            summary += '3. 具體加倉/減倉/提倉建議\n';
            summary += '4. 是否需要新增新的個股標的以分散風險\n';
            summary += '5. 組合整體風險評估和優化方向\n';
            summary += '6. 請在最後提供一段總結，明確指出每支個股的加倉/減倉/提倉/新增建議';
            
            // 執行分析
            var r = await fetch('api/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticker: tickers.join(','), type: 'portfolio', question: summary })
            });
            var d = await r.json();
            
            var ld = document.getElementById('pfAILoading');
            if (ld) ld.remove();
            
            if (d.success) {
                list.innerHTML = '<div class="result-card" style="border-left:4px solid var(--accent)">' +
                    '<div class="result-title">🤖 AI 持倉組合分析</div>' +
                    '<div class="result-content markdown-body">' + window.renderMarkdown(d.content) + '</div></div>' + list.innerHTML;
            } else {
                window.showToast('分析失敗：' + (d.error || '未知'));
            }
            
        } catch (e) {
            var ld = document.getElementById('pfAILoading');
            if (ld) ld.remove();
            window.showToast('AI 分析服務暫時不可用');
        }
    };
    
    // ===== 交易記錄面板 =====
    
    /**
     * 切換交易記錄面板
     */
    window.toggleTxPanel = function() {
        var panel = $('txPanel');
        var overlay = $('txOverlay');
        if (!panel || !overlay) return;
        
        panel.classList.toggle('open');
        overlay.classList.toggle('open');
        
        if (panel.classList.contains('open')) {
            window.renderTxPanel();
        }
    };
    
    /**
     * 渲染交易記錄面板
     */
    window.renderTxPanel = function() {
        var body = $('txPanelBody');
        if (!body) return;
        
        var tx = window.gTx();
        
        if (!tx.length) {
            body.innerHTML = '<div class="empty"><div class="empty-icon">📋</div><div class="empty-text">尚無交易記錄</div></div>';
            return;
        }
        
        body.innerHTML = tx.slice(0, 100).map(function(t) {
            var typeClass = t.type;
            var typeLabel = t.type === 'buy' ? '買入' : t.type === 'sell' ? '賣出' : t.type === 'dividend' ? '股息' : '存入';
            
            return '<div class="tx-item">' +
                '<span class="tx-type ' + typeClass + '">' + typeLabel + '</span>' +
                '<div class="tx-info">' +
                '<div class="tx-ticker">' + (t.ticker || '') + '</div>' +
                '<div class="tx-detail">' + window.fmtD(t.date) + (t.shares ? ' · ' + t.shares + '股' : '') + '</div>' +
                '</div>' +
                '<div class="tx-amount" style="color:' + window.udC(t.type === 'buy' ? -1 : 1) + '">' +
                window.fmtP(t.cost || (t.shares * t.price)) + '</div></div>';
        }).join('');
    };
    
    // ===== 快捷買入對話框（用於推薦頁） =====
    
    /**
     * 顯示快捷買入對話框（用於推薦頁）
     * @param {string} ticker - 股票代碼
     * @param {number} price - 價格
     */
    window.showBuyDialogFor = function(ticker, price) {
        window.showBuyDialog(ticker, price);
    };
    
})();
