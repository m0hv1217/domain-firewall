<img width="48" height="48" alt="icon48" src="https://github.com/user-attachments/assets/76f5e406-4cce-47ae-b2bd-0374c12ae73d" />
# Domain Firewall

> **A reverse-allowlist browser firewall, based on the domain of the current page.**  
> By default, a page may only talk to its own site. Every other third-party subresource is blocked.

📖 English | [简体中文](README.md) · [Full documentation](docs/index.md) · [Changelog](docs/CHANGELOG.md)

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-green.svg)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Browsers](https://img.shields.io/badge/Browsers-Chrome%20%7C%20Edge%20%7C%20Opera%20%7C%20Firefox-lightgrey.svg)](#-supported-browsers)

---

## 👥 Authors

This project was built by **m0hv1217** together with **DeepSeek** and **Claude**:

| Role | Contributors |
|---|---|
| Product direction, requirements, feature trade-offs | m0hv1217 |
| Architecture, implementation, debugging | m0hv1217 × DeepSeek × Claude |
| Documentation, test plans, cross-browser adaptation | m0hv1217 × DeepSeek × Claude |
| Design review, edge-case discussion, known-pitfall write-ups | m0hv1217 × DeepSeek × Claude |

The project took shape over many rounds of conversation: from the original "reverse allowlist" idea, to budget management, element picking, bulk import, and cross-browser packaging. At every step m0hv1217 set the direction, and the two models proposed implementations and reviewed each other's work. The 30-plus "known pitfalls" in README.txt mostly come from real problems hit during this collaboration.

---

## What is this?

Most blocking tools use a **blocklist**: allow everything, then block known ads and trackers by rule.

Domain Firewall works the other way around. It is an **allowlist**:

> A page is, by default, only allowed to talk to **its own site** (including all subdomains) and **domains you explicitly add to the allowlist**. Third-party scripts, images, stylesheets, fonts, XHR, WebSocket, iframes… everything else is blocked.

Example: you are visiting `www.example.com`

| Request target | Result |
|---|---|
| `static.example.com/app.js` | ✅ Allowed (same-site subdomain) |
| `cdn.other.com/lib.js` | 🚫 Blocked (third party) |
| `cdn.other.com/lib.js`, after you add `other.com` to the allowlist | ✅ Allowed |
| Clicking a link to `other.com` (top-level navigation) | ✅ Allowed (top-level navigation is never blocked) |

The trade-off is plain: sites that depend on third-party CDNs, analytics scripts, or fonts may not render fully. **This is by design.** Add the domains you trust back to the allowlist.

---

## ✨ Features

### 🛡️ Accurate registrable-domain detection based on the PSL
Third-party detection uses the browser engine's own `domainType: 'thirdParty'`, judged against the registrable domain (eTLD+1) of the **page that initiated the request**, not the currently active tab. Multiple tabs, cross-domain redirects, and background tabs do not cause misjudgments.

### 🎯 Element picker + network blocking
Click an element on the page and hide it, like in developer tools. In advanced mode you can **also** generate a time-limited network blocking rule for the element's URL. The picker panel shows how many elements the selector matches, and warns when it matches more than one.

### 📊 Rule budget management
Browsers cap dynamic DNR rules at 30,000. The extension splits that budget into four pools:

| Pool | Purpose | Default share |
|---|---|---|
| `CORE` | Domain firewall | 15% |
| `CUSTOM` | User-imported EasyList rules | 15% |
| `TRANSIENT` | Temporary rules created by the picker (with TTL) | 30% |
| `RESERVE` | Hard reserve, never allocated | 40% |

Shares can be adjusted on the options page, so no single category can use up the whole quota.

### 📝 Logging mode + privacy redaction
Observe without blocking. All data is redacted automatically before it is written to disk:
- Sensitive values in URL query parameters such as `token` / `code` / `key` / `sig`;
- Sensitive request headers such as `Authorization` / `Cookie` / `Set-Cookie`;
- Passwords, sessions, JWTs, and similar fields in request bodies (three layers: JSON, form, and a fallback regex).

### 🧩 Static ad rulesets + custom rule import
Two static rulesets are bundled: EasyList and AdGuard Base. The options page supports **bulk import of EasyList-syntax rules**, with line-by-line conversion, cross-batch deduplication, budget admission, and support for interruption and resuming.

### 🌐 Cross-browser
Chrome / Edge / Opera use a service worker; Firefox uses an event page. One codebase, packaged separately per browser: the Chrome, Edge, and Opera packages have identical contents, and Firefox uses its own manifest.

---

## 📦 Supported Browsers

| Browser | Minimum version | Notes |
|---|---|---|
| Chrome | 121+ | Primary development target, tested end to end |
| Edge | 121+ | Same package contents as Chrome, not tested on real devices |
| Opera | 100+ | Same package contents as Chrome, not tested on real devices |
| Firefox | 140+ | Event page + separate manifest, not tested on real devices |

Why Chrome 121+: the dynamic rule limit went from 5,000 in version 120 to 30,000 in version 121, and the budget manager is built around 30k.

---

## 🚀 Installation

### Option 1: Load a prebuilt package (recommended for beginners)

1. Download the package for your browser from [Releases](../../releases): `domain-firewall-<version>-<browser>-package.zip`;
2. Extract it to a permanent location (**do not move it afterwards**, the browser keeps reading from there);
3. Chrome: open `chrome://extensions` → turn on "Developer mode" → "Load unpacked" → select the `extension/` folder;
4. Edge / Opera are similar: `edge://extensions` / `opera://extensions`;
5. Firefox: the release version of Firefox only installs `.xpi` files signed by Mozilla; see `INSTALL.txt` inside the package. For a quick trial, open `about:debugging` → "This Firefox" → "Load Temporary Add-on…" and select `manifest.json` from the package. A temporary add-on is **removed when the browser restarts**.

### Option 2: Build from source

```bash
# 1. Install dependencies
npm install

# 2. Download the filter lists (raw material for the static rulesets, needed once)
mkdir filters
curl -L -o filters/easylist.txt      https://easylist.to/easylist/easylist.txt
curl -L -o filters/adguard-base.txt  https://filters.adtidy.org/extension/chromium/filters/2.txt

# 3. Build and package
npm run release
```

For the full build process, filter list sources, and Firefox signing steps, see Part 2 of [README.txt](README.txt).

---

## 🏗️ Architecture

```
domain-firewall/
├── manifest.json          Chromium manifest
├── manifest.firefox.json  Firefox patch (event page + gecko settings)
├── background.js          Core logic: rule generation, listeners, budget, CUSTOM, batches
├── budget-manager.js      Rule budget ledger
├── psl.js                 Public Suffix List (used by the popup only)
├── content.js             Element picker + cosmetic injection
├── popup.* / options.*    UI
├── scripts/               Build scripts
├── filters/               Raw filter lists (not committed)
└── rules/                 Static rulesets (build output)
```

**Core design:**

- **Reverse allowlist**: `excludedRequestDomains` = the allowlist, with `action: block` + `domainType: 'thirdParty'`;
- **`main_frame` is never blocked**: top-level navigation passes, only subresources are blocked;
- **All DNR writes are serialized**: `dnrQueue` plus coalescing, to avoid races when rebuilding rules;
- **The ledger is rebuilt from DNR**: no state is lost when the service worker goes to sleep; it is rebuilt from `getDynamicRules()` on wake-up.

---

## ⚠️ Known Limitations

1. **The PSL is a curated subset**: `psl.js` covers common multi-level suffixes; uncommon suffixes fall back to `slice(-2)`. What actually decides same-site is the browser engine.
2. **Logs can be lost**: writes are batched (100 ms debounce), and when the service worker sleeps, up to about 50 buffered entries that were not yet flushed can be lost.
3. **Top-level navigation is never blocked**: by design. Blocking redirect ads is out of scope.
4. **The two static rulesets cannot be enabled together**: together they exceed 30,000 rules and the browser rejects them.
5. **Firefox is not tested on real devices**: the event page and the WASM converter were only verified in a simulated environment.
6. **`<img>` elements blocked by DNR are collapsed by the browser**: they can no longer be selected afterwards, so add the domain to the allowlist first if you want to pick them.

See [section 27 of README.txt](README.txt) for the full list.

---

## 🤝 Contributing

Issues and PRs are welcome. Before submitting:

1. Read [section 20 of README.txt (cross-browser compatibility design)](README.txt);
2. Follow the seven rules in 20.4 (use only the Promise form of `chrome.*`, guard `importScripts` with `CAN_IMPORT_SCRIPTS`, register listeners that must wake the service worker synchronously at top level, …);
3. After your change, run through the [verification checklist in section 29 of README.txt](README.txt).

---

## 📄 License

This project is licensed under the **GNU General Public License v3.0**.

GPLv3 was chosen because the project depends on `@adguard/dnr-converter` (GPLv3); under GPLv3's copyleft terms, the combined work must be distributed under a compatible license. When you distribute this project (including modified versions), you must provide the corresponding source code under GPLv3 as well.

- The full license text is in [LICENSE](LICENSE);
- For the upstream copyright notice, see `node_modules/@adguard/dnr-converter/LICENSE`.

---

## 🙏 Acknowledgements

- [`@adguard/dnr-converter`](https://github.com/AdguardTeam/dnr-converter): EasyList → DNR rule conversion;
- [`@adguard/re2-wasm`](https://github.com/AdguardTeam/re2-wasm): regex validation;
- [EasyList](https://easylist.to/) / [AdGuard](https://adguard.com/): filter lists;
- [Public Suffix List](https://publicsuffix.org/): public suffix data.

---

<p align="center">
  <sub>Built with ☕ and a healthy distrust of third-party scripts.</sub>
</p>
