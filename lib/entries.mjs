// 2026-11-08 结构重排：实现在 ./core/entries.mjs，这里只转出去，旧 import 不用改。
// 等所有引用都指到新路径，这个垫片就可以删。
export * from './core/entries.mjs'
