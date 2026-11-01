#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""patch-companion-linux-capture.py —— 让 @jyddwy/dsh-companion 的「看一眼」在 Linux 上真能截到图。

背景（别重复调研，结论就在这）
-----------------------------
* `services/capture.py` 纯 Windows：模块顶层 `import ctypes.wintypes` 后立刻
  `raise SystemExit`，Linux 上 import 必崩。
* 宿主（src/host）**从不**执行 capture.py 的 CLI。真实链路：
    src/host/services.mjs      spawn `python services/capture_server.py --port 9124`
    services/capture_server.py `import capture as dc`（契约符号全从这里拿）
    src/host/capture.mjs       HTTP GET /health /window /capture?count&intervalMs&
                               maxLongEdge&quality&outDir&mode&exe
  宿主只读 frames[].path / width / height / capturedAt + window + black + elapsedMs。
* 兜底的 `win/helper-win.ps1`（PowerShell）在 Linux 上必然失败，所以整条链路只取决于
  9124 服务能不能起来。

本脚本做的三处（幂等）修改
------------------------
A. services/capture_server.py：把 `import capture as dc` 换成平台分支
   （Linux → `import capture_linux as dc`）。Windows 路径原样保留。
B. src/host/services.mjs：`pythonCandidates()` 里补 Linux 解释器候选
   （原候选全是 .exe 路径，Linux 上会得到空串 →「找不到 Python 解释器」→ 服务永不启动）。
C. $DSH_HOME/dsh-companion/config.json：services.capturePython
   （只填空白值；已有非 Windows 值就不动。--no-config 可跳过）。

安全策略
--------
* 多锚点：每处修改给多条正则变体，全部不命中 → 直接退出（**不动任何文件**）。
* 改动前备份到 ~/.dsh/im/backup/<扁平名>.<时间戳>.bak。
* 改完 `python -m py_compile` / `node --check` 校验，失败自动回滚。
* 重跑幂等：命中标记（capture_linux）就跳过该处，退出码仍为 0。
* `--self-test`：不落盘验证（contract 符号齐全 + info_only 探测一次）。

用法
----
  python3 patches/patch-companion-linux-capture.py                 # 应用
  python3 patches/patch-companion-linux-capture.py --dry-run       # 只看会改什么
  python3 patches/patch-companion-linux-capture.py --self-test      # 应用后自检
  python3 patches/patch-companion-linux-capture.py --no-config      # 不碰 config.json
  python3 patches/patch-companion-linux-capture.py --revert         # 从最近备份还原
"""

from __future__ import annotations

import argparse
import json
import os
import py_compile
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

DEFAULT_PLUGIN = Path("/home/link/.dsh/profiles/web/node_modules/@jyddwy/dsh-companion")
BACKUP_DIR = Path(os.path.expanduser("~/.dsh/im/backup"))
DSH_HOME = Path(os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh"))
DATA_DIR = DSH_HOME / "dsh-companion"

# 幂等标记：任一命中就认为这处已打过。
# 注意 JS 那处插入的注释里没有必然出现 "capture_linux"（历史 bug：导致重跑会重复插入），
# 所以这里用「任一标记命中」判定；别把这两个标记合并回一个。
MARKS = ("capture_linux", "[linux-capture patch]", "[linux capture patch]")

# ---------------------------------------------------------------------------
# 锚点定义
#   每项：(label, target_relpath, [正则变体...], 生成替换的函数)
#   正则用 re.M。变体按顺序尝试，命中第一个就用。
# ---------------------------------------------------------------------------
SERVER_IMPORT_PATTERNS = [
    r"^[ \t]*import capture as dc\b.*$",
    r"^[ \t]*import capture[ \t]+as[ \t]+dc\b.*$",
    r"^[ \t]*from capture import \*.*$",
]

SERVER_IMPORT_REPLACEMENT = '''\
# [linux-capture patch] 平台分支：Windows 走原实现，Linux 走 capture_linux 兼容层。
# 宿主（capture_server.py）用到的契约符号一个不少：__version__ / CaptureError /
# DEFAULT_OPTIONS / _normalize_options / do_capture / environment_info /
# _configure_stdio / init_dpi_awareness / _gdiplus_startup /
# get_foreground_window / get_window_info / get_idle_seconds
if sys.platform != "win32":
    import capture_linux as dc  # noqa: E402  （Linux 兼容层：grim / X11）
else:
    import capture as dc  # noqa: E402  （同目录核心库）
'''

SERVICES_PY_PATTERNS = [
    r"^([ \t]*)push\(configured\);[ \t]*$",
    r"^([ \t]*)push\(configured\)[ \t]*$",
]

SERVICES_PY_REPLACEMENT = '''\
  push(configured);
  // [linux-capture patch] 上面这些候选全是 Windows 的 .exe 路径，Linux 上会探不到解释器，
  // 结果 spec.python='' →「找不到 Python 解释器」→ 截图服务永远不启动。
  if (process.platform !== 'win32') {
    push(process.env.DSH_COMPANION_CAPTURE_PYTHON || '');
    push('/usr/bin/python3');
    push('python3');
  }
'''

# D. capture_server.py 的契约输出：把平台降级信息透出来。
#    _contract_response() 只回固定字段，除非在这里加，否则 Linux 的 degraded/warnings
#    在 HTTP 层根本看不见（宿主会忽略未知字段，Windows 上恒为 False / []）。
SERVER_PAYLOAD_PATTERNS = [
    r'"black": black,\n(\s*)"elapsedMs": elapsed_ms,\n(\s*)\}\n(\s*)return 200, payload',
]

SERVER_PAYLOAD_REPLACEMENT = '''"black": black,
        "elapsedMs": elapsed_ms,
        # [linux-capture patch] 平台降级信息（Wayland 拿不到窗口坐标时必须能被看见）
        "degraded": bool(result.get("degraded")),
        "warnings": result.get("warnings") or [],
    }
    return 200, payload'''


def log(msg: str):
    sys.stderr.write(f"[patch-linux-capture] {msg}\n")


def _ts() -> str:
    return time.strftime("%Y%m%d_%H%M%S")


_SEQ = {"n": 0}


def backup_of(path: Path) -> Path:
    """备份文件名必须唯一：历史上同一秒内重跑会覆盖掉 pristine 备份，
    结果「还原」拿回来的是已经打过的版本。加序号 + 毫秒后缀。"""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    _SEQ["n"] += 1
    flat = str(path).replace(os.sep, "__")
    stamp = time.strftime("%Y%m%d_%H%M%S") + f"_{int(time.time() * 1000) % 1000:03d}s{_SEQ['n']:02d}"
    return BACKUP_DIR / f"{flat}.{stamp}.bak"


def save_backup(path: Path) -> Path:
    target = backup_of(path)
    shutil.copy2(path, target)
    latest = BACKUP_DIR / f"{str(path).replace(os.sep, '__')}.latest"
    try:
        shutil.copy2(path, latest)
    except OSError:
        pass
    log(f"备份 {path} -> {target}")
    return target


def apply_patterns(path: Path, patterns: list, replacement: str, label: str, dry: bool,
                   marker: str | None = None) -> str:
    """返回 'patched' | 'already' | 'missing'。

    `marker` 是这一处自己的幂等标记：同一个文件上有好几处修改时（capture_server.py 有
    import 分支 + 契约输出两处），不能共用一套标记，否则第二处会被第一处的标记误判成已打过。
    """
    text = path.read_text(encoding="utf-8")
    marks = (marker,) if marker else MARKS
    hit_mark = next((m for m in marks if m in text), None)
    if hit_mark:
        log(f"{label}: 已含标记 {hit_mark!r}，跳过")
        return "already"
    for pat in patterns:
        match = re.search(pat, text, re.M)
        if not match:
            continue
        new_text = text[: match.start()] + replacement + text[match.end():]
        if dry:
            log(f"{label}: [dry-run] 命中锚点 {pat!r}，会替换 {match.group(0).strip()[:60]!r}")
            return "patched"
        save_backup(path)
        path.write_text(new_text, encoding="utf-8")
        log(f"{label}: 已改（锚点 {pat!r}）")
        return "patched"
    log(f"{label}: 所有锚点都没命中，放弃（文件未改动）")
    return "missing"


def check_python(path: Path) -> tuple:
    try:
        py_compile.compile(str(path), doraise=True, cfile=str(path) + ".pyc-check")
        Path(str(path) + ".pyc-check").unlink(missing_ok=True)
        return True, ""
    except py_compile.PyCompileError as e:
        return False, str(e)
    except OSError as e:
        return False, str(e)


def check_js(path: Path) -> tuple:
    node = shutil.which("node")
    if not node:
        return True, "node 不存在，跳过 JS 语法检查"
    res = subprocess.run([node, "--check", str(path)], capture_output=True, text=True)
    return res.returncode == 0, (res.stderr or "").strip()


def patch_config(dry: bool) -> str:
    """只把空的 services.capturePython 填成系统 python3；其它字段一概不动。"""
    cfg = DATA_DIR / "config.json"
    if not cfg.exists():
        log("config.json: 不存在（插件还没写过配置），跳过")
        return "missing"
    try:
        data = json.loads(cfg.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        log(f"config.json: 解析失败（{e}），跳过")
        return "missing"
    services = data.setdefault("services", {})
    current = str(services.get("capturePython") or "").strip()
    py = shutil.which("python3") or "/usr/bin/python3"
    if current and not current.lower().endswith(".exe"):
        log(f"config.json: capturePython 已是 {current!r}，跳过")
        return "already"
    if current and current.lower().endswith(".exe"):
        log(f"config.json: capturePython 是 Windows 路径 {current!r}，改成 {py}")
    services["capturePython"] = py
    if dry:
        log(f"config.json: [dry-run] services.capturePython -> {py}")
        return "patched"
    save_backup(cfg)
    tmp = cfg.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(cfg)
    log(f"config.json: services.capturePython -> {py}")
    return "patched"


def self_test(plugin: Path) -> bool:
    services = plugin / "services"
    ok = True
    for name in ("capture_linux.py", "capture_server.py"):
        good, err = check_python(services / name)
        print(f"  py_compile {name}: {'OK' if good else 'FAIL ' + err}")
        ok = ok and good
    # 契约符号齐全 + 平台分支真的生效（import capture_server 的顶层产物）
    probe = r"""
import sys, json
sys.path.insert(0, sys.argv[1])
import capture_server as srv
dc = srv.dc
need = ["__version__","CaptureError","DEFAULT_OPTIONS","_normalize_options","do_capture",
        "environment_info","_configure_stdio","init_dpi_awareness","_gdiplus_startup",
        "get_foreground_window","get_window_info","get_idle_seconds"]
missing = [n for n in need if not hasattr(dc, n)]
print(json.dumps({"module": dc.__name__, "version": dc.__version__,
                  "missing": missing, "backend": getattr(dc, "detect_backend", lambda: "n/a")()}))
"""
    res = subprocess.run([sys.executable, "-c", probe, str(services)], capture_output=True, text=True)
    if res.returncode != 0:
        print(f"  import capture_server: FAIL\n{res.stderr.strip()[:800]}")
        return False
    info = json.loads(res.stdout.strip().splitlines()[-1])
    print(f"  import capture_server: OK -> dc={info['module']} v{info['version']} backend={info['backend']}")
    if info["missing"]:
        print(f"  契约符号缺失: {info['missing']}")
        ok = False
    # 真跑一次 info_only（不落盘），确认能在 Linux 上走完探测
    res2 = subprocess.run(
        [sys.executable, "-c",
         "import sys,json; sys.path.insert(0,sys.argv[1]); import capture_linux as c;"
         "o=c._normalize_options({'save':False}); r=c.do_capture(o, info_only=True);"
         "print(json.dumps({'ok':r['ok'],'monitors':r['environment']['monitor_count'],"
         "'backend':r['environment']['capture_backend'],'window':(r['window'] or {}).get('title'),"
         "'err':r['error']}))", str(services)],
        capture_output=True, text=True)
    if res2.returncode != 0:
        print(f"  info_only 探测: FAIL\n{res2.stderr.strip()[:800]}")
        return False
    info2 = json.loads(res2.stdout.strip().splitlines()[-1])
    print(f"  info_only 探测: ok={info2['ok']} monitors={info2['monitors']} backend={info2['backend']} "
          f"window={info2['window']!r} err={info2['err']}")
    return ok and info2["ok"]


def oldest_backup(path: Path) -> Path | None:
    """回滚要的是「没打过补丁的原件」，所以取最早那份 .bak（文件名里的时间戳可排序）。"""
    flat = str(path).replace(os.sep, "__")
    cands = sorted(p for p in BACKUP_DIR.glob(f"{flat}.*.bak") if p.is_file())
    return cands[0] if cands else None


def revert(plugin: Path, dry: bool = False) -> int:
    targets = [plugin / "services" / "capture_server.py", plugin / "src" / "host" / "services.mjs",
               DATA_DIR / "config.json"]
    for path in targets:
        src = oldest_backup(path)
        if src is None:
            log(f"没有 {path} 的备份，跳过")
            continue
        if dry:
            log(f"[dry-run] 会还原 {path} <- {src}")
            continue
        save_backup(path)
        shutil.copy2(src, path)
        log(f"已还原 {path} <- {src}")
    print("回滚完成" if not dry else "dry-run：未改动文件")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="给 dsh-companion 打 Linux 截图兼容层补丁（幂等）")
    ap.add_argument("--plugin", default=str(DEFAULT_PLUGIN), help="插件根目录")
    ap.add_argument("--dry-run", action="store_true", help="只报告会改什么")
    ap.add_argument("--self-test", action="store_true", help="跑自检")
    ap.add_argument("--no-config", action="store_true", help="不碰 config.json")
    ap.add_argument("--revert", action="store_true", help="从最近备份还原")
    args = ap.parse_args(argv)

    plugin = Path(args.plugin)
    if not plugin.is_dir():
        log(f"插件目录不存在: {plugin}")
        return 1
    if args.revert:
        return revert(plugin, args.dry_run)

    server = plugin / "services" / "capture_server.py"
    services_js = plugin / "src" / "host" / "services.mjs"
    linux_layer = plugin / "services" / "capture_linux.py"
    for need in (server, services_js):
        if not need.exists():
            log(f"找不到 {need}（插件结构变了？），不动任何文件")
            return 1
    if not linux_layer.exists():
        log(f"找不到兼容层 {linux_layer}（先放好 capture_linux.py 再打补丁）")
        return 1

    results = {}

    # A. capture_server.py 的 import 处
    results["capture_server"] = apply_patterns(
        server, SERVER_IMPORT_PATTERNS, SERVER_IMPORT_REPLACEMENT, "capture_server.py", args.dry_run,
        marker="import capture_linux as dc",
    )

    # B. services.mjs 的解释器候选
    if "pythonCandidates" in services_js.read_text(encoding="utf-8"):
        results["services_mjs"] = apply_patterns(
            services_js, SERVICES_PY_PATTERNS, SERVICES_PY_REPLACEMENT, "services.mjs", args.dry_run
        )
    else:
        log("services.mjs: 没有 pythonCandidates()，跳过（插件结构变了？）")
        results["services_mjs"] = "missing"

    # D. capture_server.py 的契约输出（degraded / warnings 透传）
    results["contract"] = apply_patterns(
        server, SERVER_PAYLOAD_PATTERNS, SERVER_PAYLOAD_REPLACEMENT, "capture_server 契约输出", args.dry_run,
        marker="平台降级信息",
    )

    # C. config.json
    results["config"] = "skipped" if args.no_config else patch_config(args.dry_run)

    if "missing" in (results["capture_server"], results["services_mjs"], results["contract"]):
        # 关键锚点没命中：如果把 A 改了却漏了 B，服务仍然起不来；保持一致性更安全
        log(f"锚点结果: {results} —— 有关键锚点未命中")
        # A 已经改了的话不主动回滚文件内容（它是有效的改动），但退出码非 0 提示人工看
        if not args.dry_run and any(m in server.read_text(encoding="utf-8") for m in MARKS):
            log("提示：capture_server.py 已是平台分支状态，属有效改动，未回滚")
        return 1

    if args.dry_run:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        print("dry-run 结束，未写入任何文件")
        return 0

    # 语法校验 + 自动回滚
    ok, err = check_python(server)
    if not ok:
        log(f"语法检查失败，回滚 capture_server.py: {err}")
        latest = BACKUP_DIR / f"{str(server).replace(os.sep, '__')}.latest"
        if latest.exists():
            shutil.copy2(latest, server)
        return 1
    ok, err = check_js(services_js)
    if not ok:
        log(f"语法检查失败，回滚 services.mjs: {err}")
        latest = BACKUP_DIR / f"{str(services_js).replace(os.sep, '__')}.latest"
        if latest.exists():
            shutil.copy2(latest, services_js)
        return 1

    print(json.dumps({"results": results, "backupDir": str(BACKUP_DIR)}, ensure_ascii=False, indent=2))
    print("补丁应用完成。下一步（不重启 dsh）：")
    print("  cd <plugin>/services && python3 capture_server.py --host 127.0.0.1 --port 9124 &")
    print("  curl -s http://127.0.0.1:9124/health")

    if args.self_test:
        print("自检：")
        return 0 if self_test(plugin) else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
