#!/usr/bin/env node
/**
 * 把图谱导成一张静态 SVG，用来核对「标签真的渲染了、名字是原文」。
 *
 * 布局和标签避让直接借 client.js 里那一份纯函数（`__test.graphScene`），
 * 不复制代码——导出的图和设置页里画的是同一个场景。
 * 库只读打开（`/tmp/viz/memory.db` 这类副本），不写回。
 *
 * 跑法：
 *   node scripts/graph-svg.mjs --db /tmp/viz/memory.db --out /tmp/viz/graph.svg
 *   node scripts/graph-svg.mjs --db /tmp/viz/memory.db --space default --limit 50 --edge-max 120
 */
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const dbPath = arg('db', '')
const outPath = arg('out', '/tmp/viz/graph.svg')
const space = arg('space', 'default')
const limit = Number(arg('limit', '50')) || 50
const edgeMax = Number(arg('edge-max', '120')) || 120
const sort = arg('sort', 'count')

if (dbPath === '') {
  console.error('要一个库：--db /tmp/viz/memory.db（副本，别指着真库跑）')
  process.exit(2)
}

// ---- 拿几何函数：同一套模块加载器，和设置页共用 client.js ----
const handoffs = new Map()
globalThis.window = { __ModuleLoader__: { load: (hd) => { handoffs.set(hd.id, hd) } } }
new Function('window', readFileSync(join(root, 'client.js'), 'utf8'))(globalThis.window)
const plugin = handoffs.get('dsh-whale-memory').factory(() => ({ createElement: () => null }))
const { graphScene } = plugin.__test

// ---- 读图（只读）----
const { DatabaseSync } = await import('node:sqlite')
const { readGraph } = await import('../lib/graph.mjs')
const db = new DatabaseSync(dbPath, { readOnly: true })
const graph = readGraph(db, { space, limit, sort })
db.close()

const scene = graphScene(graph, { edgeMax, showAll: true })

// ---- 渲染成 SVG 字符串 ----
const esc = (s) => String(s)
  .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  .replace(/"/gu, '&quot;')

const parts = []
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${scene.height}" width="${scene.width}" height="${scene.height}" font-family="sans-serif">`)
parts.push(`<title>实体关系图 · ${esc(space)} · ${scene.stats.nodes} 个实体 / 画 ${scene.stats.edgesDrawn} 条边</title>`)
parts.push('<g stroke="currentColor" color="#333">')
for (const e of scene.edges) {
  parts.push(`<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke-opacity="${e.opacity}" stroke-width="${e.width}"/>`)
}
for (const n of scene.nodes) {
  parts.push(`<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="currentColor" fill-opacity="0.22" stroke-opacity="0.45" stroke-width="0.8"/>`)
  if (n.label === null) continue
  n.label.lines.forEach((line, i) => {
    const x = Math.round((n.label.x + n.label.w / 2) * 100) / 100
    const y = Math.round((n.label.y + n.label.lineHeight * i + n.label.fontSize) * 100) / 100
    parts.push(`<text x="${x}" y="${y}" text-anchor="middle" font-size="${n.label.fontSize}" fill="currentColor" fill-opacity="0.8">${esc(line)}</text>`)
  })
}
parts.push('</g>')
parts.push('</svg>')

const svg = `${parts.join('\n')}\n`
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, svg, 'utf8')

// ---- 报数：节点 / 边 / 标签，以及 5 个节点的标签原文 ----
const textCount = (svg.match(/<text[ >]/gu) ?? []).length
const bytes = statSync(outPath).size
const labelCount = scene.nodes.filter((n) => n.label !== null).length

console.log(`库 ${dbPath}（只读）· 空间 ${graph.space} · 排序 ${graph.sort}`)
console.log(`节点 ${scene.stats.nodes} 个（库里共 ${graph.total} 个，省略 ${Math.max(0, graph.total - scene.stats.nodes)}）`)
console.log(`边 ${scene.stats.edgesTotal} 条（这批实体之间）· 被画的边 ${scene.stats.edgesDrawn} 条（上限 ${edgeMax}）`)
console.log(`标签 ${labelCount} 个 · <text> 节点 ${textCount} 个 · ${outPath} ${bytes} 字节`)

// 短词最容易被避让吃掉，优先抽它们；不足 5 个再按等距补。
const risky = ['一个', '自己', '用户', '我', '你', '他', '她']
const sample = scene.nodes.filter((n) => risky.includes(n.name))
const step = Math.max(1, Math.floor(scene.nodes.length / 5))
for (let i = 0; i < scene.nodes.length && sample.length < 5; i += step) {
  if (!sample.includes(scene.nodes[i])) sample.push(scene.nodes[i])
}
console.log('标签抽样（原文 / 折行 / 拼回来是否等于原名）:')
for (const n of sample) {
  const lines = n.label === null ? [] : n.label.lines
  const joined = lines.join('')
  console.log(`  "${n.name}" → ${JSON.stringify(lines)} · 拼回一致=${joined === n.name} · 度 ${n.degree} · ${n.count} 条`)
}
