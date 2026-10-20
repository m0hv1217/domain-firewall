# Domain Firewall

> **以当前页面域名为基准的浏览器反向白名单防火墙。**  
> 默认只允许网页与「它自己所属的站点」通信，其余第三方子资源一律阻断。

📖 [English](README-EN.md) | 简体中文 · [完整文档](docs/index.md) · [变更记录](docs/CHANGELOG.md)

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-green.svg)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Browsers](https://img.shields.io/badge/Browsers-Chrome%20%7C%20Edge%20%7C%20Opera%20%7C%20Firefox-lightgrey.svg)](#-支持的浏览器)

---

## 👥 作者

本项目由 **m0hv1217** 与 **DeepSeek**、**Claude** 联合完成：

| 角色 | 参与方 |
|---|---|
| 产品定位、需求定义、功能取舍 | m0hv1217 |
| 架构设计、代码实现、问题排查 | m0hv1217 × DeepSeek × Claude |
| 文档撰写、测试方案、跨浏览器适配 | m0hv1217 × DeepSeek × Claude |
| 方案评审、边界情况讨论、已知坑梳理 | m0hv1217 × DeepSeek × Claude |

整个项目是在多轮对话中逐步成型的：从最初的「反向白名单」设想，到预算管理、元素拾取、批量导入、跨浏览器打包，每一步都由 m0hv1217 提出方向、两个模型给出实现方案并相互审阅。README.txt 里那 30 多条「已知坑」，基本都来自这个协作过程里踩过的真实问题。

---

## 这是什么

多数拦截工具是**黑名单**：先放行一切，再按规则阻断已知的广告/跟踪器。

Domain Firewall 反过来——它是**白名单**：

> 一个网页，默认只被允许与**它自己的站点**（含所有子域名）以及**你显式加入白名单的域名**通信。其他第三方的脚本、图片、样式、字体、XHR、WebSocket、iframe……全部阻断。

举例：你在访问 `www.example.com`

| 请求目标 | 结果 |
|---|---|
| `static.example.com/app.js` | ✅ 放行（同站子域名） |
| `cdn.other.com/lib.js` | 🚫 阻断（第三方） |
| `cdn.other.com/lib.js`，且你把 `other.com` 加入白名单 | ✅ 放行 |
| 点击链接跳到 `other.com`（顶层导航） | ✅ 放行（顶层导航永不拦） |

代价也很直接：依赖第三方 CDN / 统计脚本 / 字体的网站可能显示不全。**这是设计如此**——用白名单加回你信任的域名即可。

---

## ✨ 主要特性

### 🛡️ 基于 PSL 的精确根域判断
用浏览器内核的 `domainType: 'thirdParty'` 判定，按**发起请求的页面**的可注册域名（eTLD+1）判断同站，不再受「当前标签页」影响——多标签页、跨域跳转、后台标签页都不会误判。

### 🎯 元素拾取 + 网络拦截联动
像开发者工具那样点选页面元素并隐藏。高级模式下，可以**同时**为它的 URL 生成一条带有效期的网络拦截规则。拾取面板显示选择器匹配数量，匹配多个时会给出警告。

### 📊 规则预算管理
浏览器的动态 DNR 规则有 30,000 条上限。插件把它分成四个池管理：

| 池 | 用途 | 默认份额 |
|---|---|---|
| `CORE` | 域名防火墙 | 15% |
| `CUSTOM` | 用户导入的 EasyList 规则 | 15% |
| `TRANSIENT` | 拾取产生的临时规则（带 TTL） | 30% |
| `RESERVE` | 硬预留，绝不分配 | 40% |

份额可在设置页调整，避免某一类规则把额度占光。

### 📝 记录模式 + 隐私脱敏
不拦截、只观察。所有落盘数据在写入前自动脱敏：
- URL 查询参数里的 `token` / `code` / `key` / `sig` 等敏感值；
- `Authorization` / `Cookie` / `Set-Cookie` 等敏感请求头；
- 请求体里的密码、会话、JWT 等字段（JSON / 表单 / 兜底正则三层）。

### 🧩 静态广告规则集 + 自定义规则导入
内置 EasyList / AdGuard Base 两个静态规则集。设置页支持**批量导入 EasyList 语法规则**，逐行转换、跨批次去重、预算准入、可中断、可恢复。

### 🌐 跨浏览器
Chrome / Edge / Opera 用 service worker，Firefox 用事件页。同一套源码，四个浏览器分别打包。

---

## 📦 支持的浏览器

| 浏览器 | 最低版本 | 说明 |
|---|---|---|
| Chrome | 121+ | 主开发目标，端到端测试过 |
| Edge | 121+ | 与 Chrome 共用同一份包，未实机测试 |
| Opera | 100+ | 与 Chrome 共用同一份包，未实机测试 |
| Firefox | 140+ | 使用事件页 + 独立 manifest，未实机测试 |

为什么 Chrome 要 121+：动态规则上限从 120 的 5,000 提升到 121 的 30,000，预算管理按 30k 计算。

---

## 🚀 安装

### 方式一：加载已构建的包（推荐新手）

1. 从 [Releases](../../releases) 下载对应浏览器的整包 `domain-firewall-<版本>-<浏览器>-package.zip`；
2. 解压到固定位置（**不要移动**，浏览器会一直从这里读）；
3. Chrome：地址栏输入 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选 `extension/` 文件夹；
4. Edge / Opera 类似：`edge://extensions` / `opera://extensions`；
5. Firefox：见整包内 `INSTALL.txt`（需要 Mozilla 签名的 `.xpi`，或临时载入）。

### 方式二：从源码构建

```bash
# 1. 安装依赖
npm install

# 2. 下载过滤列表（构建静态规则集的原料，只需一次）
mkdir filters
curl -L -o filters/easylist.txt      https://easylist.to/easylist/easylist.txt
curl -L -o filters/adguard-base.txt  https://filters.adtidy.org/extension/chromium/filters/2.txt

# 3. 构建 + 分包
npm run release
```

详细的构建流程、过滤列表来源、Firefox 签名步骤见 [README.txt](README.txt) 第二部分。

---

## 🏗️ 技术架构

```
domain-firewall/
├── manifest.json          Chromium 版配置
├── manifest.firefox.json  Firefox 版补丁（事件页 + gecko 设置）
├── background.js          核心逻辑：规则生成、监听器、预算、CUSTOM、批次
├── budget-manager.js      规则预算账本
├── psl.js                 Public Suffix List（只给 popup 用）
├── content.js             元素拾取 + cosmetic 注入
├── popup.* / options.*    UI
├── scripts/               构建脚本
├── filters/               原始过滤列表（不提交）
└── rules/                 静态规则集（构建产物）


**核心设计：**

- **反向白名单**：`excludedRequestDomains` = 白名单，`action: block` + `domainType: 'thirdParty'`；
- **不拦截 `main_frame`**：顶层导航放行，只拦子资源；
- **所有 DNR 写操作串行化**：`dnrQueue` + 合并，避免规则重建竞态；
- **账本从 DNR 对账重建**：SW 休眠不丢状态，唤醒时 `getDynamicRules()` 重建。

---

## ⚠️ 已知限制

1. **PSL 是精选列表**：`psl.js` 覆盖常见多级后缀，非常见后缀回退为 `slice(-2)`。真正判断同站的是浏览器内核。
2. **日志有丢失窗口**：批量写入（100 ms debounce），SW 休眠时未 flush 的缓冲最多丢 ~50 条。
3. **顶层导航永不拦截**：设计如此，防跳转广告不在范围内。
4. **两个静态规则集不能同时启用**：合计超 30,000，浏览器会拒绝。
5. **Firefox 未实机测试**：事件页 + WASM 转换器只在模拟环境验证过。
6. **被 DNR 拦截的 `<img>` 会被浏览器折叠**：之后选不中，想拾取需先加白名单。

完整清单见 [README.txt 第 27 节](README.txt)。

---

## 🤝 贡献

欢迎 issue / PR。提交前请：

1. 阅读 [README.txt 第 20 节（跨浏览器兼容设计）](README.txt)；
2. 遵守 20.4 的七条规则（只用 `chrome.*` Promise 形式、`importScripts` 必须 `CAN_IMPORT_SCRIPTS` 保护、需要唤醒 SW 的监听器顶层同步注册……）；
3. 改动后跑一遍 [README.txt 第 29 节验证清单](README.txt)。

---

## 📄 许可证

本项目采用 **GNU General Public License v3.0** 授权。

之所以选 GPLv3，是因为本项目依赖 `@adguard/dnr-converter`（GPLv3），按 GPLv3 的传染条款，整体分发必须采用兼容许可证。

- 完整许可证文本见 [LICENSE](LICENSE)；
- 上游版权声明请参见 `node_modules/@adguard/dnr-converter/LICENSE`。

**本项目仅供个人学习和非商业使用。**

---

## 🙏 致谢

- [`@adguard/dnr-converter`](https://github.com/AdguardTeam/dnr-converter)：EasyList → DNR 规则转换；
- [`@adguard/re2-wasm`](https://github.com/AdguardTeam/re2-wasm)：正则验证；
- [EasyList](https://easylist.to/) / [AdGuard](https://adguard.com/)：过滤列表；
- [Public Suffix List](https://publicsuffix.org/)：公共后缀数据。

---

<p align="center">
  <sub>Built with ☕ and a healthy distrust of third-party scripts.</sub>
</p>
