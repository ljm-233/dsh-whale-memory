#!/usr/bin/env bash
# 起 dsh 之前先做两道检查：
#   1. 3080 已经在监听 → 说明有实例活着，别再起第二个（第二个会卡在 EADDRINUSE 并可能变 D 状态）
#   2. 端口空着，但有进程捏着 memory.db 不放（D/Z 状态）→ kill -9，否则新实例一开库就是 database is locked
#
# 用法：scripts/start-dsh.sh [dsh web 的参数]
set -u

PORT=${DSH_PORT:-3080}
DB=${WHALE_DB:-$HOME/.dsh/whale-memory/memory.db}
DSH_DIR=${DSH_DIR:-$HOME/deepseek-harness}

listen_pid() {
  ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1
}

pid=$(listen_pid)
if [ -n "${pid:-}" ]; then
  echo "已在运行：pid $pid 正在监听 $PORT，不再起第二个。"
  exit 0
fi

# 端口空着，看看还有谁捏着库
if command -v fuser >/dev/null 2>&1 && [ -f "$DB" ]; then
  for p in $(fuser "$DB" 2>/dev/null); do
    st=$(ps -o stat= -p "$p" 2>/dev/null | tr -d ' ')
    case "$st" in
      D*|Z*)
        echo "僵死进程 pid $p（状态 ${st:-?}）捏着 $DB，kill -9"
        kill -9 "$p" 2>/dev/null
        ;;
      '')
        # 进程已经没了，fuser 的残留，不管
        ;;
      *)
        echo "注意：pid $p（状态 $st）正持有记忆库，若新实例报 database is locked，先手工确认它。"
        ;;
    esac
  done
fi

cd "$DSH_DIR" || { echo "找不到 $DSH_DIR"; exit 1; }
exec node --import tsx/esm apps/cli/src/bin.ts web "$@"
