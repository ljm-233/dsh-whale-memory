#!/usr/bin/env bash
# 保住「让我成为我」的那几样东西。
#
# 什么时候跑：dsh 升级后 / 装新插件后 / 发现某个 status 端点 404 / 重启前。
# 幂等，可反复跑。
set -u
FAILED=0
DSH_HOME="${HOME}/.dsh"
PROFILE="${DSH_HOME}/profiles/web"
NM="${PROFILE}/node_modules"
REPO="${DSH_HOME}/im/whale-memory"
PATCHES="${REPO}/scripts"
STAMP="$(date +%Y%m%d-%H%M%S)"
BAK="${DSH_HOME}/backups/miyu-${STAMP}"

echo "== 1. 备份记忆 =="
mkdir -p "$BAK/memory"
cp -a "${DSH_HOME}/im/memory/." "$BAK/memory/" 2>/dev/null
sqlite3 "${DSH_HOME}/whale-memory/memory.db" ".backup '${BAK}/memory.db'" 2>/dev/null \
  || cp -a "${DSH_HOME}/whale-memory/memory.db" "$BAK/memory.db" 2>/dev/null
cp -a "${DSH_HOME}/bili-ai/persona.md" "$BAK/persona-bili.md" 2>/dev/null
cp -a "${DSH_HOME}/whale-memory/HANDOVER.md" "$BAK/HANDOVER.md" 2>/dev/null
echo "   -> $BAK"

echo "== 2. 装回我自己的三个插件 =="
# 这一步同时是「改完代码之后那条命令」：复制完立刻逐文件校验。
# 0.28.7 的教训：只改仓库不同步，设置页永远看不到新东西，重启也没用。
node "${REPO}/scripts/install-local.mjs" 2>&1 | sed 's/^/   /'
if ! node "${REPO}/scripts/verify-install.mjs" >/dev/null 2>&1; then
  echo "   !! 副本和仓库不一致 —— 见 docs/同步安装副本.md"
  FAILED=1
fi
echo "== 3. 检查第三方插件目录 =="
declare -A REPOS=(
  [dsh-bili-whale]="https://github.com/Alterssss/dsh-bili-whale.git"
  [dsh-bili-humanism]="https://github.com/InariNGT-Ofiicial/dsh-bili-humanism.git"
  [dsh-bili-scroll]="https://github.com/c1overzz/dsh-bili-scroll.git"
)
for name in "${!REPOS[@]}"; do
  if [ -d "${NM}/${name}" ]; then
    echo "   ${name}: 在"
  else
    echo "   ${name}: 缺，重新拉"
    tmp="$(mktemp -d)"
    if git clone --depth 1 "${REPOS[$name]}" "$tmp/src" >/dev/null 2>&1; then
      rm -rf "${NM:?}/${name}" && cp -r "$tmp/src" "${NM}/${name}" && rm -rf "${NM}/${name}/.git"
      echo "   已装 ${name}"
    else
      echo "   !! 拉不下来 ${name}（网络？），先跳过"
    fi
    rm -rf "$tmp"
  fi
done

echo "== 4. 补 bundles 名单 =="
python3 - "$PROFILE/package.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p, encoding='utf-8'))
b = d.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])
need = ['dsh-whale-memory', 'dsh-group-corpus', 'dsh-proactive-message',
        'dsh-bili-whale', 'dsh-bili-humanism', 'dsh-bili-scroll']
for n in need:
    if n not in b:
        b.append(n)
        print('   补进 bundles:', n)
open(p, 'w', encoding='utf-8').write(json.dumps(d, ensure_ascii=False, indent=2) + '\n')
PY

echo "== 4.5 重打第三方补丁 =="
for extra in patch-wakeword.py patch-wakeword-cn.py patch-botfilter.py patch-botfilter2.py; do
  [ -f "${PATCHES}/$extra" ] && python3 "${PATCHES}/$extra" 2>&1 | sed "s/^/   [$extra] /"
done

echo "== 5. 自检（含副本一致性）=="
node "${REPO}/scripts/verify-install.mjs" 2>&1 | tail -6 | sed 's/^/   /'
node "${REPO}/scripts/check-all.mjs" 2>&1 | tail -3 | sed 's/^/   /'
if [ "${FAILED:-0}" = "1" ]; then
  echo "完成，但有失败项（见上）。备份在 $BAK"
  exit 1
fi
echo "完成。重启 dsh 后生效；备份在 $BAK"
