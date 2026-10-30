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

## 五、装完会怎样

它开始有自己的记忆：热区放最近几轮，冷区放长期，被压缩掉的对话会抢救回来，每天自己写一篇日记，跨窗口写同一条事件线。

**记忆是它自己的**，存在它那台机器的 `~/.dsh/whale-memory/` 里，不跟别人的混。

## 六、已知差异

- 没有向量服务 → 召回降级，但不会崩
- 没有 `@deepseek-ai/dsh-tools` → 工具不注册（记忆照常工作，只是模型不能自己查/改）
- 没有 `@deepseek-ai/schemastery` → 设置页不出现
- 设置页的客户端 bundle 需要 DSH 自己的客户端模块系统，版本太旧则不显示
