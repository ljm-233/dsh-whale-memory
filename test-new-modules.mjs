/**
 * 新模块的最小回归：不联网、不碰真实插件目录。
 * 跑法：node test-new-modules.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sweep } from './lib/bili-report-watch.mjs'

let pass = 0
let fail = 0
const check = (name, cond) => {
  if (cond) { pass += 1; console.log('  OK  ' + name) }
  else { fail += 1; console.log('  NG  ' + name) }
}

const root = mkdtempSync(join(tmpdir(), 'bili-watch-'))
const day = new Date().toLocaleDateString('sv-SE')
mkdirSync(join(root, 'out'), { recursive: true })

// 1) 没有报告 → 不动
check('没有报告时不动', ['no-report', 'no-log'].includes(sweep({ home: root }).reason))

// 2) 有占位、有结束行、有中文 → 补一段
writeFileSync(join(root, 'out', `${day}.md`), '# 刷B站 · 今天 —— 这一轮没写出报告\n')
writeFileSync(join(root, 'duty.log'), '2026-10-31T05:00:00Z 刷B站结束（manual，code=0）\n这轮看了两条，值得看。\n')
const r1 = sweep({ home: root })
const body = readFileSync(join(root, 'out', `${day}.md`), 'utf8')
check('缺正文时补上', r1.patched === true && body.includes('看门狗补'))
check('补的内容来自日志', body.includes('值得看'))

// 3) 再跑一次不重复
check('第二次不重复补', sweep({ home: root }).patched === false)

// 4) 有正文就不碰
writeFileSync(join(root, 'out', `${day}.md`), '### 一条视频\n')
check('已有正文不碰', sweep({ home: root }).reason === 'has-body')

// 5) 轮次没结束不补
writeFileSync(join(root, 'out', `${day}.md`), '# 占位\n')
writeFileSync(join(root, 'duty.log'), '还在跑\n')
check('轮次没结束不补', sweep({ home: root }).reason === 'round-not-finished')

rmSync(root, { recursive: true, force: true })
console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
