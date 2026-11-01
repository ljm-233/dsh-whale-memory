#!/usr/bin/env python3
"""修 dsh-bili-scroll 的「报告正文被自己砍掉」—— writeRoundNotesToReport 截断事故。

根因（2026-10-31 用会话记录证过）：
  收尾时 writeRoundNotesToReport() 想「去重旧的投递段」，写的是
      const at = cur.indexOf('## 投递'); if (at >= 0) cur = cur.slice(0, at) ...
  —— 它把**投递段之后的一切**都砍了。而模型那一轮是用 duty_report_append 追加到
  **文件末尾**的（工具返回「已追加到 …/out/YYYY-MM-DD.md」），于是正文正好落在
  这一刀之下：写进去了，收尾时被删掉，只剩占位块 + 投递。seen.md / digest 不受影响，
  所以「日志里有结论、判重表有行、报告没正文」。
  只要当天报告里先出现过 `## 投递`（第一轮没写正文时由 stub/writeRoundNotes 建的），
  之后每一轮的正文都会这样丢。

修法：只摘掉旧的「## 投递」这一段（按 `## ` 切段过滤），保留其它段落，再把新块追加到末尾。

用法：
  python3 patch-bili-report-keep-body.py                 # ~/.dsh + profile=web
  python3 patch-bili-report-keep-body.py --profile web
  python3 patch-bili-report-keep-body.py --index /path/to/index.js --self-test
  DSH_HOME=/path/to/.dsh python3 patch-bili-report-keep-body.py

幂等：已打过就跳过；找不到锚点就**不动文件**；node --check 不过自动回滚。
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# 幂等标记（新代码里的那句注释）
MARKER = "别把后面的正文整段砍掉"

# 锚点①（当前 2.x 的写法）
OLD_VARIANTS = [
    re.compile(
        r"(?P<i>[ \t]+)const at = cur\.indexOf\('## 投递'\)\n"
        r"(?P=i)if \(at >= 0\) cur = cur\.slice\(0, at\)\.replace\(/\\s\*\$/u?, ''\) \+ '\\n'\n"
        r"(?P=i)writeFileSync\(f, cur\.replace\(/\\s\*\$/u?, ''\) \+ '\\n' \+ block, 'utf8'\)"
    ),
    # 锚点②：万一以后没人写 `const at`，而是内联 indexOf
    re.compile(
        r"(?P<i>[ \t]+)const at = cur\.indexOf\(\"## 投递\"\)\n"
        r"(?P=i)if \(at >= 0\) cur = cur\.slice\(0, at\)\.trimEnd\(\) \+ '\\n'\n"
        r"(?P=i)writeFileSync\(f, cur\.trimEnd\(\) \+ '\\n' \+ block, 'utf8'\)"
    ),
]

NEW = (
    "{i}// 只摘掉旧的「## 投递」段，别把后面的正文整段砍掉"
    "（模型用 duty_report_append 追加在文件末尾）\n"
    "{i}const secs = cur.split(/^(?=## )/mu)\n"
    "{i}const keep = secs.filter((s) => !/^## 投递(?![：:])/u.test(s))\n"
    "{i}writeFileSync(f, keep.join('').replace(/\\s*$/, '') + '\\n\\n' + block, 'utf8')"
)


def target_of(args) -> Path:
    if args.index:
        return Path(args.index)
    return Path(args.dsh_home) / "profiles" / args.profile / "node_modules" / "dsh-bili-scroll" / "index.js"


def backup_dir_of(args) -> Path:
    return Path(args.dsh_home) / "im" / "backup"


def self_test(index: Path) -> int:
    """把打完补丁的 writeRoundNotesToReport 单独拉出来，拿真实形制的 fixture 跑一遍。"""
    src = index.read_text(encoding="utf-8")
    m = re.search(r"^[ \t]*const writeRoundNotesToReport = \(\) => \{", src, re.M)
    if not m:
        print("SELFTEST FAIL: 找不到 writeRoundNotesToReport")
        return 4
    end = src.find("\n    }\n", m.end())
    if end < 0:
        print("SELFTEST FAIL: 函数结尾认不出来")
        return 4
    fn = src[m.start():end + len("\n    }\n")]

    # 真实形制：占位头 + 投递段在前，模型追加的正文（### BV…）在末尾
    fixture = (
        "# 刷B站 · 2026-10-31 —— 这一轮没写出报告\n\n> ⚠️ 占位块\n\n"
        "## 投递\n\n- 投递：只私信\n\n"
        "## 手动触发 · 首页推荐流\n\n### BV1yEWw63EMV\n- 档位：值得看\n"
        "### BV14nnM6WErB\n- 档位：值得看\n"
    )
    harness = f"""
import {{ readFileSync, writeFileSync, existsSync }} from 'node:fs'
const outDir = process.argv[2]
const cfg = {{ reportLevel: 'full' }}
const roundNotes = ['投递：只私信']
const dayKey = () => '2026-10-31'
const join = (...a) => a.join('/')
const log = () => {{}}
{fn}
writeRoundNotesToReport()
const after = readFileSync(join(outDir, '2026-10-31.md'), 'utf8')
const bodyKept = /^### /mu.test(after) && after.includes('BV14nnM6WErB')
const notes = after.includes('## 投递')
console.log(bodyKept && notes ? 'BODY-KEPT' : 'BODY-LOST')
"""
    with tempfile.TemporaryDirectory() as td:
        (Path(td) / "2026-10-31.md").write_text(fixture, encoding="utf-8")
        f = Path(td) / "t.mjs"
        f.write_text(harness, encoding="utf-8")
        r = subprocess.run(["node", str(f), td], capture_output=True, text=True)
    if r.stdout.strip() != "BODY-KEPT":
        print("SELFTEST FAIL: 打完补丁正文还是会被砍\n" + (r.stdout + r.stderr)[:400])
        return 4
    print("SELFTEST OK: 正文（### 段）在收尾后仍然保留，旧的投递段被换成新的")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default=os.environ.get("DSH_PROFILE", "web"))
    ap.add_argument("--dsh-home", default=os.environ.get("DSH_HOME", str(Path.home() / ".dsh")))
    ap.add_argument("--index", default="", help="直接指定 index.js（验证/临时副本用）")
    ap.add_argument("--self-test", action="store_true", help="只跑行为自检，不改文件路径推导")
    args = ap.parse_args()

    index = target_of(args)
    if not index.is_file():
        print(f"SKIP: 没装 dsh-bili-scroll（{index}）")
        return 0

    src = index.read_text(encoding="utf-8")
    if args.self_test:
        return self_test(index)

    if MARKER in src:
        print("SKIP: 已打过")
        return self_test(index)

    hit = None
    for pat in OLD_VARIANTS:
        m = pat.search(src)
        if m:
            hit = m
            break
    if hit is None:
        print("FAIL: 找不到锚点（插件版本变了）。把 writeRoundNotesToReport 那段发我，我改锚点；文件没动。")
        return 2

    try:
        bd = backup_dir_of(args)
        bd.mkdir(parents=True, exist_ok=True)
        bak = bd / f"bili-scroll-index.js.bak-{time.strftime('%Y%m%dT%H%M%S')}"
        shutil.copy2(index, bak)
        print(f"BACKUP: {bak}")
    except OSError as e:
        print(f"（备份写不了，继续：{e}）")
        bak = None

    out = src[:hit.start()] + NEW.format(i=hit.group("i")) + src[hit.end():]
    index.write_text(out, encoding="utf-8")

    r = subprocess.run(["node", "--check", str(index)], capture_output=True, text=True)
    if r.returncode != 0:
        if bak is not None:
            shutil.copy2(bak, index)
        print("FAIL: 语法没过，已回滚\n" + r.stderr[:300])
        return 3
    print("PATCHED: 收尾只摘旧「## 投递」段，不再砍掉它后面的正文")
    return self_test(index)


if __name__ == "__main__":
    sys.exit(main())
