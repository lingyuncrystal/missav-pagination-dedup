# MissAV 列表增强（missav-list-enhancer）

适用于 [MissAV](https://missav.ws/) 的油猴（Tampermonkey / Violentmonkey）用户脚本，两个功能合一：

## 功能一：翻页去重

MissAV 列表页码翻页时，服务端常在页边界返回与之前页面重复的影片（实测第 6→7 页重叠 1 部、7→8 页重叠 3 部）。本脚本按「列表 + 页码」记住看过的番号，往后翻页时自动隐藏重复卡片，并在页面顶部显示「已隐藏 N 部」提示条。只向前去重，往回翻不受影响；按会话存储，关掉标签页自动清空。

## 功能二：标题修正

站点自带的中文标题机翻质量差，演员名也常被错译。两种模式可选：

- **日文原标题（默认，无需任何 Key）**：自动抓取 `/ja/` 日文原版列表页的标题替换显示，番号、演员名（日文原文）都准确，且几乎零开销（每页一次同源请求）。
- **大模型重译（可选）**：填入 Kimi（Moonshot）API Key 后，在日文原标题基础上调用大模型批量重译为自然流畅的简体中文（演员名保留日文原文），结果持久缓存，每部影片只翻译一次。

页面右下角有浮动「译」按钮，点击打开设置面板：切换模式、填写 API 地址 / Key / 模型、清空缓存。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey）扩展。
2. 点击脚本文件 [missav-list-enhancer.user.js](./missav-list-enhancer.user.js) 的 Raw 链接，扩展会自动弹出安装界面；或将文件内容复制到扩展中手动新建脚本。
3. 打开任意列表页（如 `missav.ws/dm635/cn/release`）翻页即生效。

> 从旧版「MissAV 翻页去重」升级：本脚本 @name 已变更，Tampermonkey 会视为新脚本，请**先删除旧脚本再安装**，避免重复运行。

## 生效范围

```
https://missav.ws/*
https://missav.com/*
```

去重仅在同时存在卡片网格和 `?page=` 翻页链接的列表页上激活；标题修正作用于列表卡片与详情页 h1。

## 实现说明

| 模块 | 说明 |
| --- | --- |
| 翻页去重 | 从 URL `?page=` 取页码，按「路径 + 查询参数」区分列表；重复卡片 `display: none` 隐藏，`sessionStorage` 会话级存储 |
| 日文原标题 | 将当前 URL 语言段替换为 `/ja/` 后用隐藏 iframe 加载（站点有 Cloudflare 人机验证，fetch/XHR 拿不到未缓存页面，iframe 让浏览器自己完成验证），解析卡片标题锚点按 slug 映射替换；各语言列表收录范围不同，缺口的番号再逐个抓日文详情页补齐 |
| 大模型重译 | 兼容 OpenAI 格式的 `/chat/completions`（默认 Kimi `kimi-k2.6`，404 时自动发现可用模型），每批 ≤20 条，`response_format` 不支持时自动降级；跳过被去重隐藏的卡片 |
| 缓存 | `GM_setValue` 持久缓存 slug → 日文/中文标题；MissAV Plus 重渲染标题时由 MutationObserver 防抖回写 |

## 版本

当前版本：**2.0.7**，详见 [CHANGELOG](./CHANGELOG.md)。

## 发布流程

### 原理

Sleazyfork 没有写入 API，官方支持的自动发布方式是「从 URL 同步 + GitHub Webhook」：

```
push 到 main → GitHub 触发 webhook → Sleazyfork 抓取 raw 文件 → @version 更新时才发布
```

### 一次性配置（只需做一次）

1. 登录 Sleazyfork，打开本脚本的管理页 → **Syncing（同步）设置**：
   - 同步方式选 **Webhook**；
   - 同步地址填 raw 文件地址（注意是 `raw` 地址，不能是 `/blob/` 页面地址）：
     ```
     https://raw.githubusercontent.com/lingyuncrystal/missav-pagination-dedup/main/missav-list-enhancer.user.js
     ```
2. 保存后页面会生成本脚本专属的 Webhook URL 和 Secret，复制它们：
   - 到 GitHub 仓库 **Settings → Webhooks → Add webhook**：Payload URL 填该地址，Secret 填生成的密钥，Content type 选 `application/json`，只勾 **push** 事件；
   - 或者在发布时设置环境变量 `SLEAZYFORK_WEBHOOK_URL`，`publish.sh` 会自动完成 webhook 配置。
   - ✅ 本仓库的 webhook 已配置完成（2026-11-12），此步无需再做。
3. 点一次「Sync now」验证 Sleazyfork 能抓到文件。

### 日常发布（改完代码一键发布）

1. 修改 `missav-list-enhancer.user.js`， bump 头部的 `@version`，并在 `CHANGELOG.md` 添加对应条目；
2. 运行：

   ```bash
   ./scripts/publish.sh            # 可加提交说明：./scripts/publish.sh "fix: 修复xxx"
   ```

   脚本会自动完成：语法检查 → 校验版本号必须大于上一个 tag → 补全 CHANGELOG 日期 → 提交 → 打 tag → 推送 GitHub；
3. push 后几秒内 GitHub 触发 webhook，Sleazyfork 完成同步（**仅当 `@version` 比线上新时才发布新版本**）。若 Sleazyfork 几分钟内没更新，到 GitHub 仓库 **Settings → Webhooks → Sleazyfork 那条 → Recent Deliveries** 查看投递状态，失败点 **Redeliver** 重投即可。

先用 `./scripts/publish.sh --dry-run` 可以只检查不发布。

## 许可证

[MIT](./LICENSE)
