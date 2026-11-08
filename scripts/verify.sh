#!/usr/bin/env bash
# 说「改好了」之前必须先跑这个。
#
# 2026-11-09 立的：今天七次重启，全是因为我拿「本地测试绿了」当「功能通了」。
# 这个脚本把该验的四层一次跑完，任何一层红就不许报好。
#   1 能不能加载   2 端点通不通   3 工具在不在   4 测试绿不绿
set -u
cd "$(dirname "$0")/.." || exit 1
fail=0
say() { printf '%s\n' "$*"; }

say "── 1/4 加载 ──"
if node -e "import('./lib/index.mjs').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})" 2>/dev/null; then
  say "  OK  lib/index.mjs 能加载"
else
  say "  FAIL 加载不了"; fail=1
fi

say "── 2/4 端点 ──"
for p in status selfcheck mood; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:3080/dsh-whale-memory/$p" 2>/dev/null)
  if [ "$code" = "200" ]; then say "  OK  /$p 200"; else say "  FAIL /$p $code（宿主没起或插件没挂上）"; fail=1; fi
done

say "── 3/4 工具 ──"
tools=$(curl -s --max-time 5 http://127.0.0.1:3080/dsh-whale-memory/selfcheck 2>/dev/null | head -c 400)
if [ -n "$tools" ]; then say "  OK  selfcheck 有返回"; else say "  FAIL selfcheck 空"; fail=1; fi

say "── 4/4 测试 ──"
pass=0; bad=0; names=""
for t in tests/test-*.mjs; do
  if node "$t" >/dev/null 2>&1; then pass=$((pass+1)); else bad=$((bad+1)); names="$names $(basename "$t")"; fi
done
say "  $pass 过 / $bad 挂$names"
[ "$bad" -gt 0 ] && fail=1

say ""
if [ "$fail" -eq 0 ]; then say "全绿。可以说「改好了」，并附上这份输出。"; else say "有红。不许说改好了。"; fi
exit "$fail"
