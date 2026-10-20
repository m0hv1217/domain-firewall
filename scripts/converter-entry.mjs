// scripts/converter-entry.mjs
// 仅导出 background.js 实际用到的符号，减少 bundle 体积。
export { Filter, FilterConverter } from '@adguard/dnr-converter';