# 给另一条鱼装

这份是给**别的机器上的另一个 agent** 装的清单。不需要改代码，但有几样前置得先确认。

## 一、前置

**Node 要有 `node:sqlite`。** 记忆库用的是内置 SQLite，不是第三方包。

```bash
node -e "require('node:sqlite'); console.log(process.version)"
```

输出版本、没有报错就行。Node 22.5+ 可用（需要 `--experimental-sqlite`），Node 24/26 默认可用。

**向量服务（可选，但不装会明显变笨）。** 不装也能跑：召回会降级成字符二元组重叠，效果差一截，对话不受影响。

```bash
curl -s http://127.0.0.1:8377/health   # {"ok":true,"dims":512,...}
```

要装的话见主 README 的「前置：向量服务」，需要一份 BGE 中文 ONNX 模型。

## 二、装

三个包要分别装，它们是独立包。

```bash
# 1. 克隆
git clone https://github.com/ljm-233/dsh-whale-memory.git
cd dsh-whale-memory

# 2. 主插件（记忆本体）
dsh plugin --profile web add "$PWD"

# 3. 群语料（想让它学群里怎么说话才装）
dsh plugin --profile web add "$PWD/corpus"

# 4. 主动消息（想让它自己开口才装）
dsh plugin --profile web add "$PWD/proactive"
```

装完重启 dsh。

如果 `dsh plugin add` 被 pnpm 的 registry 卡住，手工装也行：把目录复制进 `~/.dsh/profiles/web/node_modules/`，再把包名加进该目录 `package.json` 的 bundles 数组。

## 三、配

主插件不需要配置就能工作，数据落在 `~/.dsh/whale-memory/memory.db`。

主动消息**必须**先建投递目标（设置 → IM机器人 → 新建目标），再把 `targetId` 填进配置——这是设计如此，防止插件乱发消息。详见 [`proactive/README.md`](proactive/README.md)。

## 四、验

```bash
curl -s http://127.0.0.1:3080/dsh-whale-memory/status
```

应该看到 `hot` / `cold` / `embedOk` / `stats`。`embedOk: false` 说明向量服务没通，其它照常。

再打开 Web 设置，左侧应该多一页「鲸娘记忆」，能看到四组参数和只读的记忆内容预览。

## 五、dsh 更新后插件不见了

`dsh` 升级或 pnpm 重装 profile 时，手工复制进 `node_modules` 的包会被清掉——表现是三个 `*/status` 端点全部 404。

一条命令恢复（会重新拷包并把 bundles 名单补全）：

```bash
node scripts/install-local.mjs
# 或指定 profile
node scripts/install-local.mjs --profile ~/.dsh/profiles/web
```

恢复完重启 dsh。

## 六、Windows 11 上装

代码本身没有只跑在 Linux 的地方（没有 `/tmp`、没有 `HOME` 环境变量、没有 shell 调用），但**服务怎么起**要换成 Windows 的写法。

### 前置

```powershell
node -e "require('node:sqlite'); console.log(process.version)"
```

Node 24 及以上默认可用；22.5–23 需要启动参数 `--experimental-sqlite`（在 `NODE_OPTIONS` 里加上）。

### 安装

```powershell
git clone https://github.com/ljm-233/dsh-whale-memory.git
cd dsh-whale-memory
dsh plugin --profile web add $PWD.Path
dsh plugin --profile web add "$($PWD.Path)\corpus"
dsh plugin --profile web add "$($PWD.Path)\proactive"
```

装完重启 dsh。

### 向量服务

一条命令搞定（装依赖 + 下模型 + 起服务 + 自检）：

```powershell
.\scripts\setup-embed.ps1
```

需要先有 Python 3.10+ 和 uv（`winget install astral-sh.uv`）。

想手动来也行：

```powershell
uv pip install --target "$env:USERPROFILE\.dsh-whale\pylibs" onnxruntime numpy

$env:WHALE_MODEL_DIR = "$env:USERPROFILE\.dsh-whale\models\bge-small-zh-v1.5-int8"
$env:PYTHONPATH     = "$env:USERPROFILE\.dsh-whale\pylibs"
python .\embed_server.py
```

**模型目录用 `WHALE_MODEL_DIR` 指定，不用改代码。** 目录里要有 `model.onnx` 和 `tokenizer.json` 两个文件。

模型可以从 HuggingFace 取：

```powershell
uv pip install --target $env:PYTHONPATH huggingface_hub
python -c "from huggingface_hub import hf_hub_download as d; [d('BAAI/bge-small-zh-v1.5', n, local_dir=r'%USERPROFILE%\.dsh-whale\models\bge-small-zh-v1.5-int8') for n in ('model.onnx','tokenizer.json')]"
```

### 开机自启 / 定时任务

Linux 那套 systemd 用不上，换成任务计划程序：

向量服务用现成的注册脚本（路径按自己机器改）：

```powershell
.\scripts\register-embed-task.ps1 `
    -ServiceScript "C:\Users\你\dsh-whale-memory\embed_server.py" `
    -ModelDir      "C:\Users\你\.dsh-whale\models\bge-small-zh-v1.5-int8" `
    -Libs          "C:\Users\你\.dsh-whale\pylibs"
```

它会注册一个「登录时启动」的计划任务（`dsh-whale-embed`），带失败重试、不设执行时限，并且当场起一次、自检 8377。重复跑会先删旧的，是幂等的。

自己手写的服务也能用——把 `-ServiceScript` 指到你的脚本即可，只要它监听 `127.0.0.1:8377` 并在 `/health` 返回 `dims: 512`。

**注册计划任务报「拒绝访问」**（需要管理员权限时常见），换成启动文件夹，不需要提权：

```powershell
.\scripts\install-embed-startup.ps1 `
    -ServiceScript "C:\...\patches\embed\embed_server.py" `
    -ModelDir      "C:\...\patches\embed" `
    -Libs          "C:\...\patches\embed\pylibs"
```

它往 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dsh-whale-embed.vbs` 放一个隐藏窗口的启动脚本，登录即起，不弹黑框。想立刻生效就双击那个 `.vbs`。

胡思乱想那个还是命令行：

```powershell
schtasks /create /tn "dsh-whale-ruminate" /tr "node %USERPROFILE%\dsh-whale-memory\ruminate.js --count 1" /sc hourly /mo 2
```

### Windows 上已知的差异

- 备份用的是 `VACUUM INTO`，路径已统一成正斜杠，Windows 反斜杠路径也试过没问题
- 文件轮转按文件名匹配，不依赖路径分隔符
- 没有做「Windows 服务」形态，只有任务计划程序——关掉终端服务就停
- 路径里有中文或空格时，`dsh plugin add` 可能需要给路径加引号

## 七、装完会怎样

它开始有自己的记忆：热区放最近几轮，冷区放长期，被压缩掉的对话会抢救回来，每天自己写一篇日记，跨窗口写同一条事件线。

**记忆是它自己的**，存在它那台机器的 `~/.dsh/whale-memory/` 里，不跟别人的混。

## 八、已知差异

- 没有向量服务 → 召回降级，但不会崩
- 没有 `@deepseek-ai/dsh-tools` → 工具不注册（记忆照常工作，只是模型不能自己查/改）
- 没有 `@deepseek-ai/schemastery` → 设置页不出现
- 设置页的客户端 bundle 需要 DSH 自己的客户端模块系统，版本太旧则不显示
