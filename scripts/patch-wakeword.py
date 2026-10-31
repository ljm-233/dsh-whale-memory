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

# 幂等标记：英文版与中文版任一在场都算打过
MARKERS = ('/\\bmiyu\\b/iu.test', '米鱼', '米魚')

# 兜底锚点：上游把 Dg 的整体写法换掉时，只在函数体开头插一句判断
FUNC_HEAD = 'function Dg(n){'
INJECT = ('if(/\\bmiyu\\b|米鱼|米魚/iu.test(String(n?.content??"")+"\\n"+String(n?.raw?.content??"")))return!0;')


def inject_fallback(src: str) -> int:
    """上游改了 Dg 的写法：不猜整体，只在函数体最前面加一句判断。"""
    if FUNC_HEAD not in src:
        print("FAIL: 连 function Dg(n){ 都找不到，插件结构变了，需要人工看")
        return 2
    out = src.replace(FUNC_HEAD, FUNC_HEAD + INJECT, 1)
    backup(out)
    after = TARGET.read_text(encoding="utf-8")
    if INJECT not in after:
        print("FAIL: 写入后没找到注入内容")
        return 3
    print("PATCHED（兜底方式：函数体开头注入唤醒判断）")
    return 0


def backup(patched: str) -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    bak = BACKUP_DIR / f"dsh-im-index.js.bak-wake-{time.strftime('%Y%m%dT%H%M%S')}"
    if TARGET.is_file():
        shutil.copy2(TARGET, bak)
        print(f"BACKUP: {bak}")
    TARGET.write_text(patched, encoding="utf-8")


def main() -> int:
    if not TARGET.is_file():
        print(f"FAIL: 找不到 {TARGET}")
        return 1

    src = TARGET.read_text(encoding="utf-8")

    if any(m in src for m in MARKERS):
        print("SKIP: 唤醒词已在（英文或中文版），无需重复")
        return 0

    n = src.count(OLD)
    if n == 0:
        return inject_fallback(src)
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
