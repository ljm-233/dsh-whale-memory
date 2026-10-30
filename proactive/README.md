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

装上以后，Web 的 **设置 → 主动消息** 里可以直接改，改完立刻生效：

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
