#!/usr/bin/env python3
"""给 dsh-bili-scroll 补一道「报告正文没落盘就补一段」的核对。

跨机器可用：
  python3 patch-bili-report.py                    # 用 ~/.dsh、profile=web
  python3 patch-bili-report.py --profile desktop
  DSH_HOME=/path/to/.dsh python3 patch-bili-report.py

幂等：已打过就跳过。插件版本对不上时只报「找不到插入点」，不动文件。
"""
import argparse
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

MARKER = "backfillReportBodyIfMissing"

FN = '''  const backfillReportBodyIfMissing = () => {
    try {
      if (String(cfg.reportLevel || 'full') === 'off') return
      const f = join(outDir, `${dayKey()}.md`)
      if (!existsSync(f)) return
      if (/^### /mu.test(readFileSync(f, 'utf8'))) return
      let tail = ''
      try { tail = readFileSync(logFile, 'utf8') } catch { return }
      const lines = tail.slice(-6000).split('\\n')
        .filter((l) => /[\\u4e00-\\u9fa5]/u.test(l) && !/^\\s*\\d{4}-\\d{2}-\\d{2}T/u.test(l))
      const body = lines.slice(-12).join('\\n').trim()
      if (body === '') return
      appendFileSync(f, `\\n## 本轮结论（正文没落盘，从日志补）\\n\\n${body}\\n`)
      log('报告正文缺失，已从日志补了一段结论')
    } catch { /* 补不上也不能让收尾挂掉 */ }
  }

'''

# 收尾调用的几种写法（插件小版本不同）
CALL_VARIANTS = [
    "      try { writeRoundNotesToReport() } catch { /* 写不进去也不能炸 */ }",
    "      writeRoundNotesToReport()",
]


def find_call(src):
    for v in CALL_VARIANTS:
        if v in src:
            return v
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default=os.environ.get("DSH_PROFILE", "web"))
    ap.add_argument("--dsh-home", default=os.environ.get("DSH_HOME", str(Path.home() / ".dsh")))
    args = ap.parse_args()

    target = Path(args.dsh_home) / "profiles" / args.profile / "node_modules" / "dsh-bili-scroll" / "index.js"
    if not target.is_file():
        print(f"SKIP: 没装 dsh-bili-scroll（{target}）")
        return 0

    src = target.read_text(encoding="utf-8")
    if MARKER in src:
        print("SKIP: 已打过")
        return 0

    anchor = re.search(r"^\s*const stubReportIfMissing = \(", src, re.M)
    call = find_call(src)
    if anchor is None or call is None:
        print("FAIL: 找不到插入点（插件版本变了）。把 index.js 里收尾那段发给我，我改锚点。")
        return 2

    backup_dir = target.parent.parent.parent.parent / "im" / "backup"
    try:
        backup_dir.mkdir(parents=True, exist_ok=True)
        bak = backup_dir / f"bili-scroll-index.js.bak-{time.strftime('%Y%m%dT%H%M%S')}"
        shutil.copy2(target, bak)
        print(f"BACKUP: {bak}")
    except OSError:
        print("（备份目录写不了，继续）")

    out = src[:anchor.start()] + FN + src[anchor.start():]
    out = out.replace(call, call + "\n      backfillReportBodyIfMissing()   // 正文没落盘就从日志补一段", 1)
    if re.search(r"^\s*import \{[^}]*\bappendFileSync\b", out, re.M) is None:
        out = re.sub(r"(import \{\s*)existsSync", r"\1appendFileSync, existsSync", out, count=1)
    target.write_text(out, encoding="utf-8")

    r = subprocess.run(["node", "--check", str(target)], capture_output=True, text=True)
    if r.returncode != 0:
        if 'bak' in dir():
            shutil.copy2(bak, target)
        print("FAIL: 语法没过，已回滚\n" + r.stderr[:300])
        return 3
    print("PATCHED: 报告正文缺失时会从日志补一段")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
