#!/bin/bash
# update_kline_daily.sh - 每日 13:30 收盘后更新 K 线
# 使用方法: 加入 crontab
# 30 13 * * 1-5 /path/to/update_kline_daily.sh >> /tmp/kline_update.log 2>&1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

echo "=========================================="
echo "K 线更新任务启动: $(date)"
echo "=========================================="

# 推荐股票列表（40 档）
TICKERS=(
  "2330" "2317" "2454" "2303" "2379"   # 半导体
  "2308" "2382" "2324" "2353" "2354"     # 电子零组件
  "2356" "2385" "2498" "3231" "2352"     # 电脑周边
  "2412" "3045" "4904" "3443" "3596"     # 通信网络
  "2881" "2882" "2886" "2812" "2880"     # 金融
  "1301" "1303" "1326" "2105" "2207"     # 传产
  "2409" "2408" "2466" "2355" "3481"     # 光电
  "1476" "1483" "1516" "2371" "3448"     # 其他
)

SUCCESS=0
FAIL=0

for TICKER in "${TICKERS[@]}"; do
  echo "[$(date +%H:%M:%S)] 更新 $TICKER K 线..."
  
  python3 market_data.py "$TICKER" update 2>&1
  
  if [ $? -eq 0 ]; then
    echo "  ✅ $TICKER 更新成功"
    ((SUCCESS++))
  else
    echo "  ❌ $TICKER 更新失败"
    ((FAIL++))
  fi
  
  # 避免 API 频率限制
  sleep 1
done

echo "=========================================="
echo "K 线更新完成: $(date)"
echo "成功: $SUCCESS | 失败: $FAIL"
echo "=========================================="
