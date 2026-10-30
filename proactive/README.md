# dsh-proactive-message

让助手**主动发消息**，而不是只能等着被叫。

## 三种触发

| 触发 | 条件 |
|---|---|
| **沉默太久** | 主人超过 8 小时没说话 |
| **跟进记忆** | 记忆里有权重 ≥3 的未了结事项（如「上次说的那个咖啡店」） |
| **定时问候** | 白天时段，当天还没聊过 |

## 但更重要的是「什么时候不发」

打扰用户比漏发更糟。所以有四道闸：

| 闸 | 规则 |
|---|---|
| **静默时段** | 23:00–8:00 绝不发 |
| **冷却期** | 两次主动消息至少间隔 6 小时 |
| **用户活跃** | 主人最近 8 小时内说过话就不发 |
| **日配额** | 每天最多 2 条 |

判定顺序是固定的：静默时段 > 冷却 > 配额 > 用户活跃。夜里优先级最高，即使用户沉默一整天也不发。

## 自主唤醒：先做正事，没事就休息

光会「沉默太久就打个招呼」，那不叫自主，那叫定时器。

现在醒来之后先看两件事：

**一、有没有没做完的事。** 三个工具：

```
work_add(text)          记下还有什么事没做
work_list()             看还剩几件
work_done(id, note)     做完了，顺手记下结果
```

待办存在 `tasks.json`。醒来时优先推进最前面那件，同一件 12 小时内只提醒一次——不唠叨。

**二、从那以后有没有新动静。** 读记忆库里的共享事件线：上次主动说话之后有任何用户发言、回复或工具调用，就算「有动静」；什么都没有，那就是**休息**，不是失职。

判断顺序（`decide()`）：

```
手动触发 > 有待办 → 推进它 > 有新动静 → 可以说一句 > 什么都没有 → 休息
```

四道闸门（免打扰、冷却、配额、用户活跃）仍然先过一遍——休息是选择，不是免死金牌。

`status` 里能看到当前在按什么判断：

```json
{"work": {"open": 2, "next": {...}}, "hasNewEvents": true, "decision": {"reason": "pending-work"}}
```

---

### 真的醒来干活

光是发消息还不够——「继续未完成的事」得能真的开一轮活。

所以多了个开关：有没做完的事时，唤醒走 `agent.followup()`，等于我给自己排了一轮，而不是等人类开口。默认**关着**，因为它会真的消耗模型调用。

```yaml
- id: dsh-proactive-message
  config:
    selfWake:
      enabled: true     # 默认 false
      dailyCap: 3       # 一天最多自己醒几次
```

门槛：开关打开、有待办、不在免打扰、今天没超过次数。半夜不会为了写代码把自己叫起来。

---

### 主动搭话

四道闸里，「主人刚说过话」是最常挡住我的一条——可我们一直在聊的话，这条永远过不去，我就永远只能等你先开口。

所以加了一条**单独的**口子：

```yaml
initiative:
  enabled: true
  dailyCap: 2       # 一天最多主动搭几次
  minGapHours: 3    # 两次之间至少隔几小时
```

它只越「用户活跃」这一条。免打扰、日配额、冷却照旧——半夜、刷屏、连珠炮该挡的还挡。

判出来是 `initiative` 就记进自己的计数，不占普通配额。

---

## 发送通道

不新开通道，走已有的 `ctx.dshIm.send()`：

```js
export const inject = ['dshIm']
const result = await ctx.dshIm.send(botId, targetId, text, { format: 'plain' })
```

需要 `dshIm` 插件（`@xmanrui/dsh-im`）已安装并配好投递目标。

## 配置

```yaml
- id: dsh-proactive-message
  config:
    botId: qq_5f99fa330846c135f796b602   # 机器人调用标识
    targetId: '<在设置页创建的目标>'        # 投递目标
```

`targetId` **必须先在设置页手动创建**——这是设计如此，防止插件乱发消息。

### 四个门槛都能改

装上以后，Web 的 **设置 → 鲸娘记忆** 里可以直接改，改完立刻生效。

这一页由 `dsh-whale-memory` 提供，主动消息是它的下游，所以并入同一页（两页分开反而要多维护一份客户端 bundle）。没装记忆插件时这些设置项就不出现在任何界面里，只能改配置文件：

| 设置 | 默认 | 含义 |
|---|---|---|
| `dailyCap` | 2 | 每天最多主动发几条 |
| `cooldownHours` | 6 | 两次之间至少隔几小时 |
| `silenceHours` | 8 | 多久没说话才算「安静」 |
| `quietStart` / `quietEnd` | 23 / 8 | 免打扰时段；两个填一样就是不启用 |
| `tickMinutes` | 30 | 多久检查一次该不该说话 |

也可以直接写配置，效果一样：

```yaml
- id: dsh-proactive-message
  config:
    dailyCap: 3
    cooldownHours: 4
    quietStart: 0
    quietEnd: 0      # 关掉免打扰
```

这些是 `volatile` 字段，改完不用重启。`statePath` 例外——它是启动时读的。

### 创建投递目标

1. 打开「设置 → IM机器人」
2. 找到 QQ 机器人，点齿轮图标
3. 在「调用标识」里复制 Bot ID
4. 点「新建目标」，从已聊会话里选，或手动填平台原生 ID
   - 群：群 Open ID（如 `4080BEE6DC0B17BCCB5B7F4169DEF7E8`）
   - 私聊：用户 Open ID
5. 点「测试」确认收到，再保存
6. 复制得到的 `targetId` 填进配置

## 接口

```bash
# 看当前状态和「该不该发」的判定
curl http://127.0.0.1:3080/dsh-proactive-message/status

# 立即检查一次（仍受所有闸的限制）
curl -X POST http://127.0.0.1:3080/dsh-proactive-message/send

# 手动发一条：跳过全部门槛，不占当天配额
curl -X POST -H 'content-type: application/json' \
     -d '{"text":"我说句话试试"}' \
     http://127.0.0.1:3080/dsh-proactive-message/send
```

`status` 返回判定明细，便于调试为什么没发：

```json
{
  "ready": false,
  "isQuietHours": false,
  "decision": { "send": false, "reason": "cooldown" },
  "state": {
    "lastSentAt": 1793345000000,
    "lastUserMessageAt": 1793345100000,
    "dailyCount": { "2026-10-30": 1 }
  }
}
```

可能的 `reason`：`quiet-hours` / `cooldown` / `daily-cap` / `user-active`。

## 自检

```bash
node test-selfcheck.mjs   # 判定逻辑（纯函数）
node test-client.mjs      # 设置页（模拟客户端运行时，SSR 出 HTML）
```

用例重点测「不该发」：静默时段、冷却期、用户活跃、配额用完，以及优先级顺序；
另外覆盖门槛可配置、手动触发、以及归档条目不能被当成跟进素材。

## 已知限制

- **需要手动配置 targetId**。没配就不发，这是有意的。
- **不会真的理解你在忙什么**。「用户活跃」只是「最近 8 小时说过话」，不含语义判断。
- **跟进内容比较粗糙**。`composeMessage('followUp')` 只是把记忆原话截取 20 字加「后来怎么样了」，不是真正的理解。
- **30 分钟才检查一次**。不是实时触发，可能晚半小时。

## 许可证

MIT
