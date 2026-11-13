# MissAV 综合增强（missav-enhancer）

适用于 [MissAV](https://missav.ws/)、[Jable](https://jable.tv/) 与 [GetAV](https://getav.net/) 的油猴（Tampermonkey / Violentmonkey）用户脚本：三站统一标题增强 + MissAV 四个专属功能 + GetAV 界面增强。

> ⚠️ **迁移提示（v4.0.0 起）**：本脚本已并入原「GetAV 视频标题完整显示」脚本的全部功能。请**先删除旧 GetAV 脚本**，避免重复运行。

> ⚠️ **迁移提示（v3.0.0 起）**：本脚本由原「MissAV 列表增强（翻页去重 + 标题重译）」与「MissAV 片单网格化」合并而来，`@name` 已变更，Tampermonkey 会视为新脚本。请**先删除两个旧脚本，再安装本脚本**，避免重复运行。原有配置（API Key 等）与标题缓存会自动继承，无需重填。

## 功能一：翻页去重

MissAV 列表页码翻页时，服务端常在页边界返回与之前页面重复的影片（实测第 6→7 页重叠 1 部、7→8 页重叠 3 部）。本脚本按「列表 + 页码」记住看过的番号，往后翻页时自动隐藏重复卡片，并在页面顶部显示「已隐藏 N 部」提示条。只向前去重，往回翻不受影响；按会话存储，关掉标签页自动清空。

## 功能二：标题修正

站点自带的中文标题机翻质量差，演员名也常被错译。两种模式可选：

- **日文原标题（默认，无需任何 Key）**：自动抓取 `/ja/` 日文原版列表页的标题替换显示，番号、演员名（日文原文）都准确，且几乎零开销（每页一次同源请求）。
- **大模型重译（可选）**：选择大模型服务并填入 API Key 后，在日文原标题基础上调用大模型批量重译为自然流畅的简体中文（演员名按通行译名或自然音译），结果持久缓存，每部影片只翻译一次。内置 Kimi（Moonshot）/ DeepSeek / OpenAI / 智谱 GLM 四个常用预设——下拉选择后 API 地址与默认模型自动填好，只需粘贴 Key；「自定义…」支持任意 OpenAI 兼容接口。

## 功能三：片单网格化

把「片单 / 播放列表」页面（`/playlists/*`）的竖向列表布局，改造成和「中文字幕」等分类页一样的缩略图网格卡片布局（手机 2 列 / 平板 3 列 / 宽屏 4 列）。「提交评语」「删除」功能完整保留，默认折叠在卡片下方的「评语 / 删除」开关里；只调整 class 与节点位置，不触碰 Alpine.js 绑定。片单页标题同样享受功能二的标题修正。

## 功能四：预览独占

手机端点卡片、桌面端悬停卡片时会播放预览视频，但站点不会收起上一张卡片的预览——连点多张会多个视频同时挂着播放，浪费流量。本功能在新预览开播时自动暂停其余预览、并让旧卡片**还原显示封面图**；只作用于卡片预览，不影响详情页主播放器。

## 功能五：Jable 标题增强

在 Jable 列表页自动识别卡片标题语言（含假名⇒日文、有汉字无假名⇒中文）：

- **中文原标题**：封面左上角自动加红色「字幕」标识，一眼认出带中文字幕的影片；同时该官方翻译记入缓存（`zhSrc:'jable'`），其他站同番号影片直接复用。
- **非中文原标题**：按三站统一优先级链解析（见下）。

## 三站统一标题解析（缓存 → GetAV → 大模型）

三站以番号为同一性主键互通标题缓存。任何一张卡片的非中文标题按以下优先级解析，**最大限度减少大模型调用**：

1. **缓存**：已有中文标题直接显示（0 请求）；
2. **GetAV 精校中字**：按番号跨站查询 `getav.net/zh/videos/<番号>`（服务端直出，无需 Key、无需 iframe），命中即显示并缓存——GetAV 的中文标题经过精校，质量最高；未收录的番号写 7 天负缓存，不重复查询；
3. **大模型**：GetAV 也没收录的番号，才用日文原标题调大模型重译（需要 API Key）。

中文标题带来源标记（`zhSrc`），优先级 **getav > jable > llm**：高优先级来源可以覆盖低优先级——缓存里的标题会随浏览不断升级成更准的版本。没有 API Key 也能免费享受 GetAV 精校中文。

## 功能六：GetAV 界面增强

原「GetAV 视频标题完整显示」脚本并入：标题解除截断完整显示、列表页标题字号放大一号、「我的订阅」页改为三列网格卡片（窄屏两列）、用 title 属性补全被截断的文字。GetAV 本站的中文标题（精校）自动入缓存，供 MissAV / Jable 同番号影片复用。

## 设置面板

页面右下角有浮动「译」按钮，点击打开设置面板：切换标题模式、选择大模型服务（预设自动填好地址与模型）并填写 API Key、清空缓存，以及各功能的独立开关（翻页去重、片单网格化、预览独占的开关改动后刷新页面生效）。

**跨浏览器迁移**：面板里「导出配置+缓存」生成 JSON 备份（含 API Key 与全部标题缓存），存到 iCloud 云盘或其他地方后，在另一个浏览器里「导入」即可，不依赖脚本管理器的云同步功能。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey）扩展。
2. 点击脚本文件 [missav-enhancer.user.js](./missav-enhancer.user.js) 的 Raw 链接，扩展会自动弹出安装界面；或将文件内容复制到扩展中手动新建脚本。
3. 打开任意列表页（如 `missav.ws/dm635/cn/release`）或片单页翻页即生效。

## 生效范围

```
https://missav.ws/*
https://missav.com/*
https://jable.tv/*
*://getav.net/*
*://*.getav.net/*
```

去重仅在同时存在卡片网格和 `?page=` 翻页链接的列表页上激活（MissAV）；标题修正作用于列表卡片与详情页 h1；网格化仅作用于 MissAV 片单页；Jable / GetAV 上启用标题增强，GetAV 上额外启用界面增强。

## 实现说明

| 模块 | 说明 |
| --- | --- |
| utils | 共享工具：`waitFor` 就绪轮询、`debounce`、slug 提取、统一日志；业务模块只通过 DOM 约定间接协作 |
| rescue | 反爬自救：站点偶尔返回永久空白的 JS 验证页，检测后给 URL 加无用参数刷新绕过 |
| grid | 片单网格化：复用站点自带 Tailwind 工具类；只调 class 与节点位置，不破坏 Alpine.js；MissAV Plus 注入错位的筛选条自动移回 |
| dedup | 翻页去重：从 URL `?page=` 取页码，按「路径 + 查询参数」区分列表；重复卡片 `display: none` 隐藏，`sessionStorage` 会话级存储 |
| preview | 预览独占：`play` 事件不冒泡，在 document 捕获阶段监听；新预览开播时暂停其余预览，并把旧卡片 id 从 Alpine `holdPreviews` 状态数组移除以还原封面（识别特征：`loop` 循环或 preview.mp4 源），不碰详情页主播放器 |
| titles | 标题修正：隐藏 iframe 抓 `/ja/` 页面（站点有 Cloudflare 人机验证，fetch/XHR 拿不到未缓存页面，iframe 让浏览器自己完成验证）；大模型重译兼容 OpenAI 格式 `/chat/completions`（404 时自动发现可用模型），每批 ≤20 条，`response_format` 不支持时自动降级。Jable 走独立流程：按假名/汉字判定标题语言，中文加「字幕」徽章、日文记缓存后走同一套大模型翻译，中文原文不入缓存避免污染两站共用缓存 |
| settings-ui | 浮动按钮 + 设置面板；大模型服务预设（`PROVIDERS`）下拉选择自动填地址/模型，旧配置按 baseUrl 反推归类；`GM_setValue` 持久缓存 slug → 日文/中文标题；Jable 上自动隐藏 MissAV 专属开关；MissAV Plus 重渲染标题时由 MutationObserver 防抖回写 |
| getav-ui | GetAV 界面增强（原独立脚本并入）：解除标题截断、title 属性补全、列表页标题放大、订阅页三列网格；独立 MutationObserver 增量扫描新增节点 |

## 版本

当前版本：**3.3.0**，详见 [CHANGELOG](./CHANGELOG.md)。

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
     https://raw.githubusercontent.com/lingyuncrystal/missav-pagination-dedup/main/missav-enhancer.user.js
     ```
   - ⚠️ v3.0.0 更名文件后，需把同步地址从旧的 `missav-list-enhancer.user.js` 改为上面的新地址（webhook 本身不用重配）。
2. 保存后页面会生成本脚本专属的 Webhook URL 和 Secret，复制它们：
   - 到 GitHub 仓库 **Settings → Webhooks → Add webhook**：Payload URL 填该地址，Secret 填生成的密钥，Content type 选 `application/json`，只勾 **push** 事件；
   - 或者在发布时设置环境变量 `SLEAZYFORK_WEBHOOK_URL`，`publish.sh` 会自动完成 webhook 配置。
   - ✅ 本仓库的 webhook 已配置完成（2026-11-12），此步无需再做。
3. 点一次「Sync now」验证 Sleazyfork 能抓到文件。

### 日常发布（改完代码一键发布）

1. 修改 `missav-enhancer.user.js`， bump 头部的 `@version`，并在 `CHANGELOG.md` 添加对应条目；
2. 运行：

   ```bash
   ./scripts/publish.sh            # 可加提交说明：./scripts/publish.sh "fix: 修复xxx"
   ```

   脚本会自动完成：语法检查 → 校验版本号必须大于上一个 tag → 补全 CHANGELOG 日期 → 提交 → 打 tag → 推送 GitHub；
3. push 后几秒内 GitHub 触发 webhook，Sleazyfork 完成同步（**仅当 `@version` 比线上新时才发布新版本**）。若 Sleazyfork 几分钟内没更新，到 GitHub 仓库 **Settings → Webhooks → Sleazyfork 那条 → Recent Deliveries** 查看投递状态，失败点 **Redeliver** 重投即可。

先用 `./scripts/publish.sh --dry-run` 可以只检查不发布。

## 许可证

[MIT](./LICENSE)
