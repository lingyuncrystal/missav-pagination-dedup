# Jable Film Introduction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Jable 视频详情页的标签区域与评论反馈框之间增加滚动临近时自动加载的 7mmtv 影片介绍卡片。

**Architecture:** 复用现有 7mmtv 搜索、解析、缓存和渲染函数，仅新增 Jable 详情页识别、DOM 锚点定位与懒加载卡片。卡片通过标签链接定位插入点；进入视口前 300px 时触发一次请求，失败时提供显式重试。

**Tech Stack:** 原生 JavaScript userscript、ScriptCat/Tampermonkey GM API、DOM MutationObserver、IntersectionObserver。

---

### Task 1: Jable 详情页与插入锚点

**Files:**
- Modify: `missav-enhancer.user.js`

1. 增加仅匹配 `/videos/<slug>/` 的 Jable 详情页番号提取函数。
2. 从 `/tags/` 链接识别标签内容块；优先插在标签块之后，并保证位于评论/反馈容器之前。
3. 页面内容延迟出现时用 MutationObserver 重试挂载，挂载成功后停止观察。
4. 用最小 DOM 夹具验证详情页识别、非详情页拒绝、标签锚点选择和幂等挂载。

### Task 2: 懒加载影片介绍卡片

**Files:**
- Modify: `missav-enhancer.user.js`

1. 创建 Jable 深色卡片，包含标题、状态正文和来源区域。
2. 使用 IntersectionObserver（`rootMargin: 300px 0px`）在滚动临近时触发一次 `load7mmtvIntro(slug)`。
3. 复用 `renderFilmIntro` 展示文字、原比例全宽图片和来源链接。
4. 请求失败时显示错误与“重新加载”按钮；不支持 IntersectionObserver 时立即加载作为兼容降级。

### Task 3: 版本、记录与验证

**Files:**
- Modify: `missav-enhancer.user.js`
- Modify: `CHANGELOG.md`
- Modify: `docs/plans/2026-11-19-film-intro-debug-status.md`

1. 版本提升到 `4.0.30-dev.23`，记录 Jable 新功能与手机待测项目。
2. 运行 `node --check missav-enhancer.user.js`，预期通过。
3. 运行 ScriptCat 静态检查，预期无 error/warn。
4. 运行 DOM 夹具、`git diff --check` 和 `./scripts/publish-dev.sh --dry-run`，预期全部通过。
5. 提交并推送 `dev` 后检查 GitHub Raw 的 `@version`，再由手机真站验证布局、懒加载、图片和重试。
