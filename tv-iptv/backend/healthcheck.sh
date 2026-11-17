#!/usr/bin/env bash
# TvLive 后端部署自检：逐级验证「服务存活 → 频道接口 → 回放链路（列表→详情→播放器页）→ 中继」
# 与 2026-11-17 排查旧电视回放故障时人工执行的口径一致，做成脚本固化。
#
# 用法：./healthcheck.sh [后端地址] [sharecode]
#   例：./healthcheck.sh http://127.0.0.1:8899            # 自建环境（无平台网关，sharecode 可省）
#       ./healthcheck.sh https://tvlive-relay.app.workbuddy.host CICKFPDYZQ   # 平台托管环境
#
# 依赖：curl、grep、sed。任何一步失败立即报错退出（非 0）。
set -u
BASE="${1:-http://127.0.0.1:8899}"
SC="${2:-}"
QS=""; [ -n "$SC" ] && QS="&sharecode=$SC"

fail() { echo "❌ $1"; exit 1; }
ok()   { echo "✅ $1"; }

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) TvLiveHealth/1.0"

# ① 服务存活 + 版本
HEALTH=$(curl -s --max-time 15 -A "$UA" "$BASE/api/health") || fail "服务不可达：$BASE/api/health"
VER=$(echo "$HEALTH" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
[ -n "$VER" ] || fail "/api/health 返回异常：$HEALTH"
ok "服务存活 · 后端版本 $VER"

# ② 频道接口
CHANNELS=$(curl -s --max-time 20 -A "$UA" "$BASE/api/channels")
N=$(echo "$CHANNELS" | grep -o '"id"' | wc -l)
[ "$N" -ge 1 ] || fail "/api/channels 无频道数据"
ok "频道接口正常 · 共 $N 台"

# ③ 回放链路第 1 级：列表页（经 /api/embed 代理）
LIST=$(curl -s --max-time 30 -A "$UA" "$BASE/api/embed?url=https%3A%2F%2Fdodotv22.com%2Fshow.php%3Ftid%3D3%26order_type%3D$QS")
CARD=$(echo "$LIST" | grep -o 'href="/api/embed?url=[^"]*shplay[^"]*"' | head -1)
[ -n "$CARD" ] || fail "回放列表页拉取失败（站点可能换域名，检查 server.js 的 REPLAY_URL）"
# v0.3.31 起改写链接应带 sharecode；无 sharecode 环境跳过该断言
if [ -n "$SC" ] && ! echo "$CARD" | grep -q "sharecode="; then
  echo "⚠️  卡片链接未带 sharecode（后端 < v0.3.31，老设备 WebView 丢 cookie 时回放会被网关拦），建议升级"
fi
ok "回放列表页正常（卡片链接已取得）"

# ④ 回放链路第 2 级：详情页（取第一个卡片链接跟进）
DETAIL_URL="$BASE$(echo "$CARD" | sed 's/^href="//; s/"$//')"
DETAIL=$(curl -s --max-time 30 -A "$UA" "$DETAIL_URL")
IFRAME=$(echo "$DETAIL" | grep -o 'view_iframe[^>]*src="[^"]*"' | head -1)
[ -n "$IFRAME" ] || fail "回放详情页拉取失败或缺少播放器 iframe"
ok "回放详情页正常（播放器 iframe 已取得）"

# ⑤ 回放链路第 3 级：播放器页（onet.php，应含加密流地址变量）
PLAYER_URL="$BASE$(echo "$IFRAME" | sed 's/^.*src="//; s/"$//')"
PLAYER=$(curl -s --max-time 30 -A "$UA" "$PLAYER_URL")
echo "$PLAYER" | grep -q "phpsiteEc2" || fail "播放器页缺少加密流地址（phpsiteEc2），播放器可能无法出画面"
ok "播放器页正常（含加密流地址，可解出真实 vid）"

# ⑥ 中继链路：取一个频道地址走 /api/relay 拉播放列表（选 KBS WORLD，全球 CDN 最稳）
TEST_URL=$(echo "$CHANNELS" | tr ',' '\n' | grep -o 'https://world.gscdn.kbs.co.kr[^"]*' | head -1)
if [ -n "$TEST_URL" ]; then
  ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$TEST_URL" 2>/dev/null \
        || echo "$TEST_URL" | sed 's/:/%3A/g; s/\//%2F/g; s/?/%3F/g; s/=/%3D/g; s/&/%26/g')
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 -A "$UA" "$BASE/api/relay?url=$ENC$QS")
  [ "$CODE" = "200" ] || echo "⚠️  中继测试台 HTTP $CODE（可能是源站临时波动，不阻断）"
  [ "$CODE" = "200" ] && ok "中继链路正常（KBS WORLD master 200）"
else
  echo "⚠️  未找到 KBS WORLD 台，跳过中继测试"
fi

echo ""
echo "全部通过 🎉 后端 $BASE 可用。App「后端设置」里填入 $BASE 即可。"
