#!/usr/bin/env python3
"""解除「忽略其他机器人消息」的过滤，让另一条鱼说的话能被处理。

原始条件里 senderIsBot === true 直接 return（丢弃 bot 发的消息）。
本补丁把该判断改为「仅当消息未指向我时才丢弃」：
  - 另一条鱼 @ 我 / 提到 miyu → 处理（能回）
  - 其他无关的 bot 消息 → 仍然丢弃（防刷屏）

幂等：已打过则跳过。
"""
import shutil
import subprocess
import sys
import time
from pathlib import Path

PKG = Path("/home/link/.dsh/profiles/web/node_modules/@xmanrui/dsh-im")
TARGET = PKG / "lib/index.js"
BACKUP_DIR = Path("/home/link/.dsh/im/backup")

# 只改 QQ 通道那处（hasSeen 用 #r / #Q，是 QQ bridge 的特征）
OLD = ('if(!o||!a||t?.senderIsBot===!0||!["c2c","group"].includes(t?.kind)'
       '||this.#r.hasSeen(o)||this.#Q.has(o))return Promise.resolve();')

NEW = ('if(!o||!a||!["c2c","group"].includes(t?.kind)'
       '||this.#r.hasSeen(o)||this.#Q.has(o))return Promise.resolve();'
       'if(t.senderIsBot===!0&&!Dg(t))return Promise.resolve();')

MARKER = 'if(t.senderIsBot===!0&&!Dg(t))return Promise.resolve();'


def main() -> int:
    if not TARGET.is_file():
        print(f"FAIL: 找不到 {TARGET}")
        return 1
    src = TARGET.read_text(encoding="utf-8")

    if MARKER in src:
        print("SKIP: 已打过")
        return 0

    n = src.count(OLD)
    if n != 1:
        print(f"FAIL: 目标出现 {n} 次（应为 1）")
        return 2

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    bak = BACKUP_DIR / f"index.js.bak-botfilter-{time.strftime('%Y%m%dT%H%M%S')}"
    shutil.copy2(TARGET, bak)
    print(f"BACKUP: {bak}")

    patched = src.replace(OLD, NEW, 1)
    if MARKER not in patched:
        print("FAIL: 替换失败")
        return 3
    TARGET.write_text(patched, encoding="utf-8")
    print("PATCHED")

    r = subprocess.run(["node", "--check", str(TARGET)], capture_output=True, text=True)
    if r.returncode != 0:
        print("FAIL: 语法错误，回滚")
        shutil.copy2(bak, TARGET)
        print(r.stderr[:400])
        return 4
    print("SYNTAX: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
