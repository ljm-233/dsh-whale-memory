/**
 * 写入器的接线：把设置里的几项、说话人解析、取舍层影子凑成 createWriter 的依赖。
 *
 * 从 index.mjs 搬出来，逻辑一个字没改——只是让 index 不再夹着这几个闭包。
 */
import { numCfg } from '../shared.mjs'
import { HOT_ZONE_MAX } from '../constants.mjs'
import { createWriter } from '../writer.mjs'
import { createSpeakerResolver } from './speaker.mjs'
import { recentTexts as admitRecentTexts, record as recordAdmit } from '../admission.mjs'

/**
 * @param {object} deps 依赖
 * @param {object} deps.db 库
 * @param {object} deps.config 插件配置
 * @param {object} deps.cfg 配置取值函数
 * @param {Function} deps.bumpStat 计数
 * @returns {{setUser:Function, setAssistant:Function, flush:Function}}
 */
export function createWriterFor({ db, config, cfg, bumpStat }) {
  const { activeSpace, recentPairs, factMax, speakerEnabled, speakerGroupDb, admitShadowOn } = cfg
  return createWriter({
    db, bumpStat, recentPairs, factMax, space: activeSpace,
    hotMax: () => numCfg(config.hotZoneMax, HOT_ZONE_MAX, 1, 200, true),
    // 每轮一次：正文痕迹 → 群档 ±10 分钟唯一对齐 → 空串。开关关掉就永远空串。
    speakerOf: createSpeakerResolver({ enabled: speakerEnabled, dbPath: speakerGroupDb }),
    /**
     * 取舍层：判一条、落一行账。返回 `'drop'` 才表示「真的不许入库」——
     * 影子模式下 `applied=0`，这里恒返回空串，写入路径一个字不改。
     */
    admit: (text, at) => {
      try {
        const r = recordAdmit(db, {
          at, kind: 'turn', text, space: activeSpace(),
          shadow: admitShadowOn(),
          recent: admitRecentTexts(db, { space: activeSpace() }),
        })
        return r.applied === 1 ? r.decision : ''
      } catch { return '' }
    },
  })
}
