#!/usr/bin/env python3
"""给 @xmanrui/dsh-im 的 lib/index.js 打唤醒词补丁。

原判定：群消息只有「真 @ / @事件 / 结构化 mentions」才算叫到 bot。
补丁：文本里出现 miyu（不分大小写、整词）也算。

幂等：已打过则不重复打。
"""
import re
import shutil
import sys
import time
from pathlib import Path

PKG = Path("/home/link/.dsh/profiles/web/node_modules/@xmanrui/dsh-im")
TARGET = PKG / "lib/index.js"
BACKUP_DIR = Path("/home/link/.dsh/im/backup")

OLD = ('function Dg(n){return!!n&&(n.kind!=="group"||n[Xoe]===!0'
       '||n.rawEventType==="GROUP_AT_MESSAGE_CREATE"||$oe(n).length>0)}')

NEW = ('function Dg(n){return!!n&&(n.kind!=="group"||n[Xoe]===!0'
       '||n.rawEventType==="GROUP_AT_MESSAGE_CREATE"||$oe(n).length>0'
       '||/\\bmiyu\\b/iu.test(`${n.content??""}\\n${n.raw?.content??""}`))}')

MARKER = '/\\bmiyu\\b/iu.test'


def main() -> int:
    if not TARGET.is_file():
        print(f"FAIL: 找不到 {TARGET}")
        return 1

    src = TARGET.read_text(encoding="utf-8")

    if MARKER in src:
        print("SKIP: 补丁已存在，无需重复")
        return 0

    n = src.count(OLD)
    if n != 1:
        print(f"FAIL: 目标字符串出现 {n} 次（应为 1），可能插件已更新，中止")
        return 2

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    bak = BACKUP_DIR / f"index.js.bak-{time.strftime('%Y%m%dT%H%M%S')}"
    shutil.copy2(TARGET, bak)
    print(f"BACKUP: {bak} ({bak.stat().st_size} bytes)")

    patched = src.replace(OLD, NEW, 1)
    if patched.count(NEW) != 1 or MARKER not in patched:
        print("FAIL: 替换后校验不通过")
        return 3

    TARGET.write_text(patched, encoding="utf-8")
    print(f"PATCHED: {TARGET} ({TARGET.stat().st_size} bytes)")

    # 语法自检
    import subprocess
    r = subprocess.run(["node", "--check", str(TARGET)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print("FAIL: 语法错误，回滚")
        shutil.copy2(bak, TARGET)
        print(r.stderr[:400])
        return 4
    print("SYNTAX: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
