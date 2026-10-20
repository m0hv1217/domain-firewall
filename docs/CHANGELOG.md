# 变更记录

## 2.5

跨浏览器、规则模型重构、隐私与可靠性。

- **拦截规则**：CORE 改用 `domainType: 'thirdParty'`，按发起页判断同站，不再依赖当前标签页；白名单按输入粒度生效；规则未变时跳过写入。
- **公共后缀**：`psl.js` 换成官方 PSL 数据 + 规范算法；新增 `scripts/build-psl.mjs`。
- **记录模式**：唤醒源 `main_frame` 监听器；请求体 / 头 / URL 查询参数自动脱敏；新增 `recordRequestBody`、`redactUrl` 开关。
- **可靠性**：`releaseIdsFromPool` 失败关闭；批次恢复边界校验；CUSTOM 规则保留转换器优先级；拾取 urlFilter 加锚点。
- **界面**：元素拾取支持匹配数量警告与二次确认；popup 全部改用页内提示；跨浏览器样式补齐。
- **构建**：新增 `manifest.firefox.json` 与 `scripts/build-dist.mjs`；`npm run release` 生成四浏览器整包。
- **文档**：`README.txt` 重写，加入使用、构建、交接三部分；详细文档移入 `docs/`。

## 2.4

基线版本。

---

完整说明见 [HANDOFF.txt 第 32 节](HANDOFF.txt#32-变更记录)。