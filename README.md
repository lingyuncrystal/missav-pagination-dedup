# MissAV 翻页去重（missav-pagination-dedup）

适用于 [MissAV](https://missav.ws/) 的油猴（Tampermonkey / Violentmonkey）用户脚本：

- **自动隐藏翻页重复**：MissAV 列表页码翻页时，服务端常在页边界返回与之前页面重复的影片（实测第 6→7 页重叠 1 部、7→8 页重叠 3 部）。本脚本按「列表 + 页码」记住看过的番号，往后翻页时自动隐藏重复卡片。
- **只向前去重**：往回翻页不受影响；按会话存储（sessionStorage），关掉标签页自动清空。
- **重复提示**：隐藏时页面顶部显示「已隐藏 N 部与之前页面重复的影片」提示条，去重过程透明可见。
- **兼容增强脚本**：只做 `display: none` 隐藏，与 MissAV Plus 的过滤/黑名单/完整标题等功能互不干扰。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey）扩展。
2. 点击脚本文件 [missav-pagination-dedup.user.js](./missav-pagination-dedup.user.js) 的 Raw 链接，扩展会自动弹出安装界面；或将文件内容复制到扩展中手动新建脚本。
3. 打开任意带页码翻页的列表页（如 `missav.ws/dm635/cn/release?page=6`）翻页即生效。

## 生效范围

```
https://missav.ws/*
https://missav.com/*
```

（仅在同时存在卡片网格和 `?page=` 翻页链接的列表页上激活，首页/详情页/片单页不受影响。）

## 实现说明

| 模块 | 说明 |
| --- | --- |
| 页码识别 | 从 URL `?page=` 参数取当前页码，缺省为 1 |
| 列表身份 | 路径 + 除 `page` 外的查询参数，不同分类/筛选互不影响 |
| 去重范围 | 仅对**更早页码**出现过的番号去重，向前翻页不回溯 |
| 存储 | `sessionStorage` 按会话保存各页番号，标签页关闭即清空 |
| 隐藏方式 | 重复卡片 `display: none`，网格自动重排；顶部提示条显示隐藏数量 |

## 重复现象的技术背景

MissAV 列表按「发行日期」倒序，同一日期成批上架的影片之间没有稳定的唯一排序；当页边界恰好切在同日期影片块中时，服务端会在相邻页返回相同的影片（重叠数量不固定，实测 1～3 部），叠加分页缓存使重复在一段时间内稳定复现。这属于服务端行为，只能通过客户端去重规避。

## 版本

当前版本：**1.0.0**，详见 [CHANGELOG](./CHANGELOG.md)。

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
     https://raw.githubusercontent.com/lingyuncrystal/missav-pagination-dedup/main/missav-pagination-dedup.user.js
     ```
2. 保存后页面会生成本脚本专属的 Webhook URL 和 Secret，复制它们：
   - 到 GitHub 仓库 **Settings → Webhooks → Add webhook**：Payload URL 填该地址，Secret 填生成的密钥，Content type 选 `application/json`，只勾 **push** 事件；
   - 或者在发布时设置环境变量 `SLEAZYFORK_WEBHOOK_URL`，`publish.sh` 会自动完成 webhook 配置。
   - ✅ 本仓库的 webhook 已配置完成（2026-11-12），此步无需再做。
3. 点一次「Sync now」验证 Sleazyfork 能抓到文件。

### 日常发布（改完代码一键发布）

1. 修改 `missav-pagination-dedup.user.js`， bump 头部的 `@version`，并在 `CHANGELOG.md` 添加对应条目；
2. 运行：

   ```bash
   ./scripts/publish.sh            # 可加提交说明：./scripts/publish.sh "fix: 修复xxx"
   ```

   脚本会自动完成：语法检查 → 校验版本号必须大于上一个 tag → 补全 CHANGELOG 日期 → 提交 → 打 tag → 推送 GitHub；
3. push 后几秒内 GitHub 触发 webhook，Sleazyfork 完成同步（**仅当 `@version` 比线上新时才发布新版本**）。若 Sleazyfork 几分钟内没更新，到 GitHub 仓库 **Settings → Webhooks → Sleazyfork 那条 → Recent Deliveries** 查看投递状态，失败点 **Redeliver** 重投即可。

先用 `./scripts/publish.sh --dry-run` 可以只检查不发布。

## 许可证

[MIT](./LICENSE)
