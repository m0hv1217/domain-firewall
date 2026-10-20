下面是英文版，作者已改为 `m0hv1217`。

```markdown
# Domain Firewall

> **A reverse-allowlist browser firewall anchored to the current page's domain.**  
> By default, a page may only talk to its own site; every third-party subresource is blocked.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-green.svg)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Browsers](https://img.shields.io/badge/Browsers-Chrome%20%7C%20Edge%20%7C%20Opera%20%7C%20Firefox-lightgrey.svg)](#-supported-browsers)

---

## 👥 Authors

This project is a joint effort by **m0hv1217**, **DeepSeek**, and **Claude**:

| Role | Contributor(s) |
|---|---|
| Product vision, requirements, feature scope | m0hv1217 |
| Architecture, implementation, debugging | m0hv1217 × DeepSeek × Claude |
| Documentation, test plans, cross-browser packaging | m0hv1217 × DeepSeek × Claude |
| Design review, edge-case analysis, known-pitfalls writeup | m0hv1217 × DeepSeek × Claude |

The project was built up over many rounds of conversation: from the initial "reverse allowlist" idea, through the rule budget manager, the element picker, batch imports, and cross-browser packaging — at each step m0hv1217 set the direction, and the two models proposed implementations and reviewed each other's work. Most of the 30+ entries in README.txt §27 ("Known limitations") came out of problems that surfaced during that collaboration.

---

## What it is

Most blockers are **blacklists**: allow everything, then block known ads and trackers by rule.

Domain Firewall flips the model — it's an **allowlist**:

> A page is only allowed to communicate with **its own site** (including all subdomains) plus any domain **you explicitly whitelist**. Every other third-party request — scripts, images, stylesheets, fonts, XHR, WebSocket, iframes — is blocked.

Example — you're on `www.example.com`:

| Request target | Result |
|---|---|
| `static.example.com/app.js` | ✅ Allowed (same site, subdomain) |
| `cdn.other.com/lib.js` | 🚫 Blocked (third party) |
| `cdn.other.com/lib.js`, after whitelisting `other.com` | ✅ Allowed |
| Clicking a link to `other.com` (top-level navigation) | ✅ Allowed (top-level navigation is never blocked) |

The trade-off is direct: sites that depend on third-party CDNs, analytics, or font services may render incompletely. **This is by design** — add the domains you trust to the whitelist.

---

## ✨ Features

### 🛡️ PSL-aware root-domain matching
"Same-site" is decided by the browser kernel via `domainType: 'thirdParty'`, using the **initiating page's** registrable domain (eTLD+1) — not the currently active tab. Multi-tab browsing, cross-origin navigation, and background tabs all behave correctly.

### 🎯 Element picker with network-block linkage
Pick and hide elements the way DevTools does. In advanced mode, you can **also** generate a TTL-bound network block rule for that element's URL. The picker panel shows how many elements the selector matches and warns you when it's more than one.

### 📊 Rule budget manager
The browser caps dynamic DNR rules at 30,000. The extension splits that budget into four pools:

| Pool | Purpose | Default share |
|---|---|---|
| `CORE` | Domain firewall | 15% |
| `CUSTOM` | User-imported EasyList rules | 15% |
| `TRANSIENT` | Picker-generated rules (with TTL) | 30% |
| `RESERVE` | Hard reserve, never allocated | 40% |

Shares are adjustable in the options page, so no single consumer can starve the others.

### 📝 Record mode with privacy redaction
Observes without blocking. Every persisted record is redacted before it lands on disk:
- Sensitive URL query values (`token`, `code`, `key`, `sig`, …);
- Sensitive headers (`Authorization`, `Cookie`, `Set-Cookie`, …);
- Sensitive request-body fields (passwords, session tokens, JWTs) — handled for JSON, URL-encoded forms, and a regex fallback.

### 🧩 Static filter lists + custom rule import
Bundles EasyList and AdGuard Base as static rulesets. The options page supports **batch import of EasyList syntax**, with per-line conversion, cross-batch deduplication, budget admission, cancellation, and resume.

### 🌐 Cross-browser
Chrome / Edge / Opera use a service worker; Firefox uses an event page. One codebase, four builds.

---

## 📦 Supported browsers

| Browser | Minimum | Notes |
|---|---|---|
| Chrome | 121+ | Primary target, end-to-end tested |
| Edge | 121+ | Shares the Chromium package, not manually tested |
| Opera | 100+ | Shares the Chromium package, not manually tested |
| Firefox | 140+ | Event page + dedicated manifest, not manually tested |

Why Chrome 121+: the dynamic-rule cap was raised from 5,000 (Chrome 120) to 30,000 (Chrome 121). The budget manager assumes 30k.

---

## 🚀 Installation

### Option 1 — Load a prebuilt package

1. Download the appropriate bundle from [Releases](../../releases): `domain-firewall-<version>-<browser>-package.zip`;
2. Extract it to a **fixed location** (don't move it — the browser reads from that folder on every launch);
3. Chrome: open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `extension/` folder;
4. Edge / Opera: same idea via `edge://extensions` / `opera://extensions`;
5. Firefox: see the `INSTALL.txt` inside the bundle.

### Option 2 — Build from source

```bash
# 1. Install dependencies
npm install

# 2. Download filter lists (raw input for the static rulesets, one-time)
mkdir filters
curl -L -o filters/easylist.txt      https://easylist.to/easylist/easylist.txt
curl -L -o filters/adguard-base.txt  https://filters.adtidy.org/extension/chromium/filters/2.txt

# 3. Build + package
npm run release
```

Full build details, filter-list sources, and Firefox signing steps are in [README.txt](README.txt), Part 2.

---

## 🏗️ Architecture

```
domain-firewall/
├── manifest.json          Chromium manifest
├── manifest.firefox.json  Firefox patch (event page + gecko settings)
├── background.js          Core: rules, listeners, budget, CUSTOM, batches
├── budget-manager.js      Rule budget ledger
├── psl.js                 Public Suffix List (used only by the popup)
├── content.js             Element picker + cosmetic injection
├── popup.* / options.*    UI
├── scripts/               Build scripts
├── filters/               Raw filter lists (not committed)
└── rules/                 Static rulesets (build artifacts)


**Key design decisions:**

- **Reverse allowlist**: `excludedRequestDomains` = whitelist, combined with `action: block` and `domainType: 'thirdParty'`;
- **`main_frame` is never blocked**: top-level navigation is allowed; only subresources are filtered;
- **All DNR writes are serialized** through `dnrQueue` with coalescing, preventing rule-rebuild races;
- **The ledger is rebuilt from `getDynamicRules()` on every SW wake**: no persisted state, no drift.

---

## ⚠️ Known limitations

1. **`psl.js` is a curated list**: unknown suffixes fall back to `slice(-2)`. The actual same-site decision is made by the browser kernel, not by `psl.js`.
2. **Log loss window**: writes are batched (100 ms debounce); if the SW sleeps before flushing, up to ~50 entries may be lost.
3. **Top-level navigation is never blocked**: by design; redirect ads are out of scope.
4. **The two static rulesets cannot both be enabled**: combined they exceed 30,000 and the browser will reject the call.
5. **Firefox is not manually tested**: event page + WASM converter verified only in a simulated environment.
6. **Blocked `<img>` elements get collapsed by the browser**: whitelist the domain first if you want to pick them.

See [README.txt §27](README.txt) for the full list.

---

## 🤝 Contributing

Issues and PRs are welcome. Before submitting:

1. Read [README.txt §20 (cross-browser compatibility)](README.txt);
2. Follow the seven rules in §20.4;
3. After changes, run through the checklist in [README.txt §29](README.txt).

---

## 📄 License

This project is licensed under the **GNU General Public License v3.0**.

GPLv3 was chosen because the project depends on `@adguard/dnr-converter` (GPLv3); per GPLv3's copyleft terms, the distributed work must adopt a compatible license.

- Full license text: [LICENSE](LICENSE);
- Upstream notices: see `node_modules/@adguard/dnr-converter/LICENSE`.

**This project is intended for personal, educational, and non-commercial use only.**

---

## 🙏 Credits

- [`@adguard/dnr-converter`](https://github.com/AdguardTeam/dnr-converter) — EasyList → DNR conversion;
- [`@adguard/re2-wasm`](https://github.com/AdguardTeam/re2-wasm) — regex validation;
- [EasyList](https://easylist.to/) / [AdGuard](https://adguard.com/) — filter lists;
- [Public Suffix List](https://publicsuffix.org/) — public suffix data.

---

<p align="center">
  <sub>Built with ☕ and a healthy distrust of third-party scripts.</sub>
</p>