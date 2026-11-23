# GetAV Actor Tabs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 GetAV 详情页演员卡片内加入“简介 / 影片介绍”双 Tab，并在卡片临近视口时预加载 7mmtv 内容。

**Architecture:** 在现有 React 水合门控之后定位演员卡片，保留原生演员内容，仅插入独立 Tab 栏和影片介绍面板。复用已有 7mmtv 数据层与渲染层，通过 IntersectionObserver 预加载，并用 MutationObserver 支持客户端路由和重渲染恢复。

**Tech Stack:** 原生 JavaScript userscript、ScriptCat/Tampermonkey GM API、React 页面 DOM、IntersectionObserver、MutationObserver、Node DOM 夹具。

---

### Task 1: 详情路由与演员卡片定位

**Files:**
- Modify: `missav-enhancer.user.js`
- Create: `scripts/test-getav-actor-tabs.mjs`

1. 写失败夹具：仅 `/videos/<番号>` 返回当前 slug；列表路由拒绝。
2. 写失败夹具：按演员/女优标题与资料链接定位卡片，歧义时返回空。
3. 实现最小路由与定位函数。
4. 运行 `node scripts/test-getav-actor-tabs.mjs`，预期定位测试通过。

### Task 2: 非侵入双 Tab 与预加载

**Files:**
- Modify: `missav-enhancer.user.js`
- Modify: `scripts/test-getav-actor-tabs.mjs`

1. 写失败夹具：默认简介、切换显示、幂等挂载、`rootMargin: 300px 0px`、单次加载和失败重试。
2. 插入 Tab 栏与独立影片介绍面板；仅隐藏/显示原演员内容，不移动原节点。
3. 复用 `load7mmtvIntro()` 与 `renderFilmIntro()`。
4. 在 `initGetavUi()` 初始化并在增量扫描中恢复被 React 移除的 Tab。
5. 运行夹具，预期全部通过。

### Task 3: 版本与发布验证

**Files:**
- Modify: `missav-enhancer.user.js`
- Modify: `CHANGELOG.md`
- Modify: `docs/plans/2026-11-19-film-intro-debug-status.md`

1. 提升研发版本并记录 GetAV 演员卡片双 Tab。
2. 运行新夹具、既有 `test-film-intro.mjs`、`test-jable-titles.mjs`。
3. 运行 `node --check`、ScriptCat 静态检查、`git diff --check`。
4. 运行 `publish-dev.sh --dry-run`，预期全部通过。
5. 提交并推送 `dev`，确认 GitHub Raw 版本后交由手机真站验证。
