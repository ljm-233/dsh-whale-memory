#!/usr/bin/env python3
"""在已有唤醒词补丁的基础上加上中文名「米鱼」。

原补丁只认 /\bmiyu\b/iu，中文名根本匹配不到——
叫「米鱼」等于没叫。这里把两者并进同一个判定。

幂等：已含中文词则不重复打。
"""
import shutil
import time
from pathlib import Path

PKG = Path("/home/link/.dsh/profiles/web/node_modules/@xmanrui/dsh-im")
TARGET = PKG / "lib/index.js"
BACKUP_DIR = Path("/home/link/.dsh/im/backup")

OLD = '/\\bmiyu\\b/iu.test'
NEW = '/(?:\\bmiyu\\b|米鱼|米魚)/iu.test'
MARKER = '米鱼|米魚'


def main() -> int:
    if not TARGET.is_file():
        print(f"FAIL: 找不到 {TARGET}")
        return 1

    src = TARGET.read_text(encoding="utf-8")

    if MARKER in src:
        print("SKIP: 中文唤醒词已在，无需重复")
        return 0

    n = src.count(OLD)
    if n == 0:
        print("FAIL: 找不到 /\\bmiyu\\b/iu 判定，先跑 patch-wakeword.py")
        return 1

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%S")
    shutil.copy2(TARGET, BACKUP_DIR / f"dsh-im-index.js.bak-wakecn-{stamp}")

    TARGET.write_text(src.replace(OLD, NEW), encoding="utf-8")
    print(f"OK: 替换 {n} 处，唤醒词现在是 miyu / 米鱼")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
