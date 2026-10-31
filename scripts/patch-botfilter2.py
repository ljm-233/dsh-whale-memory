#!/usr/bin/env python3
"""第二道 bot 过滤：让指向我的 bot 消息也能进入处理流程。

qq-bridge.mjs #process 里：
    if (!messageId || !sender || message.senderIsBot === true) return;
本补丁改为：仅当消息没有指向我（!Dg(t)）时才丢弃。

幂等。
"""
import shutil
import subprocess
import sys
import time
from pathlib import Path

PKG = Path("/home/link/.dsh/profiles/web/node_modules/@xmanrui/dsh-im")
TARGET = PKG / "lib/index.js"
BACKUP_DIR = Path("/home/link/.dsh/im/backup")

# 特征：#process 里 A=messageId, r=senderId, 后面跟 this.#r.hasSeen(A)
OLD = 'if(!A||!r||t.senderIsBot===!0||!["c2c","group"].includes(t.kind))return;'
NEW = ('if(!A||!r||!["c2c","group"].includes(t.kind))return;'
       'if(t.senderIsBot===!0&&!Dg(t))return;')

MARKER = 'if(t.senderIsBot===!0&&!Dg(t))return;'


def main() -> int:
    src = TARGET.read_text(encoding="utf-8")

    # 第一道补丁已含同样 marker，要区分位置：统计出现次数
    already = src.count(MARKER)
    old_n = src.count(OLD)
    print(f"marker 现有 {already} 处；目标 OLD 出现 {old_n} 次")

    if old_n == 0:
        print("SKIP: 目标已不存在（可能已打过）")
        return 0
    if old_n != 1:
        print(f"FAIL: OLD 出现 {old_n} 次（应为 1），中止")
        return 2

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    bak = BACKUP_DIR / f"index.js.bak-botfilter2-{time.strftime('%Y%m%dT%H%M%S')}"
    shutil.copy2(TARGET, bak)
    print(f"BACKUP: {bak}")

    patched = src.replace(OLD, NEW, 1)
    if patched.count(MARKER) != already + 1:
        print("FAIL: 替换后 marker 数不符")
        return 3
    TARGET.write_text(patched, encoding="utf-8")
    print("PATCHED")

    r = subprocess.run(["node", "--check", str(TARGET)], capture_output=True, text=True)
    if r.returncode != 0:
        shutil.copy2(bak, TARGET)
        print("FAIL: 语法错误，已回滚\n", r.stderr[:400])
        return 4
    print("SYNTAX: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
