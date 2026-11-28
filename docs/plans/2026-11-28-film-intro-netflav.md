# 影片介绍数据源切换：7mmtv.sx → netflav.com

日期：2026-11-28（研发版 v4.0.30-dev.43）

**Goal:** MissAV「影片介绍」Tab、Jable 影片介绍卡片、GetAV 演员卡片「影片介绍」Tab 三处共用的数据层，从 `https://7mmtv.sx` 换成 `https://netflav.com`。

**Architecture:** 三站原本就共用 `load7mmtvIntro(slug)`，切换只需替换这一层：`/search` 定位 `videoId` → `/video` 取正文与图片，其余（Tab 注入、IntersectionObserver 预载、渲染、缓存、错误重试）保持不动并改名为 `loadNetflavIntro()`。

## 实测事实（2026-11-28，curl + Node fetch）

| 项 | 结论 |
| --- | --- |
| 站点类型 | Next.js，整页状态直出在 `<script id="__NEXT_DATA__">`，**无需执行页面 JS** |
| 搜索 | `GET /search?type=all&keyword=<番号>`，结果在 `props.initialState.search.docs[]`，含 `code` / `uCode` / `videoId` / `previewImages` |
| 搜索语义 | **模糊匹配**：`ABP-123` 返回 130 条，前几条是 `ABP-113`、`ABP-143`、`ABP-132`，精确项可能不在第一页 |
| 分页 | `&page=2` 对部分查询直接返回 1 字节（服务端不稳定），**不可依赖** |
| 关键词写法 | `JUR857` 返回 0 条，`JUR-857` 返回 2 条；`SONE604` 与 `SONE-604` 都能命中 → 先按原样查，落空再用紧凑写法补查一次 |
| 详情 | `GET /video?id=<videoId>`，`props.initialState.video.data` 里 `description`（介绍正文）、`previewImages[]`（预览图）、`code` 齐全 |
| DOM 兜底 | 详情页正文同时渲染在 `.videocoverheader_description`，番号在 `.videocoverheader_code` |
| 番号写法 | FC2 在库里存成 `FC2-PPV 4507566`（**空格**），MissAV/Jable 的 slug 是 `fc2-ppv-4507566`（连字符）→ 归一化必须连空格一起忽略 |
| 收录完整度 | 有数据库缺口：`mide-001`、`fc2-ppv-5075665` 查不到（同系列 `MIDE-081` 等有） |

## 实现要点

1. `normalizeFilmCode()`：小写 + 去掉所有非字母数字（大小写、连字符、下划线、空格差异全部归零）。
2. `searchNetflavVideoId(keyword)`：解析 `search.docs`，按 `code` / `uCode`（含 `-C` / `-U` 变体）**精确比对**，模糊结果一律拒绝——认错片比没有介绍更糟。
3. `parseNetflavIntro(html, slug)`：优先 `__NEXT_DATA__`；番号不一致直接返回 `null`；`__NEXT_DATA__` 缺失时退回 DOM 取 `.videocoverheader_description`。
4. `fetchNetflavIntro(slug)`：`baseCodeFromSlug()` 剥版本后缀 → 搜索（必要时补一次紧凑写法）→ 详情 → 返回 `{ text, images, url }`。
5. `loadNetflavIntro(slug)`：内存缓存命中直接返回，负结果不缓存（与标题负缓存策略一致）。
6. `httpPost()` 删除（只服务 7mmtv 的搜索表单）；`@connect 7mmtv.sx` → `@connect netflav.com`。
7. `baseCodeFromSlug()` 同时被 `slugFromHref()` 复用，MissAV 的 `-chinese-subtitle` / `-uncensored-leak` 等后缀规则只留一份。

## 验证

- `node --check missav-enhancer.user.js` 通过。
- `node scripts/test-film-intro-source.mjs`（新增）：归一化、后缀剥离、精确匹配（拒绝模糊）、`__NEXT_DATA__` 解析、DOM 兜底、搜索→详情→缓存链路、三站调用点与 `@connect` 断言，全部通过。
- `scripts/test-film-intro.mjs` 更新注入的函数名后通过；其余 6 个脚本单测保持通过。
- 真实网络跑数据层（Node fetch，非 GM_xhr）：

| 番号 | 结果 |
| --- | --- |
| `sone-604` | 326 字 + 13 图 |
| `jur-857` | 163 字 + 10 图 |
| `miaa-711` | 199 字 + 10 图 |
| `ipzz-963-chinese-subtitle` | 171 字 + 12 图（后缀已剥离） |
| `fc2-ppv-4507566` | 81 字 + 1 图（命中库里的空格写法） |
| `mide-001` / `jable-xxx` | 未找到（netflav 未收录 / 非法番号） |

## 实装验证（Chrome 158 + ScriptCat 1.5.2，真站）

本地构建经 `sctl edit` 内容锚定替换进 ScriptCat 里已安装的同一脚本（UUID `74e8cff9-…`，身份/更新源不变），装后源码与工作区文件逐字节一致、版本 `4.0.30-dev.43`。

| 站点 / 页面 | 操作 | 结果 |
| --- | --- | --- |
| MissAV `missav.ws/sone-604` | 点「影片介绍」Tab | 面板 `display:block`，13 张图全部 `naturalWidth>0`（无防盗链问题），来源链接 `netflav.com/video?id=bnwYqWml4l` |
| Jable `jable.tv/videos/jur-857/` | 滚动到卡片（触发 IntersectionObserver） | 自动加载成功，10 张图全部加载，来源 `netflav.com/video?id=gG5VrKud8H` |
| GetAV `getav.net/zh/videos/sone-604` | 演员卡片切到「影片介绍」 | 双 Tab 切换正常，13 张图全部加载，与 MissAV 同源同内容 |
| MissAV `missav.ws/dm78/mide-001` | 点「影片介绍」Tab | 显示「netflav 未找到对应的影片介绍。」（netflav 未收录，负路径符合预期） |

回归：三站标题增强（GetAV `[4K/无码/精校中字]`、Jable 繁中、MissAV 简中）与设置面板「译✓ / 诊断」入口均正常，未受本次改动影响。

截图（本轮临时，未入库）：`/tmp/missav-intro.png`、`/tmp/jable-intro.png`、`/tmp/getav-intro.png`。

## 已知差异与后续可选项

- **图片类型变化**：netflav 的 `previewImages` 是 DMM 官方样张（带 `madonna-av.com`、`S1` 等水印），与 7mmtv 的无码截图观感不同；数量 10–20 张，与原来相当。
- **收录缺口**：netflav 库比 7mmtv 更偏「有码商业作品」，FC2 / 部分老番号会显示「未找到」。如需覆盖，可考虑：① 未找到时回退 7mmtv（需要恢复已删除的 `httpPost`）；② 无码/FC2 番号改用其他源。
- **搜索分页不可用**：`&page=2` 对部分查询返回 1 字节，因此只查第一页 + 紧凑写法补查；若某番号恰好排在第二页之后，会误判为未收录（实测已命中的番号都在第一页）。
