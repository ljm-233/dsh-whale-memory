#!/usr/bin/env node
/**
 * 图谱几何自检：布局确定、标签是原文、避让不压字。
 *
 * 不启浏览器也不起 DSH：client.js 里那段几何是纯函数，
 * 这里用同一套模块加载器把它取出来直接调（和 test-client.mjs 一个路子）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// ---- 模拟客户端模块运行时 ----
const handoffs = new Map()
globalThis.window = { __ModuleLoader__: { load: (hd) => { handoffs.set(hd.id, hd) } } }
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
new Function('window', source)(globalThis.window)

// react 只要占位：几何那一段不碰 React，组件也不在这里渲染。
const plugin = handoffs.get('dsh-whale-memory').factory(() => ({ createElement: () => null }))
const { graphScene, graphLabel } = plugin.__test
assert.equal(typeof graphScene, 'function', '__test 要暴露 graphScene')
assert.equal(typeof graphLabel, 'function', '__test 要暴露 graphLabel')

/** 造一份像真实库的 fixture：短词、中文、拉丁长名都在里面。 */
const NAMES = [
  ['米鱼', 412], ['一个', 300], ['自己', 288], ['用户', 260], ['ljm', 181],
  ['记忆', 150], ['DeepSeek Harness', 96], ['宝宝', 88], ['日记', 74], ['ljm-233/dsh-whale-memory', 61],
  ['情绪', 55], ['压缩', 48], ['唤醒', 44], ['桌面页', 40], ['图谱', 37],
  ['群聊', 33], ['私聊', 31], ['妹妹', 29], ['哎嘿', 27], ['鲸鱼姬', 25],
  ['标出处', 23], ['认错', 21], ['自唤醒', 19], ['雾屋', 17], ['看路', 15],
]
const nodes = NAMES.map(([name, count], i) => ({ name, count, degree: (i * 7) % 11, lastHit: 0 }))
const edges = []
for (let i = 0; i < nodes.length; i += 1) {
  for (let j = i + 1; j < nodes.length; j += 1) {
    const w = ((i * 13 + j * 7) % 9) + 1
    if (w >= 4) edges.push({ a: nodes[i].name, b: nodes[j].name, w, weight: w })
  }
}
const fixture = { nodes, edges, total: 300 }

// ---- 1. 同一输入两次布局完全一致 ----
{
  const a = graphScene(fixture, { edgeMax: 120, showAll: true })
  const b = graphScene(fixture, { edgeMax: 120, showAll: true })
  assert.deepEqual(a, b, '同一份数据布局两次必须一模一样（刷新不许乱跳）')
  const short = graphScene(fixture, { edgeMax: 120, showAll: false })
  assert.deepEqual(
    short.nodes.map((n) => [n.name, n.x, n.y]),
    a.nodes.map((n) => [n.name, n.x, n.y]),
    '标签显不显示不能反过来动坐标',
  )
  for (const n of a.nodes) {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.name} 的坐标必须是有限数`)
    assert.ok(n.x >= 0 && n.x <= a.width && n.y >= 0 && n.y <= a.height, `${n.name} 要落在画布内`)
  }
  console.log(`OK 布局确定性（${a.nodes.length} 个点、${a.edges.length} 条边，两次一致）`)
}

// ---- 2. 标签是 node.name 原文，一个字都不许改 ----
{
  const scene = graphScene(fixture, { edgeMax: 120, showAll: true })
  assert.equal(scene.stats.labels, nodes.length, '放大后每个点都要有标签')
  for (const n of scene.nodes) {
    assert.ok(n.label !== null, `${n.name} 该有标签`)
    const joined = n.label.lines.join('')
    assert.equal(joined, n.name, `标签拼回来必须是原文：${JSON.stringify(joined)} ≠ ${JSON.stringify(n.name)}`)
    assert.ok(!joined.includes('…'), '不许用省略号截断名字')
    assert.ok(n.label.lines.every((l) => l !== ''), '不许出现空行')
  }
  // 长名要折行，不是被砍掉
  const long = scene.nodes.find((n) => n.name === 'ljm-233/dsh-whale-memory')
  assert.ok(long.label.lines.length >= 2, '长名要换行显示完整，而不是截断')
  assert.equal(long.label.lines.join(''), 'ljm-233/dsh-whale-memory')
  console.log(`OK 标签是原文（长名折成 ${long.label.lines.length} 行，仍等于原名）`)
}

// ---- 3. 短词节点（一个/自己/用户）不许被吃掉 ----
{
  const scene = graphScene(fixture, { edgeMax: 120, showAll: true })
  for (const want of ['一个', '自己', '用户']) {
    const n = scene.nodes.find((x) => x.name === want)
    assert.ok(n !== undefined, `fixture 里应该有「${want}」`)
    assert.equal(n.label.lines.join(''), want, `「${want}」的标签必须还是「${want}」`)
  }
  console.log('OK 短词节点标签完好（一个 / 自己 / 用户）')
}

// ---- 4. 标签矩形互不压字 ----
{
  const scene = graphScene(fixture, { edgeMax: 120, showAll: true })
  const boxes = scene.nodes.filter((n) => n.label !== null).map((n) => ({ name: n.name, ...n.label }))
  const hits = []
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]
      const b = boxes[j]
      // 留 1px 缝：贴边不算压字
      if (!(a.x + a.w + 1 <= b.x || b.x + b.w + 1 <= a.x || a.y + a.h + 1 <= b.y || b.y + b.h + 1 <= a.y)) {
        hits.push(`${a.name} × ${b.name}`)
      }
    }
  }
  assert.deepEqual(hits, [], `标签不许互相压字，压了：${hits.join(', ')}`)
  console.log(`OK 标签避让（${boxes.length} 个标签矩形零重叠）`)
}

// ---- 5. 缩放 < 0.6 只留度最高的 5 个标签 ----
{
  const scene = graphScene(fixture, { edgeMax: 120, showAll: false })
  assert.equal(scene.stats.showAll, false)
  assert.equal(scene.stats.labels, 5, '缩小时只显示度前 5 的标签')
  // 和 __test 里同一条排序规则：度 → 次数 → 名字
  const top = [...nodes]
    .sort((a, b) => b.degree - a.degree || b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, 5)
    .map((n) => n.name)
  const shown = scene.nodes.filter((n) => n.label !== null).map((n) => n.name)
  assert.deepEqual([...shown].sort(), [...top].sort(), '留下的必须是度最高的那 5 个')
  assert.ok(scene.nodes.filter((n) => n.label === null).length > 0, '其余节点只留圆点')
  console.log('OK 缩放分档（<0.6× 只显示度前 5）')
}

// ---- 6. 边数上限可选 ----
{
  const few = graphScene(fixture, { edgeMax: 10, showAll: true })
  assert.equal(few.edges.length, 10, '边按上限截断')
  assert.equal(few.stats.edgesDrawn, 10)
  assert.ok(few.stats.edgesTotal > 10, '没被画的边也要报出来')
  const weights = few.edges.map((e) => e.w)
  assert.deepEqual(weights, [...weights].sort((x, y) => y - x), '画的必须是权重最高的那几条')
  console.log(`OK 边裁剪（共 ${few.stats.edgesTotal} 条，画前 ${few.stats.edgesDrawn} 条）`)
}

// ---- 7. 空图不炸 ----
{
  const empty = graphScene({ nodes: [], edges: [], total: 0 }, {})
  assert.equal(empty.nodes.length, 0)
  assert.equal(empty.edges.length, 0)
  const partial = graphScene({ nodes: [{ name: '米鱼', count: 1 }], edges: [{ a: '米鱼', b: '没有这个点', w: 3 }] }, {})
  assert.equal(partial.edges.length, 0, '端点不存在的边要丢掉，不能画出悬空的线')
  console.log('OK 空图与残缺边')
}

console.log('\n全部通过')
