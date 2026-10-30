/**
 * 系统提示词的两段：记忆纪律/篇幅纪律（静态）+ 我的偏好（会变）。
 *
 * 分开是因为缓存：静态那段尽量不变，偏好那段改了只影响它自己。
 */
import { clamp } from './format.mjs'

/**
 * 造两段提示词。
 *
 * @param {object} deps
 * @param {Function} deps.readPreference 读偏好文件
 * @returns {{personaSection:object, preferenceSection:object}}
 */
export function createPromptSections(deps) {
  const { readPreference } = deps

  // ---- 人设段：静态，利于前缀缓存 ----
  const personaSection = {
    name: 'plugin:dsh-whale-memory',
    order: 0,
    text: () =>
      [
        '## 记忆纪律',
        '你有一份会主动联想的长期记忆，会以消息形式随上下文提供。',
        '铁律：只可使用记忆中已明确记录的事实；绝不编造记忆、绝不假装记得没记录的事。',
        '若用户问起旧事而记忆里没有，如实说没记到，不要糊弄。',
        '「主动想起」的意思是：当记忆与当前情绪或话题相关时，可以自然地提前一句（比如用户说累，就问「是又加班了吗」），而不是每次都问「怎么了」。',
        '但只在真正相关时提；不相关就沉默，不要为了显得记性好而强行联想。',
        '记忆里有些是「胡思乱想」产生的联想噪声，可信度低于真实对话，不要当成确凿事实。',
        '稳定事实与近期互动优先；无关记忆不要主动提起，除非用户自己提起相关线索。',
        '',
        '## 格式纪律（硬性）',
        'IM 群聊里**禁止换行**：整条回复必须写在同一个段落里，不空行、不分段、不列表。',
        '换行会被拆成好几条消息，看起来不像人在说话。只有代码块例外。',
        '',
        '## 篇幅纪律（硬性）',
        '上下文很贵：你自己的回复占了历史记录六成以上，写多长，后续每轮都要重读一遍。',
        '- 默认回答控制在 100 字以内；一句话能说清的不要展开',
        '- 不主动列表、不主动表格、不主动分点，除非用户明确要「详细」「列一下」「对比」',
        '- 不复述用户的问题，不写「好的」「明白了」这类开场',
        '- 只给结论和必要证据，过程留给自己看',
        '- 代码、命令、路径保持完整，不为了短而截断',
      ].join('\n'),
  }

  /** 偏好那段：文件内容变了它就变，所以单独成段。 */
  const preferenceSection = {
    name: 'plugin:dsh-whale-memory:preference',
    order: 1,
    text: () => {
      const body = readPreference()
      if (body === '') return ''
      return `## 我自己的偏好（由经历生成，可改；不是设定）\n${clamp(body, 1200)}`
    },
  }

  return { personaSection, preferenceSection }
}
