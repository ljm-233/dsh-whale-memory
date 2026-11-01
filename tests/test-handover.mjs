/**
 * 交接条骨架检查的回归：纯 node，不联网、不碰真实插件目录。
 *
 * 覆盖：四段齐全、缺段、空串 / undefined 三种输入下 missingSections
 * 与 handoverNudge 的返回。跑法：node tests/test-handover.mjs
 */
import { HANDOVER_SECTIONS, missingSections, handoverNudge } from '../lib/handover.mjs'

let pass = 0
let fail = 0
const check = (name, cond) => {
  if (cond) { pass += 1; console.log('  OK  ' + name) }
  else { fail += 1; console.log('  NG  ' + name) }
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

const full = `# 交接条

## 我是谁
ljm 那台机器上的我。

## 上次做到哪
交接条检查补完了，测试也跑过了。

## 下一步
把 PR 提了。

## 别再犯
别把提醒当成代写。
`

// 1) 四段齐全 → 不缺、不提醒
check('四段齐全不缺段', same(missingSections(full), []))
check('四段齐全不提醒', handoverNudge(full) === '')

// 2) 只留一段 → 只报缺的三段，提醒里带段名
const partial = '# 交接条\n\n## 我是谁\n还是我。\n'
const missing = missingSections(partial)
check('缺一段只报缺的三段', same(missing, ['## 上次做到哪', '## 下一步', '## 别再犯']))
const nudge = handoverNudge(partial)
check('提醒里带缺失段名', missing.every((h) => nudge.includes(h)))
check('提醒里不出现已有段名', !nudge.includes('## 我是谁'))

// 3) 空串 / undefined → 四段全缺，不抛异常
let emptyResult
let emptyThrew = false
try { emptyResult = missingSections('') } catch { emptyThrew = true }
check('空串不抛异常', emptyThrew === false)
check('空串报四段全缺', same(emptyResult, HANDOVER_SECTIONS))

let undefResult
let undefThrew = false
try { undefResult = missingSections(undefined) } catch { undefThrew = true }
check('undefined 不抛异常', undefThrew === false)
check('undefined 报四段全缺', same(undefResult, HANDOVER_SECTIONS))

check('空串提醒带四段名', HANDOVER_SECTIONS.every((h) => handoverNudge('').includes(h)))

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
