// ==UserScript==
// @name         MissAV 综合增强（翻页去重 + 标题修正 + 片单网格化）
// @namespace    https://missav.ws/
// @version      4.0.1
// @description  MissAV / Jable / GetAV 三站合一：1) 翻页去重（MissAV）；2) 三站统一标题增强——中文标题按「缓存 → GetAV 精校中字 → 大模型」优先级解析，番号为同一性主键跨站复用，最大限度少用大模型；大模型服务内置 Kimi/DeepSeek/OpenAI/GLM 预设；3) 片单网格化（MissAV）；4) 预览独占（MissAV）；5) GetAV 界面增强——标题完整显示、列表页标题放大、订阅页网格卡片（原 GetAV 脚本并入）
// @author       lingyuncrystal
// @license      MIT
// @icon         https://missav.ws/favicon.ico
// @updateURL    https://raw.githubusercontent.com/lingyuncrystal/missav-pagination-dedup/main/missav-enhancer.user.js
// @downloadURL  https://raw.githubusercontent.com/lingyuncrystal/missav-pagination-dedup/main/missav-enhancer.user.js
// @match        https://missav.ws/*
// @match        https://missav.com/*
// @match        https://missav.ai/*
// @match        https://jable.tv/*
// @match        *://getav.net/*
// @match        *://*.getav.net/*
// MissAV 经常更换域名后缀，用 @include 正则兜底所有 missav.<TLD> 变体
// （正则要求 missav. 后紧跟纯字母 TLD 和 /，不会被 missav.evil.com 这类域名欺骗）
// @include      /^https?:\/\/([^/]*\.)?missav\.[a-z]{2,}\//
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    /* ================================================================
     * 模块〇 utils：共享工具
     * 凡是两个以上模块需要的能力都沉到这里；业务模块之间不互相调用，
     * 只通过共享的 DOM 约定（.thumbnail、dataset 标记）间接协作。
     * ================================================================ */

    const LOG_PREFIX = '[MissAV 综合增强]';

    /** 站点识别：rescue/grid/dedup/preview 是 MissAV 专属，getav-ui 是 GetAV 专属；titles 与设置面板三站共用 */
    const SITE = /(^|\.)jable\.tv$/i.test(location.hostname) ? 'jable'
        : /(^|\.)getav\.net$/i.test(location.hostname) ? 'getav'
        : 'missav';

    /** 统一日志（用 warn 级别，普通控制台过滤 info 时仍可见） */
    function log(...args) {
        console.warn(LOG_PREFIX, ...args);
    }

    /**
     * 短轮询等待某个条件成立，返回 Promise<boolean>（true = 条件达成）。
     * 页面是服务端渲染 + Alpine，document-idle 时 DOM 通常已就绪；
     * 轮询几秒应对慢网络 / 客户端渲染。超时静默放弃，由调用方降级。
     */
    function waitFor(checkFn, { interval = 300, tries = 20 } = {}) {
        return new Promise((resolve) => {
            let n = 0;
            const timer = setInterval(() => {
                let ok = false;
                try {
                    ok = checkFn();
                } catch (e) {
                    log(e);
                }
                if (ok || ++n > tries) {
                    clearInterval(timer);
                    resolve(!!ok);
                }
            }, interval);
        });
    }

    /** 尾随防抖：合并 MutationObserver 的高频回调 */
    function debounce(fn, ms) {
        let timer = null;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), ms);
        };
    }

    /** 从链接（或当前 URL）提取番号 slug：路径末段小写，如 madv-646 */
    function slugFromHref(href) {
        try {
            const seg = new URL(href, location.origin).pathname.split('/').filter(Boolean);
            return (seg[seg.length - 1] || '').toLowerCase() || null;
        } catch {
            return null;
        }
    }

    /* ================================================================
     * 模块一 rescue：反爬挑战页自救
     * 站点偶尔对某个 URL 只返回混淆 JS 验证页（body 极小、无任何内容，
     * 且验证脚本在部分环境（尤其手机）根本不执行，页面永久空白）。
     * 实测同一 URL 加一个无用参数即可绕过（验证按「完整 URL」触发）。
     * ================================================================ */

    function isChallengePage() {
        // 验证页：无卡片无 h1、正文几乎无文本、含混淆脚本特征
        if (document.querySelector('.thumbnail') || document.querySelector('h1')) return false;
        const text = document.body ? document.body.textContent.trim() : '';
        const html = document.documentElement.innerHTML;
        return text.length < 100 && /_0x[0-9a-f]{4,}/i.test(html);
    }

    function rescueChallengePage() {
        const check = () =>
            setTimeout(() => {
                if (!isChallengePage()) return;
                const u = new URL(location.href);
                if (u.searchParams.has('_mve')) return; // 已试过一次，防止循环
                console.warn(LOG_PREFIX, '检测到反爬验证空白页，自动绕过…');
                u.searchParams.set('_mve', Date.now().toString(36));
                location.replace(u.href);
            }, 2000);
        if (document.readyState === 'complete') check();
        else window.addEventListener('load', check, { once: true });
    }

    /* ================================================================
     * 模块二 grid：片单页网格化（仿分类页样式）
     * 只做 class / 位置调整，不碰 Alpine.js 的 x-data / x-ref 绑定，
     * 因此「提交评语」「删除」功能保持可用。
     * ================================================================ */

    const isPlaylistPage = location.pathname.includes('/playlists/');
    let gridUl = null; // 网格化完成的列表容器，供 Observer 纠正 MissAV Plus 注入错位

    function applyGridLayout() {
        // 片单条目列表（页面里唯一一个 mb-12 space-y-8 的 ul）
        const ul = document.querySelector('ul.mb-12.space-y-8');
        if (!ul) return false;
        if (ul.dataset.maeGridified === '1') return true; // 已处理过

        // 1. 容器：竖向列表 -> 分类页同款响应式网格
        ul.classList.remove('space-y-8');
        ul.classList.add('grid', 'grid-cols-2', 'md:grid-cols-3', 'xl:grid-cols-4', 'gap-5');

        ul.querySelectorAll(':scope > li').forEach((li) => {
            // 2. 条目：去掉横向 flex 布局，变成普通块级卡片
            li.classList.remove('sm:flex', 'w-72', 'sm:w-full', 'mx-auto');

            // 3. 缩略图外层包装：去掉固定宽度，让封面铺满卡片
            const wrap = li.querySelector(':scope > div');
            if (wrap) wrap.className = '';

            const thumbnail = li.querySelector('.thumbnail');
            const form = li.querySelector(':scope > form');
            const label = form ? form.querySelector('label') : null;

            // 4. 标题：把表单里的 label 换成分类页同款「图下方标题链接」。
            //    结构与分类页一致（.thumbnail 内的 .my-2.text-sm > a），
            //    只用 class 不加内联样式：装了 MissAV Plus 的用户由其
            //    「完整标题」等设置接管显示效果，未装则为单行截断。
            //    该结构同时被 titles 模块的 collectCards 识别，
            //    因此片单页标题也能自动获得日文原标题 / 大模型重译。
            if (thumbnail && label) {
                const href = (thumbnail.querySelector('a[href]') || {}).href || '#';
                const titleDiv = document.createElement('div');
                titleDiv.className = 'my-2 text-sm text-nord4 truncate';
                const a = document.createElement('a');
                a.className = 'text-secondary group-hover:text-primary';
                a.href = href;
                a.textContent = label.textContent.trim();
                titleDiv.appendChild(a);
                // 放进 .thumbnail.group 内部，和分类页 DOM 结构一致
                thumbnail.appendChild(titleDiv);
                label.remove();
            }

            // 5. 评语表单：默认折叠，加一个小开关，保持卡片整洁
            if (form) {
                form.classList.remove('grow');
                form.style.display = 'none';
                const textarea = form.querySelector('textarea');
                if (textarea) textarea.rows = 2;

                const toggle = document.createElement('button');
                toggle.type = 'button';
                toggle.textContent = '评语 / 删除';
                toggle.className =
                    'mt-1 text-xs text-nord8 hover:text-primary underline underline-offset-2';
                toggle.addEventListener('click', () => {
                    const hidden = form.style.display === 'none';
                    form.style.display = hidden ? '' : 'none';
                    toggle.textContent = hidden ? '收起' : '评语 / 删除';
                });
                // 插到缩略图后面、表单前面
                li.insertBefore(toggle, form);
            }
        });

        ul.dataset.maeGridified = '1';
        gridUl = ul;
        relocateStrayFilterBars(ul);
        return true;
    }

    /**
     * MissAV Plus 在找不到站内排序栏时，会把 .mv-filter-injected-header
     * 注入到片单第一个卡片的包装 div 里，把该卡封面顶下去造成一行图片错位。
     * 把误入卡片的筛选条移到列表容器外（ul 之前），恢复卡片对齐。
     */
    function relocateStrayFilterBars(ul) {
        ul.querySelectorAll(':scope > li .mv-filter-injected-header').forEach((bar) => {
            ul.parentElement.insertBefore(bar, ul);
        });
    }

    /* ================================================================
     * 模块三 dedup：翻页去重（列表页码边界重叠的影片自动隐藏）
     * ================================================================ */

    const DEDUP_STORE_KEY = 'missav-dedup-v1';

    function currentPage() {
        const p = parseInt(new URL(location.href).searchParams.get('page') || '1', 10);
        return Number.isFinite(p) && p > 0 ? p : 1;
    }

    function listKey() {
        const u = new URL(location.href);
        u.searchParams.delete('page');
        u.searchParams.delete('_mve'); // 绕过反爬的缓存破坏参数，不影响列表身份
        return u.pathname + u.search;
    }

    function loadDedupStore() {
        try {
            return JSON.parse(sessionStorage.getItem(DEDUP_STORE_KEY) || '{}');
        } catch {
            return {};
        }
    }

    function saveDedupStore(store) {
        try {
            sessionStorage.setItem(DEDUP_STORE_KEY, JSON.stringify(store));
        } catch {
            /* 存储满时静默放弃，去重退化为当页无效 */
        }
    }

    /** 从卡片元素提取番号 slug（复用 utils 的 slugFromHref） */
    function slugOf(card) {
        const a = card.querySelector('a[href]');
        return a ? slugFromHref(a.href) : null;
    }

    function showNotice(grid, count) {
        const id = 'missav-dedup-notice';
        let bar = document.getElementById(id);
        if (count <= 0) {
            if (bar) bar.remove();
            return;
        }
        if (!bar) {
            bar = document.createElement('div');
            bar.id = id;
            bar.style.cssText =
                'margin:0 0 12px;padding:8px 12px;border-radius:8px;' +
                'background:rgba(59,124,215,.12);border:1px solid rgba(59,124,215,.35);' +
                'color:#9db8dd;font-size:13px;line-height:1.4;';
            grid.parentElement.insertBefore(bar, grid);
        }
        bar.textContent = `已隐藏 ${count} 部与之前页面重复的影片（站点翻页重叠）`;
    }

    function dedup() {
        const hasPagination = !!document.querySelector('a[href*="page="]');
        // 注意：只认 div.grid。grid 模块网格化出来的是 ul，但片单页没有
        // ?page= 翻页链接，hasPagination 前置条件不成立，天然不会误伤
        const grid = [...document.querySelectorAll('div.grid')].find((e) =>
            e.className.includes('xl:grid-cols-4')
        );
        if (!hasPagination || !grid) return false;
        if (grid.dataset.maeDeduped === '1') return true;

        const page = currentPage();
        const store = loadDedupStore();
        const listData = store[listKey()] || { pages: {} };

        const seen = new Set();
        Object.entries(listData.pages).forEach(([p, slugs]) => {
            if (parseInt(p, 10) < page) slugs.forEach((s) => seen.add(s));
        });

        const current = [];
        let hidden = 0;
        grid.querySelectorAll(':scope > *').forEach((card) => {
            const slug = slugOf(card);
            if (!slug) return;
            current.push(slug);
            if (seen.has(slug)) {
                card.style.display = 'none';
                hidden++;
            }
        });

        listData.pages[page] = current;
        store[listKey()] = listData;
        saveDedupStore(store);
        showNotice(grid, hidden);

        grid.dataset.maeDeduped = '1';
        return true;
    }

    /* ================================================================
     * 模块四 preview：预览独占播放
     * 每张卡片自带一个 <video muted loop>（display:none），站点用 Alpine
     * 管理预览：桌面悬停驱动 showPreview，手机点按调用 clickPreview(uuid)
     * 把卡片 id 存进 holdPreviews 数组「保持预览」——video 和封面 img 的
     * hidden class 都由这个数组驱动。站点从不清理旧 id，连点多张卡片
     * 就会多个预览同时挂着播放，浪费流量和性能。
     * 原理：play 事件【不冒泡】，但捕获阶段会经过祖先节点，所以在
     * document 上以捕获方式监听即可截获所有 video 的播放；
     * 新预览开播时：1) 暂停其余预览视频；2) 把其余 id 从 holdPreviews
     * 中移除，让 Alpine 重渲染自动藏起旧视频、还原封面图。
     * （不能只改 class——Alpine 下次重渲染会按旧状态改回去）
     * 只动预览视频，不碰详情页主播放器。
     * ================================================================ */

    /** 判断是否为预览视频（loop 循环或 preview.mp4 源）；详情页主播放器不符合 */
    function isPreviewVideo(v) {
        return v instanceof HTMLVideoElement &&
            (v.loop || /preview/i.test(v.currentSrc || v.src || ''));
    }

    function initPreviewExclusive() {
        document.addEventListener('play', (e) => {
            const v = e.target;
            if (!isPreviewVideo(v)) return;

            // 1. 暂停其余预览视频
            document.querySelectorAll('video').forEach((other) => {
                if (other !== v && isPreviewVideo(other) && !other.paused) {
                    other.pause();
                }
            });

            // 2. 还原封面：从 Alpine 组件数据栈里找 holdPreviews，只保留当前 id。
            //    原地 splice 修改，确保 Alpine 响应式捕获并重渲染 class。
            const keepId = (v.id || '').replace(/^preview-/, '');
            if (!keepId) return;
            document.querySelectorAll('[x-data]').forEach((el) => {
                (el._x_dataStack || []).forEach((frame) => {
                    if (!frame || !Array.isArray(frame.holdPreviews)) return;
                    const rest = frame.holdPreviews.filter((id) => id === keepId);
                    if (rest.length !== frame.holdPreviews.length) {
                        frame.holdPreviews.splice(0, frame.holdPreviews.length, ...rest);
                    }
                });
            });
        }, true); // 第三个参数 true = 捕获阶段监听
    }

    /* ================================================================
     * 模块五 titles：标题修正（日文原标题 / 大模型重译）
     * 大模型服务商预设见 PROVIDERS：选中即自动填好地址与默认模型，
     * 用户只需粘贴 Key；「自定义」保留手填入口（OpenAI 兼容接口）。
     * Jable 走独立流程：中文原标题封面加「字幕」徽章，日文原标题
     * 就在当前页 DOM（无需抓镜像页），llm 模式下大模型翻译为中文。
     * ================================================================ */

    // 预设核对日期 2026-11-13（官方文档/变更日志逐一查证）：
    // - kimi-k2.6 在现行模型列表（k3 始终推理、不适合翻译；k2.6 可关思考提速）
    // - deepseek-chat / deepseek-reasoner 已于 2026-07-24 停用，现行为 v4-flash / v4-pro
    // - gpt-4o-mini 目前可调，但官方已公告 2027-01-14 退役——届时 404 自动发现机制接管
    // - glm-4.7-flash 为现行免费款（glm-4.5-flash 已下线并自动路由到 4.7-flash）
    // modelPrefs：/models 自动发现时的挑选优先级（正则按序匹配），服务商专属
    const PROVIDERS = [
        { id: 'kimi', name: 'Kimi（Moonshot）', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2.6', keyHint: 'platform.kimi.com', modelPrefs: [/^kimi-k2\.6$/, /^kimi-k2\./, /^kimi-k3/, /^kimi/] },
        { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', keyHint: 'platform.deepseek.com', modelPrefs: [/^deepseek-v4-flash$/, /^deepseek-v4/, /^deepseek/] },
        { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyHint: 'platform.openai.com', modelPrefs: [/^gpt-4o-mini$/, /mini/i, /^gpt-4o$/, /^gpt-/] },
        { id: 'glm', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7-flash', keyHint: 'open.bigmodel.cn', modelPrefs: [/^glm-4\.7-flash$/i, /flash/i, /^glm-4\./i, /^glm-/i] },
        { id: 'custom', name: '自定义…', baseUrl: '', model: '', keyHint: '', modelPrefs: [] },
    ];

    const DEFAULTS = {
        provider: 'kimi', // 大模型服务预设；custom 时用手填的 baseUrl/model
        baseUrl: 'https://api.moonshot.cn/v1',
        apiKey: '',
        model: 'kimi-k2.6',
        mode: 'ja', // 'ja' = 日文原标题（无需 Key）；'llm' = 大模型重译（需 Key）
        showButton: true, // 右下角浮动「译」按钮
        titlesEnabled: true,
        dedupEnabled: true, // 翻页去重总开关（保存后刷新页面生效）
        gridEnabled: true, // 片单网格化总开关（保存后刷新页面生效）
        previewExclusive: true, // 预览独占：新预览播放时自动暂停上一个（保存后刷新页面生效）
    };

    const hasGM = typeof GM_setValue === 'function' && typeof GM_getValue === 'function';

    function loadConfig() {
        try {
            const raw = hasGM ? GM_getValue('config', null) : localStorage.getItem('mve-config');
            // Object.assign 自动为旧配置补齐新增字段的默认值，向后兼容
            return Object.assign({}, DEFAULTS, raw ? JSON.parse(raw) : {});
        } catch {
            return Object.assign({}, DEFAULTS);
        }
    }

    function saveConfig(cfg) {
        const raw = JSON.stringify(cfg);
        if (hasGM) GM_setValue('config', raw);
        else localStorage.setItem('mve-config', raw);
    }

    function loadCache() {
        try {
            const raw = hasGM ? GM_getValue('cache', null) : localStorage.getItem('mve-cache');
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    }

    function saveCache(cache) {
        const raw = JSON.stringify(cache);
        if (hasGM) GM_setValue('cache', raw);
        else localStorage.setItem('mve-cache', raw);
    }

    /* ---------------- 中文标题来源优先级 ----------------
     * getav（精校中字，最准）> jable（官方繁中）> llm（大模型译文）。
     * 高优先级来源可以覆盖低优先级；低优先级永远不能覆盖高优先级。
     * 旧缓存条目没有 zhSrc 字段：有 zh 即视为 llm 级（1）。 */
    const ZH_SRC_PRIORITY = { getav: 3, jable: 2, llm: 1 };

    /** 按优先级写入中文标题；返回是否真正发生变更（供保存缓存判断） */
    function setZh(slug, zh, src) {
        const hit = cache[slug] || {};
        const curPri = hit.zh ? (ZH_SRC_PRIORITY[hit.zhSrc] || ZH_SRC_PRIORITY.llm) : 0;
        if ((ZH_SRC_PRIORITY[src] || 0) < curPri) return false; // 低优先级不覆盖
        if (hit.zh === zh && hit.zhSrc === src) return false;
        hit.zh = zh;
        hit.zhSrc = src;
        cache[slug] = hit;
        return true;
    }

    const PROMPT_VERSION = 2; // 提示词版本：变更后旧 zh 译文作废

    let config = loadConfig();
    // provider 由 baseUrl 反推确定（而不是信任存储值）：旧配置没有 provider
    // 字段会被 DEFAULTS 填成 'kimi'，反推能把它修正为真正匹配的服务商；
    // 推不出（手填地址）一律视为 custom，手填内容原样保留
    const normUrl = (u) => String(u || '').replace(/\/+$/, '');
    const matchedPreset = PROVIDERS.find((p) => p.id !== 'custom' && normUrl(p.baseUrl) === normUrl(config.baseUrl));
    config.provider = matchedPreset ? matchedPreset.id : 'custom';
    // 已停用/下线模型名自动迁移（官方公告日期见 PROVIDERS 注释）。
    // 按服务商限定：自定义网关用户恰好用同名模型时不受打扰
    const MODEL_MIGRATIONS = {
        deepseek: {
            'deepseek-chat': 'deepseek-v4-flash', // 2026-07-24 停用
            'deepseek-reasoner': 'deepseek-v4-flash',
        },
        glm: {
            'glm-4-flash': 'glm-4.7-flash', // 旧款免费模型，已由 4.7-flash 接替
            'glm-4.5-flash': 'glm-4.7-flash', // 2026-01-30 下线（官方自动路由，这里直接改干净）
        },
    };
    const providerMigrations = MODEL_MIGRATIONS[config.provider];
    if (providerMigrations && providerMigrations[config.model]) {
        config.model = providerMigrations[config.model];
        saveConfig(config);
    }
    // moonshot-v1 系列与 kimi-k2.5 已于 2026-08-31 全平台下线（404），自动迁移
    if (/^moonshot-v1-/.test(config.model) || config.model === 'kimi-k2.5') {
        config.model = DEFAULTS.model;
        saveConfig(config);
    }
    let cache = loadCache(); // slug -> { ja, zh? }
    // 提示词升级后丢弃旧译文（日文原标题保留，无需重新抓取）
    try {
        const verKey = 'promptVersion';
        const storedVer = hasGM ? GM_getValue(verKey, 0) : Number(localStorage.getItem('mve-prompt-ver') || 0);
        if (storedVer !== PROMPT_VERSION) {
            Object.keys(cache).forEach((k) => {
                // Jable 官方中文（zhSrc:'jable'）不是大模型产物，不随提示词升级作废
                if (cache[k] && cache[k].zhSrc !== 'jable') delete cache[k].zh;
            });
            saveCache(cache);
            if (hasGM) GM_setValue(verKey, PROMPT_VERSION);
            else localStorage.setItem('mve-prompt-ver', String(PROMPT_VERSION));
        }
    } catch {}

    function jaListUrl() {
        // 当前列表页的日文版，可能带镜像前缀：
        // /dm635/cn/release?page=6 -> /dm635/ja/release?page=6；/cn/x -> /ja/x；/x -> /ja/x
        const u = new URL(location.href);
        if (/\/(cn|en|zh-tw|ko|vi|th|de|fr|it|es|pt|ru)\//.test(u.pathname)) {
            u.pathname = u.pathname.replace(
                /\/(cn|en|zh-tw|ko|vi|th|de|fr|it|es|pt|ru)\//,
                '/ja/'
            );
        } else if (!u.pathname.startsWith('/ja')) {
            u.pathname = '/ja' + u.pathname;
        }
        return u.href;
    }

    function jaDetailUrl(slug) {
        return location.origin + '/ja/' + slug;
    }

    /**
     * 抓取并解析一个页面，返回 slug -> 日文标题。
     * 站点有 Cloudflare 人机验证，fetch/XHR 拿不到未缓存页面（403 challenge），
     * 必须用隐藏 iframe 让浏览器自己完成验证，再读同源 DOM。
     */
    function fetchJaTitles(url, isDetail) {
        return new Promise((resolve, reject) => {
            // 缓存破坏参数：站点反爬按「完整 URL」触发验证，带个无用参数常可绕过
            // （与 rescue 模块同原理）；不影响标题解析
            const u = new URL(url);
            u.searchParams.set('_mve', Date.now().toString(36));
            const f = document.createElement('iframe');
            f.style.cssText =
                'position:fixed;left:-9999px;top:0;width:800px;height:600px;' +
                'opacity:0;pointer-events:none;z-index:-1;';
            let settled = false;
            const finish = (fn, val) => {
                if (settled) return;
                settled = true;
                clearInterval(poll);
                clearTimeout(timer);
                f.remove();
                fn(val);
            };
            const timer = setTimeout(
                () => finish(reject, new Error('日文页加载超时（Cloudflare 验证未完成，可刷新页面重试；多为网络/代理波动）')),
                30000
            );
            let noContentSince = 0; // 页面已加载但一直无卡片/标题：可能是 404 或空页
            const poll = setInterval(() => {
                let doc;
                try {
                    doc = f.contentDocument;
                } catch {
                    return; // 跨域异常说明还在跳转，继续等
                }
                if (!doc || !doc.title) return;
                if (doc.title.includes('Just a moment')) return; // Cloudflare 验证页，继续等
                if (isDetail) {
                    // 详情页：等 h1 出现
                    const h1 = doc.querySelector('h1');
                    const slug = slugFromHref(url);
                    if (h1 && slug) finish(resolve, { [slug]: h1.textContent.trim() });
                } else {
                    // 列表页：必须等到卡片标题锚点渲染完成（页面是客户端渲染，
                    // 过早解析会只拿到 h1，导致 slug 对不上）
                    const map = {};
                    doc.querySelectorAll('.my-2 a[href], a.mv-full-title[href]').forEach((a) => {
                        const slug = slugFromHref(a.href);
                        if (slug && !map[slug]) map[slug] = a.textContent.trim();
                    });
                    // 详情页被当作列表抓取其自身 h1（补当前页番号）
                    const own = slugFromHref(url);
                    const h1 = doc.querySelector('h1');
                    if (h1 && own && /\d/.test(own) && !map[own]) map[own] = h1.textContent.trim();
                    if (Object.keys(map).length >= 3 || (own && map[own])) {
                        finish(resolve, map);
                        return;
                    }
                }
                // 页面已就绪但连续约 6 秒取不到任何标题（如 /ja/playlists/* 这类
                // 无对应日文页的 404）：按「无标题可取」静默收尾，不再干等到 30 秒超时
                if (!noContentSince) noContentSince = Date.now();
                else if (Date.now() - noContentSince > 6000) finish(resolve, {});
            }, 600);
            f.src = u.href;
            (document.body || document.documentElement).appendChild(f);
        });
    }

    /* ---------------- GetAV 中文标题源（优先级最高：精校中字） ----------------
     * GetAV 视频页（/zh/videos/<番号>）服务端直出完整中文标题，
     * 油猴 GM_xhr 跨站 GET 即可拿到，无需 iframe、无 Cloudflare。
     * 未收录的番号记负缓存 getavMiss（7 天），避免每次翻页重复查询。 */

    const GETAV_MISS_TTL = 7 * 24 * 3600 * 1000; // 负缓存 7 天（新片可能随后收录）

    /** 跨站 GET，返回 { status, text }；网络层失败 reject */
    function httpGet(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('当前脚本管理器不支持 GM_xmlhttpRequest'));
                return;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: 30000,
                onload: (r) => resolve({ status: r.status, text: r.responseText }),
                onerror: () => reject(new Error('网络错误')),
                ontimeout: () => reject(new Error('超时')),
            });
        });
    }

    /** 从 GetAV 视频页 HTML 解析中文标题；404 / 未收录返回 null */
    function parseGetavTitle(html) {
        if (!html) return null;
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const h1 = doc.querySelector('h1');
        if (!h1) return null; // SPA 壳或兜底首页
        const t = h1.textContent.trim();
        if (!t || t === '404' || /页面未找到/.test(t)) return null;
        return t;
    }

    /**
     * 按番号查 GetAV 中文标题。命中返回标题文本；未收录返回 null 并写负缓存；
     * 网络失败返回 null 但【不写】负缓存（下次重试）。
     */
    async function fetchGetavTitle(slug) {
        const hit = cache[slug];
        if (hit && hit.getavMiss && Date.now() - hit.getavMiss < GETAV_MISS_TTL) return null;
        try {
            const r = await httpGet('https://getav.net/zh/videos/' + encodeURIComponent(slug));
            if (r.status < 200 || r.status >= 300) {
                // 404 = 确认未收录，写负缓存；5xx 等异常不写，下次重试
                if (r.status === 404) {
                    cache[slug] = Object.assign(cache[slug] || {}, { getavMiss: Date.now() });
                }
                return null;
            }
            const title = parseGetavTitle(r.text);
            if (!title) {
                cache[slug] = Object.assign(cache[slug] || {}, { getavMiss: Date.now() });
                return null;
            }
            return title;
        } catch (e) {
            log('GetAV 查询失败 ' + slug, e);
            return null;
        }
    }

    /**
     * 第 2 层解析：批量查 GetAV（并发 ≤2），命中的写缓存并即时回写页面。
     * 返回未命中的番号数组，交给下一层（日文抓取 + 大模型）。
     */
    async function resolveViaGetav(slugs) {
        const missed = [];
        for (let i = 0; i < slugs.length; i += 2) {
            await Promise.all(slugs.slice(i, i + 2).map(async (s) => {
                const title = await fetchGetavTitle(s);
                if (title && setZh(s, title, 'getav')) {
                    saveCache(cache);
                    applyCached(collectCards());
                }
                if (!title) missed.push(s);
            }));
        }
        return missed;
    }

    /* ---------------- Kimi 大模型翻译 ---------------- */

    function chatCompletion(messages, useJsonFormat, useThinking) {
        const url = config.baseUrl.replace(/\/+$/, '') + '/chat/completions';
        const body = {
            model: config.model,
            messages,
            // 不传 temperature：kimi 新一代模型只允许固定值，传了会报 400
        };
        if (useJsonFormat) body.response_format = { type: 'json_object' };
        // k2.6 默认开启思考模式（推理很慢），翻译任务禁用思考提速；
        // 不支持该参数的模型会在 400 重试时去掉
        if (useThinking !== false) body.thinking = { type: 'disabled' };
        const payload = JSON.stringify(body);
        const headers = {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + config.apiKey,
        };
        const apiError = (status, text) => {
            const err = new Error('API ' + status + ': ' + String(text || '').slice(0, 200));
            err.status = status;
            err.fatal = true; // 服务器明确响应（401/404 等），换通道无意义
            return err;
        };
        // 通道一：GM_xmlhttpRequest（在扩展上下文发请求，不受页面 CSP 限制）
        function gmRequest() {
            return new Promise((resolve, reject) => {
                if (typeof GM_xmlhttpRequest !== 'function') {
                    reject(new Error('当前脚本管理器不支持 GM_xmlhttpRequest'));
                    return;
                }
                GM_xmlhttpRequest({
                    method: 'POST',
                    url,
                    headers,
                    data: payload,
                    timeout: 60000,
                    onload: (r) => {
                        if (r.status >= 200 && r.status < 300) resolve(r.responseText);
                        else reject(apiError(r.status, r.responseText));
                    },
                    onerror: (r) => {
                        const detail = r && (r.error || r.statusText || r.status) ?
                            '（' + (r.error || r.statusText || r.status) + '）' : '';
                        const err = new Error('网络错误' + detail);
                        err.retryable = true;
                        reject(err);
                    },
                    ontimeout: () => {
                        const err = new Error('请求超时');
                        err.retryable = true;
                        reject(err);
                    },
                });
            });
        }
        // 通道二：fetch 兜底（Moonshot 已确认返回 Access-Control-Allow-Origin，
        // 部分手机脚本管理器 GM 请求实现有问题时可用）
        function fetchRequest() {
            return fetch(url, { method: 'POST', headers, body: payload }).then((r) => {
                if (r.ok) return r.text();
                return r.text().then((t) => {
                    throw apiError(r.status, t);
                });
            });
        }
        return gmRequest().catch((e) => {
            if (e && e.fatal) throw e;
            return fetchRequest().catch((e2) => {
                if (e2 && e2.fatal) throw e2;
                // 两个通道都失败：报出更有信息量的一条
                throw new Error('网络错误（GM：' + e.message + '；fetch：' + e2.message + '）');
            });
        });
    }

    /** 拉取账号可用模型列表，按优先级自动挑选一个（应对官方模型阵容调整） */
    async function discoverModel() {
        const url = config.baseUrl.replace(/\/+$/, '') + '/models';
        const headers = { Authorization: 'Bearer ' + config.apiKey };
        let text;
        if (typeof GM_xmlhttpRequest === 'function') {
            text = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    headers,
                    timeout: 30000,
                    onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(new Error('models API ' + r.status))),
                    onerror: () => reject(new Error('models 网络错误')),
                    ontimeout: () => reject(new Error('models 超时')),
                });
            });
        } else {
            const r = await fetch(url, { headers });
            if (!r.ok) throw new Error('models API ' + r.status);
            text = await r.text();
        }
        const ids = ((JSON.parse(text).data || []).map((m) => m.id)).filter(Boolean);
        // 先排除明显不能对话的模型（向量/语音/图像/审核等），避免兜底挑错类型
        const chatIds = ids.filter((id) => !/embed|tts|whisper|dall-e|image|ocr|moderation|asr|transcri|cogview|cogvideo/i.test(id));
        // 按当前服务商的偏好表挑选（自定义服务商无偏好，退化为第一个对话模型）
        const provider = PROVIDERS.find((p) => p.id === config.provider);
        const prefs = (provider && provider.modelPrefs) || [];
        for (const re of prefs) {
            const hit = chatIds.find((id) => re.test(id));
            if (hit) return hit;
        }
        return chatIds[0] || ids[0] || null;
    }

    /** 批量翻译日文标题，返回与输入同序的中文数组；response_format 不被支持时自动降级重试 */
    async function translateBatch(jaTitles) {
        const sys =
            '你是日本成人影片标题翻译专家。把用户给出的日文标题数组逐条翻译成自然流畅的简体中文。' +
            '规则：1) 番号（如 MADV-646）原样保留；2) 演员名字翻译成中文（有通行译名用通行译名，否则按日文读音自然音译，如 天月あず→天月梓、及川うみ→及川海）；' +
            '3) 【4K】[4K] 等标记保留；4) 不要逐字直译，要符合中文表达习惯；' +
            '5) 严格返回 JSON：{"translations": ["...", ...]}，顺序和数量与输入完全一致。';
        const user = JSON.stringify(jaTitles);
        const messages = [
            { role: 'system', content: sys },
            { role: 'user', content: user },
        ];
        // 429 限流自动等待重试（按服务器提示的秒数），最多 3 次；
        // 404（模型下线）自动用 /models 发现可用模型并重试一次
        let text;
        let modelSwitched = false;
        for (let attempt = 0; ; attempt++) {
            try {
                try {
                    text = await chatCompletion(messages, true);
                } catch (e) {
                    if (e.status === 400) {
                        // 部分模型/网关不支持 response_format 或 thinking 参数，都去掉重试
                        text = await chatCompletion(messages, false, false);
                    } else {
                        throw e;
                    }
                }
                break;
            } catch (e) {
                if (e.status === 404 && !modelSwitched) {
                    modelSwitched = true;
                    try {
                        const m = await discoverModel();
                        if (m && m !== config.model) {
                            log('模型 ' + config.model + ' 不可用，自动切换为 ' + m);
                            config.model = m;
                            saveConfig(config);
                            continue;
                        }
                    } catch (e2) {
                        log('模型自动发现失败', e2);
                    }
                }
                if (e.status === 429 && attempt < 3) {
                    const m = /after (\d+) second/i.exec(e.message || '');
                    const waitSec = (m ? parseInt(m[1], 10) : 20) + 2;
                    log('触发限流，' + waitSec + ' 秒后重试（第 ' + (attempt + 1) + ' 次）');
                    await new Promise((r) => setTimeout(r, waitSec * 1000));
                    continue;
                }
                throw e;
            }
        }
        const data = JSON.parse(text);
        const content = data.choices[0].message.content;
        let arr;
        try {
            arr = JSON.parse(content).translations;
        } catch {
            const m = content.match(/\[[\s\S]*\]/);
            arr = m ? JSON.parse(m[0]) : null;
        }
        if (!Array.isArray(arr) || arr.length !== jaTitles.length) {
            throw new Error('翻译结果格式异常');
        }
        return arr;
    }

    /* ---------------- 页面应用 ---------------- */

    let running = false;
    let rerunAfter = false; // 运行期间又触发了翻译（如用户刚保存设置），结束后补跑一次

    /* ---------------- Jable：中文标题加「字幕」徽章，非中文大模型翻译 ---------------- */

    // 中日文判定：含平/片假名 ⇒ 日文；只有汉字没有假名 ⇒ 中文（Jable 中文标题为繁体）
    const KANA_RE = /[぀-ヿ]/;
    const HAN_RE = /[一-鿿]/;

    function classifyTitle(t) {
        if (KANA_RE.test(t)) return 'ja';
        if (HAN_RE.test(t)) return 'cn';
        return 'other';
    }

    /** Jable 卡片：h6.title 里的番号链接 + 同卡 .video-img-box 封面容器 */
    function collectJableCards() {
        const out = [];
        document.querySelectorAll('h6.title a[href*="/videos/"]').forEach((anchor) => {
            const slug = slugFromHref(anchor.href);
            if (!slug) return;
            out.push({ slug, anchor, box: anchor.closest('.video-img-box'), hidden: false });
        });
        return out;
    }

    /** 封面左上角加「字幕」标识（插进站内覆盖层所在的 <a>，与时长标同级） */
    function ensureSubBadge(box) {
        if (!box || box.dataset.mveSub === '1') return;
        const a = box.querySelector('.img-box a[href]');
        if (!a) return;
        if (getComputedStyle(a).position === 'static') a.style.position = 'relative';
        const badge = document.createElement('div');
        badge.textContent = '字幕';
        badge.style.cssText =
            'position:absolute;top:6px;left:6px;z-index:5;padding:2px 7px;' +
            'border-radius:4px;background:rgba(210,40,60,.92);color:#fff;' +
            'font-size:12px;font-weight:600;line-height:1.4;pointer-events:none;';
        a.appendChild(badge);
        box.dataset.mveSub = '1';
    }

    /**
     * Jable 无需网络的 DOM 处理（初始化与 MutationObserver 回调共用）：
     * 1) 日文原文记入缓存 ja 字段；
     * 2) 中文原标题（Jable 官方繁中，意味着该片有官方中文字幕）：
     *    封面加「字幕」徽章，且原文记入缓存 zh 字段并打 zhSrc:'jable'
     *    标记——MissAV 同番号在重译模式下直接复用，免调大模型；
     * 3) 缓存命中回写（llm 模式译文 / ja 模式还原原文）。
     * 关键约束：只有脚本没动过 DOM 时（缓存无 zh），DOM 文本才可信；
     * 已有 zh 的卡片 DOM 显示的可能是大模型译文，绝不能据此补徽章/改标记。
     */
    function processJableDom() {
        const cards = collectJableCards();
        let changed = false;
        cards.forEach(({ slug, anchor, box }) => {
            const hit = cache[slug];
            if (hit && hit.ja) {
                // 已知日文原标题的卡片。zh 未填时 DOM 仍是原文（未被翻译），
                // 此时若读到中文原文，说明该片其实有官方中文字幕——补记 zh
                if (!hit.zh) {
                    const orig = anchor.textContent.trim();
                    if (classifyTitle(orig) === 'cn') {
                        ensureSubBadge(box);
                        if (setZh(slug, orig, 'jable')) changed = true;
                    }
                }
                return;
            }
            const orig = anchor.textContent.trim();
            const lang = classifyTitle(orig);
            if (lang === 'cn') {
                ensureSubBadge(box);
                // 只写 zh 不碰 ja——避免「日文原标题」模式错显中文；
                // setZh 按优先级写入，不会覆盖已有的 GetAV 精校中文
                if (setZh(slug, orig, 'jable')) changed = true;
            } else if (lang === 'ja') {
                cache[slug] = Object.assign(hit || {}, { ja: orig });
                changed = true;
            }
        });
        if (changed) saveCache(cache);
        applyCached(cards);
        return cards;
    }

    /** Jable 主流程：原标题就在当前页 DOM，无需抓镜像页，只需大模型翻译 */
    async function enhanceJableTitles() {
        if (running) {
            rerunAfter = true;
            return;
        }
        const cards = processJableDom();
        if (!cards.length) return;
        running = true;
        setButtonState('translating');
        try {
            if (config.mode === 'llm') {
                // 第 2 层：GetAV 精校中文（无需 Key，命中即显示）
                const wantZh = [...new Set(cards.map((c) => c.slug))].filter((s) => !cache[s] || !cache[s].zh);
                if (wantZh.length) await resolveViaGetav(wantZh);
                // 第 3 层：剩余日文原标题走大模型（需要 Key）
                if (config.apiKey) {
                    const todo = [...new Set(cards.map((c) => c.slug))]
                        .filter((s) => cache[s] && cache[s].ja && !cache[s].zh);
                    for (let i = 0; i < todo.length; i += 20) {
                        const chunk = todo.slice(i, i + 20);
                        const zhArr = await translateBatch(chunk.map((s) => cache[s].ja));
                        chunk.forEach((s, j) => {
                            setZh(s, zhArr[j], 'llm');
                        });
                        saveCache(cache);
                        applyCached(collectJableCards());
                    }
                }
            }
            lastError = null;
            setButtonState('done');
        } catch (e) {
            log(e);
            lastError = describeTitleError(e);
            setButtonState('error', lastError);
            if (panel && panel.style.display !== 'none') msg(lastError);
        } finally {
            running = false;
            if (rerunAfter) {
                rerunAfter = false;
                setTimeout(enhanceTitles, 500);
            }
        }
    }

    /** 把翻译/抓取异常映射成用户可读的说明（MissAV 与 Jable 流程共用） */
    function describeTitleError(e) {
        let errText = String((e && e.message) || e);
        if (/404|Not found|not exist/i.test(errText)) {
            errText += '（模型不可用或已下线：已尝试自动切换可用模型，仍失败请在设置中手动修改模型名）';
        } else if (/401|Authentication|auth/i.test(errText)) {
            errText += '（API Key 无效，请检查设置）';
        } else if (/429|rate_limit/i.test(errText)) {
            errText += '（账号请求频率超限：已自动等待重试仍失败，请放慢翻页；如持续触发，可到对应大模型平台充值提升额度）';
        }
        return errText;
    }

    /* ---------------- GetAV 本站：中文标题直接入缓存（最高质量来源） ---------------- */

    /**
     * GetAV 卡片：.group 容器内指向 /videos/<番号> 的链接。
     * 标题链接的特征是文本里带番号本身（信息栏链接是「无码字幕1:57:24」之类，不含番号）。
     */
    function collectGetavCards() {
        const out = [];
        document.querySelectorAll('a[href*="/videos/"]').forEach((anchor) => {
            const slug = slugFromHref(anchor.href);
            if (!slug) return;
            const text = (anchor.getAttribute('title') || anchor.textContent).trim();
            if (!text.toUpperCase().includes(slug.toUpperCase())) return;
            out.push({ slug, anchor, hidden: false });
        });
        // 详情页 h1（同样带番号）
        const h1 = document.querySelector('h1');
        const pageSlug = slugFromHref(location.href);
        if (h1 && pageSlug && h1.textContent.toUpperCase().includes(pageSlug.toUpperCase())) {
            out.push({ slug: pageSlug, anchor: h1, isDetail: true, hidden: false });
        }
        return out;
    }

    /**
     * GetAV 无需网络的 DOM 处理：中文标题（GetAV 精校，质量最高的来源）
     * 直接入缓存供三站复用；个别日文原标题记入 ja 等大模型兜底。
     * 与 Jable 同理：只有脚本未动过 DOM（缓存无 zh）时才信任 DOM 语言判定。
     */
    function processGetavDom() {
        const cards = collectGetavCards();
        let changed = false;
        cards.forEach(({ slug, anchor }) => {
            const hit = cache[slug];
            if (hit && hit.zh) return; // 已有中文（DOM 可能已被替换过），不重复判定
            const orig = (anchor.getAttribute('title') || anchor.textContent).trim();
            const lang = classifyTitle(orig);
            if (lang === 'cn') {
                if (setZh(slug, orig, 'getav')) changed = true;
            } else if (lang === 'ja' && (!hit || !hit.ja)) {
                cache[slug] = Object.assign(hit || {}, { ja: orig });
                changed = true;
            }
        });
        if (changed) saveCache(cache);
        applyCached(cards);
        return cards;
    }

    /** GetAV 主流程：本站中文直接入缓存；日文原标题走「缓存 → 大模型」（不查自己） */
    async function enhanceGetavTitles() {
        if (running) {
            rerunAfter = true;
            return;
        }
        const cards = processGetavDom();
        if (!cards.length) return;
        if (config.mode !== 'llm' || !config.apiKey) return;
        const todo = [...new Set(cards.map((c) => c.slug))]
            .filter((s) => cache[s] && cache[s].ja && !cache[s].zh);
        if (!todo.length) return;
        running = true;
        setButtonState('translating');
        try {
            for (let i = 0; i < todo.length; i += 20) {
                const chunk = todo.slice(i, i + 20);
                const zhArr = await translateBatch(chunk.map((s) => cache[s].ja));
                chunk.forEach((s, j) => {
                    setZh(s, zhArr[j], 'llm');
                });
                saveCache(cache);
                applyCached(collectGetavCards());
            }
            lastError = null;
            setButtonState('done');
        } catch (e) {
            log(e);
            lastError = describeTitleError(e);
            setButtonState('error', lastError);
            if (panel && panel.style.display !== 'none') msg(lastError);
        } finally {
            running = false;
            if (rerunAfter) {
                rerunAfter = false;
                setTimeout(enhanceTitles, 500);
            }
        }
    }

    function collectCards() {
        if (SITE === 'jable') return collectJableCards();
        if (SITE === 'getav') return collectGetavCards();
        const out = [];
        document.querySelectorAll('.thumbnail').forEach((thumb) => {
            const anchor = thumb.parentElement.querySelector('.my-2 a[href], a.mv-full-title[href]') ||
                thumb.querySelector('.my-2 a[href], a.mv-full-title[href]');
            if (!anchor) return;
            const slug = slugFromHref(anchor.href);
            if (!slug) return;
            const card = thumb.parentElement;
            const hidden = card && getComputedStyle(card).display === 'none';
            out.push({ slug, anchor, hidden });
        });
        // 详情页主标题 h1（路径末段含数字视为番号页，排除 release 等列表页）
        const h1 = document.querySelector('h1');
        const pageSlug = slugFromHref(location.href);
        if (h1 && pageSlug && /\d/.test(pageSlug)) {
            out.push({ slug: pageSlug, anchor: h1, isDetail: true, hidden: false });
        }
        return out;
    }

    /** 缓存命中即回写：llm 模式显示中文译文，ja 模式显示日文原标题 */
    function applyCached(cards) {
        let applied = 0;
        cards.forEach(({ slug, anchor, hidden }) => {
            if (hidden) return; // 去重隐藏的卡片不写
            const hit = cache[slug];
            const want = hit && (config.mode === 'llm' && hit.zh ? hit.zh : hit.ja);
            if (want && anchor.textContent.trim() !== want) {
                anchor.textContent = want;
                applied++;
            }
        });
        return applied;
    }

    /** 主流程：先取日文标题（每页一次请求），再按模式决定是否调大模型 */
    async function enhanceTitles() {
        if (!config.titlesEnabled) return;
        if (SITE === 'jable') return enhanceJableTitles();
        if (SITE === 'getav') return enhanceGetavTitles();
        if (running) {
            rerunAfter = true;
            return;
        }
        const cards = collectCards().filter((c) => !c.hidden);
        if (!cards.length) return;

        applyCached(cards);
        const allSlugs = [...new Set(cards.map((c) => c.slug))];
        const needJa = allSlugs.filter((s) => !cache[s] || !cache[s].ja);
        // 重译模式：GetAV 精校中文是免费来源（无需 Key），只要有番号缺中文就有工作可做
        const llmWanted = config.mode === 'llm';
        const needZh = llmWanted ? allSlugs.filter((s) => !cache[s] || !cache[s].zh) : [];
        if (!needJa.length && !needZh.length) return;

        running = true;
        setButtonState('translating');
        // 把当前可翻的（已有日文、缺中文）送去大模型；返回是否还有剩余
        const translateTodo = async () => {
            if (config.mode !== 'llm' || !config.apiKey) return;
            const todo = [...new Set(collectCards().filter((c) => !c.hidden).map((c) => c.slug))]
                .filter((s) => cache[s] && cache[s].ja && !cache[s].zh);
            for (let i = 0; i < todo.length; i += 20) {
                const chunk = todo.slice(i, i + 20);
                const jaArr = chunk.map((s) => cache[s].ja);
                const zhArr = await translateBatch(jaArr);
                chunk.forEach((s, j) => {
                    setZh(s, zhArr[j], 'llm'); // 大模型译文优先级最低，不会覆盖 getav/jable 来源
                });
                saveCache(cache);
                applyCached(collectCards());
            }
        };
        try {
            // 第 2 层：GetAV 精校中文源（重译模式；无需 Key；命中即缓存并显示）
            if (llmWanted && needZh.length) await resolveViaGetav(needZh);
            // GetAV 命中的番号已有最佳中文，重译模式下连日文原文都不再需要——
            // 日文抓取和大模型只为「GetAV 也没收录」的番号兜底
            const needJa2 = llmWanted ? needJa.filter((s) => !cache[s].zh) : needJa;
            if (needJa2.length) {
                const isDetail = !!document.querySelector('h1') && !document.querySelector('.thumbnail');
                const jaUrl = isDetail ? jaDetailUrl(needJa2[0]) : jaListUrl();
                // 首次失败多为网络/代理波动或 CF 偶发验证：等 3 秒自动重试一次再放弃
                const jaMap = await fetchJaTitles(jaUrl, isDetail).catch(async (e) => {
                    log('日文页首次抓取失败，3 秒后重试：' + e.message);
                    await new Promise((r) => setTimeout(r, 3000));
                    return fetchJaTitles(jaUrl, isDetail);
                });
                needJa2.forEach((s) => {
                    if (jaMap[s]) cache[s] = Object.assign(cache[s] || {}, { ja: jaMap[s] });
                });
                saveCache(cache);
                applyCached(collectCards());
                // 先翻译列表页已覆盖的部分，用户尽早看到中文
                await translateTodo();
                // 各语言列表收录范围不同，日文列表页可能缺当前页的部分番号；
                // 缺口抓日文详情页补齐（两个并发，结果永久缓存，只补一次）
                if (!isDetail) {
                    const missing = needJa2.filter((s) => !cache[s] || !cache[s].ja).slice(0, 8);
                    for (let i = 0; i < missing.length; i += 2) {
                        await Promise.all(missing.slice(i, i + 2).map(async (s) => {
                            try {
                                const m = await fetchJaTitles(jaDetailUrl(s), true);
                                if (m[s]) {
                                    cache[s] = Object.assign(cache[s] || {}, { ja: m[s] });
                                    saveCache(cache);
                                    applyCached(collectCards());
                                }
                            } catch (e) {
                                log('详情页补抓失败 ' + s, e);
                            }
                        }));
                    }
                    // 补抓到位的新条目再翻一次
                    await translateTodo();
                }
            } else {
                await translateTodo();
            }
            lastError = null;
            setButtonState('done');
        } catch (e) {
            log(e);
            lastError = describeTitleError(e);
            setButtonState('error', lastError);
            if (panel && panel.style.display !== 'none') msg(lastError);
        } finally {
            running = false;
            if (rerunAfter) {
                rerunAfter = false;
                setTimeout(enhanceTitles, 500);
            }
        }
    }

    /* ================================================================
     * 模块六 settings-ui：右下角浮动「译」按钮 + 设置面板
     * ================================================================ */

    let btn, btnLabel, panel, statusDot, lastError;

    function setButtonState(state, msgText) {
        if (!btn) return;
        const map = { idle: '译', translating: '译…', done: '译✓', error: '译!' };
        btnLabel.nodeValue = map[state] || '译';
        if (statusDot) {
            statusDot.style.background = { translating: '#f59e0b', done: '#34d399', error: '#ef4444' }[state] || '#6b7280';
            statusDot.title = msgText || '';
        }
    }

    function buildUI() {
        btn = document.createElement('button');
        btnLabel = document.createTextNode('译'); // 用文本节点改字，避免覆盖状态点小圆点
        btn.appendChild(btnLabel);
        btn.style.cssText =
            'position:fixed;right:16px;bottom:76px;z-index:99998;width:40px;height:40px;border-radius:50%;' +
            'border:1px solid #3b7cd7;background:#1f2430;color:#9db8dd;font-size:14px;cursor:pointer;' +
            'box-shadow:0 2px 10px rgba(0,0,0,.5);';
        statusDot = document.createElement('span');
        statusDot.style.cssText =
            'position:absolute;top:-2px;right:-2px;width:10px;height:10px;border-radius:50%;background:#6b7280;';
        btn.appendChild(statusDot);
        btn.addEventListener('click', togglePanel);
        if (!config.showButton) btn.style.display = 'none';
        document.body.appendChild(btn);

        panel = document.createElement('div');
        panel.style.cssText =
            'position:fixed;right:16px;bottom:124px;z-index:99999;width:300px;padding:14px;border-radius:10px;' +
            'background:#1f2430;border:1px solid #3b7cd7;color:#d7dee9;font-size:13px;display:none;' +
            'box-shadow:0 4px 20px rgba(0,0,0,.6);';
        panel.innerHTML =
            '<div style="font-weight:600;margin-bottom:10px">' + ({ jable: 'Jable 标题增强设置', getav: 'GetAV 增强设置' }[SITE] || 'MissAV 综合增强设置') + '</div>' +
            '<div style="margin-bottom:8px">' +
            '<label style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><input type="radio" name="mve-mode" id="mve-mode-ja" value="ja"> 日文原标题（无需 Key）</label>' +
            '<label style="display:flex;align-items:center;gap:6px"><input type="radio" name="mve-mode" id="mve-mode-llm" value="llm"> 大模型重译（需 API Key）</label>' +
            '</div>' +
            '<label style="display:block;margin-bottom:2px">大模型服务<br><select id="mve-provider" style="width:100%;margin-top:2px;padding:5px;border-radius:6px;border:1px solid #4c566a;background:#2e3440;color:#eceff4">' +
            PROVIDERS.map((p) => '<option value="' + p.id + '">' + p.name + '</option>').join('') +
            '</select></label>' +
            '<div id="mve-key-hint" style="margin:0 0 6px;font-size:11px;color:#8b93a5"></div>' +
            '<label style="display:block;margin-bottom:6px">API Key<br><input id="mve-key" type="password" placeholder="sk-..." style="width:100%;margin-top:2px;padding:5px;border-radius:6px;border:1px solid #4c566a;background:#2e3440;color:#eceff4"></label>' +
            // 选「自定义」才展开的手填区；预设服务商的地址/模型由 PROVIDERS 提供
            '<div id="mve-custom-fields" style="display:none">' +
            '<label style="display:block;margin-bottom:6px">API 地址<br><input id="mve-base" style="width:100%;margin-top:2px;padding:5px;border-radius:6px;border:1px solid #4c566a;background:#2e3440;color:#eceff4"></label>' +
            '<label style="display:block;margin-bottom:6px">模型<br><input id="mve-model" style="width:100%;margin-top:2px;padding:5px;border-radius:6px;border:1px solid #4c566a;background:#2e3440;color:#eceff4"></label>' +
            '</div>' +
            '<label style="display:flex;align-items:center;gap:6px;margin:8px 0"><input id="mve-enabled" type="checkbox"> 启用标题修正</label>' +
            '<label style="display:flex;align-items:center;gap:6px;margin:8px 0"><input id="mve-dedup" type="checkbox"> 启用翻页去重（改动后刷新页面生效）</label>' +
            '<label style="display:flex;align-items:center;gap:6px;margin:8px 0"><input id="mve-grid" type="checkbox"> 启用片单网格化（改动后刷新页面生效）</label>' +
            '<label style="display:flex;align-items:center;gap:6px;margin:8px 0"><input id="mve-preview" type="checkbox"> 预览独占：同时只播放一个预览视频（改动后刷新页面生效）</label>' +
            '<label style="display:flex;align-items:center;gap:6px;margin:8px 0"><input id="mve-showbtn" type="checkbox"> 显示右下角「译」按钮（隐藏后可用脚本菜单打开本设置）</label>' +
            '<div style="display:flex;gap:8px;margin-top:8px">' +
            '<button id="mve-save" style="flex:1;padding:6px;border:none;border-radius:6px;background:#3b7cd7;color:#fff;cursor:pointer">保存并应用</button>' +
            '<button id="mve-clear" style="padding:6px 10px;border:1px solid #4c566a;border-radius:6px;background:transparent;color:#d7dee9;cursor:pointer">清缓存</button>' +
            '</div>' +
            '<div style="display:flex;gap:8px;margin-top:8px">' +
            '<button id="mve-export" style="flex:1;padding:6px;border:1px solid #4c566a;border-radius:6px;background:transparent;color:#d7dee9;cursor:pointer">导出配置+缓存</button>' +
            '<button id="mve-import" style="flex:1;padding:6px;border:1px solid #4c566a;border-radius:6px;background:transparent;color:#d7dee9;cursor:pointer">导入</button>' +
            '<input id="mve-import-file" type="file" accept=".json,application/json" style="display:none">' +
            '</div>' +
            '<div style="margin-top:6px;font-size:11px;color:#8b93a5">导出文件含明文 API Key，注意保管；可存入 iCloud 云盘跨浏览器导入</div>' +
            '<div id="mve-msg" style="margin-top:8px;font-size:12px;color:#9db8dd;min-height:14px"></div>';
        document.body.appendChild(panel);

        if (SITE !== 'missav') {
            // 这三个功能是 MissAV 专属，其他站点隐藏无关开关（保留配置值，回显/保存不受影响）
            ['#mve-dedup', '#mve-grid', '#mve-preview'].forEach((sel) => {
                const label = panel.querySelector(sel).closest('label');
                if (label) label.style.display = 'none';
            });
        }

        // 切换服务商：更新 Key 申请提示；选「自定义」才展开地址/模型手填区
        panel.querySelector('#mve-provider').addEventListener('change', updateProviderUI);
        panel.querySelector('#mve-save').addEventListener('click', () => {
            const preset = PROVIDERS.find((p) => p.id === panel.querySelector('#mve-provider').value) || PROVIDERS[0];
            let baseUrl, model;
            if (preset.id === 'custom') {
                baseUrl = panel.querySelector('#mve-base').value.trim() || DEFAULTS.baseUrl;
                model = panel.querySelector('#mve-model').value.trim() || DEFAULTS.model;
            } else {
                baseUrl = preset.baseUrl;
                // 同一服务商保留当前模型（可能被 404 自动发现机制切换到更新型号）；
                // 换了服务商才采用新预设的默认模型
                model = (config.provider === preset.id && config.model) ? config.model : preset.model;
            }
            config = {
                provider: preset.id,
                baseUrl,
                apiKey: panel.querySelector('#mve-key').value.trim(),
                model,
                mode: panel.querySelector('#mve-mode-llm').checked ? 'llm' : 'ja',
                titlesEnabled: panel.querySelector('#mve-enabled').checked,
                dedupEnabled: panel.querySelector('#mve-dedup').checked,
                gridEnabled: panel.querySelector('#mve-grid').checked,
                previewExclusive: panel.querySelector('#mve-preview').checked,
                showButton: panel.querySelector('#mve-showbtn').checked,
            };
            btn.style.display = config.showButton ? '' : 'none';
            saveConfig(config);
            lastError = null;
            msg('已保存' + (config.mode === 'llm' && !config.apiKey ? '（未填 Key，将显示日文原标题）' : ''));
            togglePanel();
            enhanceTitles();
        });
        panel.querySelector('#mve-clear').addEventListener('click', () => {
            cache = {};
            saveCache(cache);
            msg('缓存已清空');
        });
        panel.querySelector('#mve-export').addEventListener('click', exportBackup);
        const importFile = panel.querySelector('#mve-import-file');
        panel.querySelector('#mve-import').addEventListener('click', () => importFile.click());
        importFile.addEventListener('change', () => {
            if (importFile.files && importFile.files[0]) importBackup(importFile.files[0]);
            importFile.value = ''; // 允许重复导入同一个文件
        });
    }

    /* ---------------- 导出 / 导入（跨浏览器迁移，文件可存 iCloud 云盘） ---------------- */

    function exportBackup() {
        const data = {
            app: 'missav-enhancer',
            version: '4.0.0',
            exportedAt: new Date().toISOString(),
            config,
            cache,
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'missav-enhancer-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000); // 延迟回收，避免 Safari 下载失败
        msg('已导出：配置 + ' + Object.keys(cache).length + ' 条缓存（含 API Key，注意保管）');
    }

    function importBackup(file) {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                if (!data || typeof data !== 'object' || (!data.config && !data.cache)) {
                    throw new Error('不是有效的备份文件');
                }
                if (data.config && typeof data.config === 'object') {
                    // Object.assign 补齐新增字段默认值，旧版本备份也能安全导入
                    config = Object.assign({}, DEFAULTS, data.config);
                    saveConfig(config);
                }
                let cacheCount = 0;
                if (data.cache && typeof data.cache === 'object') {
                    cache = data.cache;
                    saveCache(cache);
                    cacheCount = Object.keys(cache).length;
                }
                msg('导入成功：配置 + ' + cacheCount + ' 条缓存，已生效');
                applyCached(collectCards()); // 标题立即按导入的配置/缓存回写
                enhanceTitles();
            } catch (e) {
                msg('导入失败：' + e.message);
            }
        };
        reader.onerror = () => msg('导入失败：文件读取错误');
        reader.readAsText(file);
    }

    function msg(t) {
        const el = panel && panel.querySelector('#mve-msg');
        if (el) el.textContent = t;
    }

    // 模块级函数（buildUI 绑定事件、togglePanel 回显都调用）：
    // 按当前选中的服务商更新 Key 申请提示，并切换自定义手填区显隐
    function updateProviderUI() {
        if (!panel) return;
        const p = PROVIDERS.find((x) => x.id === panel.querySelector('#mve-provider').value) || PROVIDERS[0];
        panel.querySelector('#mve-custom-fields').style.display = p.id === 'custom' ? '' : 'none';
        panel.querySelector('#mve-key-hint').textContent = p.id === 'custom'
            ? '自定义服务需手填 OpenAI 兼容接口地址与模型名'
            : '到 ' + p.keyHint + ' 申请 Key，粘贴到下方即可（地址和模型已自动填好）';
    }

    function togglePanel() {
        if (!panel) return;
        const show = panel.style.display === 'none';
        panel.style.display = show ? 'block' : 'none';
        if (show) {
            panel.querySelector('#mve-provider').value = config.provider || 'kimi';
            panel.querySelector('#mve-base').value = config.baseUrl;
            panel.querySelector('#mve-key').value = config.apiKey;
            panel.querySelector('#mve-model').value = config.model;
            updateProviderUI();
            panel.querySelector(config.mode === 'llm' ? '#mve-mode-llm' : '#mve-mode-ja').checked = true;
            panel.querySelector('#mve-enabled').checked = config.titlesEnabled;
            panel.querySelector('#mve-dedup').checked = config.dedupEnabled;
            panel.querySelector('#mve-grid').checked = config.gridEnabled;
            panel.querySelector('#mve-preview').checked = config.previewExclusive;
            panel.querySelector('#mve-showbtn').checked = config.showButton;
            if (lastError) msg('上次出错：' + lastError);
            else msg(config.mode === 'llm' && !config.apiKey ? '重译模式需先选择大模型服务并填入 API Key' : '');
        }
    }

    /* ================================================================
     * 模块七 getav-ui：GetAV 界面增强（原 getav-full-titles 脚本并入）
     * 四个功能：解除标题截断、title 属性补全、列表页标题放大一号、
     * 订阅页三列网格卡片。与主流程共用 document-idle 启动，
     * 首次渲染可能有极短暂的截断闪现，Observer 会立即修正。
     * ================================================================ */

    const isGetavSubscriptionsPage = SITE === 'getav' && /\/profile\/subscriptions/.test(location.pathname);
    const GETAV_ENLARGE_FACTOR = 1.12; // 列表页标题放大倍率（实测约大一号，再大卡片会拥挤）
    const GETAV_MIN_FONT = 11;  // 只放大正文级标题：跳过更小的辅助文字
    const GETAV_MAX_FONT = 20;  // 跳过页面大标题

    /** querySelectorAll 的补充：动态加载时新增节点本身可能也匹配选择器，需把 root 自身纳入 */
    function queryAllWithSelf(root, selector) {
        const list = [...(root || document).querySelectorAll(selector)];
        if (root && root.nodeType === 1 && typeof root.matches === 'function' && root.matches(selector)) {
            list.unshift(root);
        }
        return list;
    }

    function injectGetavStyles() {
        let css = `
        a[title], h1, h2, h3, h4, .title, .video-title, [class*="title"],
        [class*="Title"], [class*="name"], [class*="Name"] {
            white-space: normal !important;
            overflow: visible !important;
            text-overflow: unset !important;
            text-overflow: clip !important;
            -webkit-line-clamp: unset !important;
            -webkit-box-orient: unset !important;
            display: block !important;
            word-break: break-word !important;
            word-wrap: break-word !important;
            max-height: none !important;
            height: auto !important;
        }
        [class*="card"], [class*="item"], [class*="video"], [class*="post"],
        article, li, .entry {
            overflow: visible !important;
        }
        `;
        if (isGetavSubscriptionsPage) {
            css += `
        /* ============ 订阅页：网格 ============ */
        #getav-sub-grid {
            display: grid !important;
            grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
            gap: 20px !important;
            border: none !important;
            width: 100% !important;
            padding: 8px 0 16px !important;
        }
        /* 窄屏（手机等宽度不够时）两列 */
        @media (max-width: 700px) {
            #getav-sub-grid {
                grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
                gap: 14px !important;
            }
            #getav-sub-grid > div { padding: 14px !important; }
            #getav-sub-grid > div > a.flex .rounded-full {
                width: 60px !important;
                height: 60px !important;
            }
            #getav-sub-grid p.truncate { font-size: 13px !important; }
        }

        /* ============ 卡片本体 ============ */
        #getav-sub-grid > div {
            position: relative;
            display: flex !important;
            flex-direction: column !important;
            align-items: stretch !important;
            gap: 12px !important;
            padding: 18px !important;
            background: linear-gradient(165deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.015) 60%, rgba(255,255,255,0.03) 100%) !important;
            border: 1px solid rgba(255,255,255,0.08) !important;
            border-radius: 16px !important;
            transition: transform .22s cubic-bezier(.34,1.4,.5,1),
                        border-color .22s ease,
                        box-shadow .22s ease,
                        background .22s ease;
        }
        #getav-sub-grid > div:hover {
            transform: translateY(-4px);
            border-color: rgba(244,63,94,0.4) !important;
            background: linear-gradient(165deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.025) 60%, rgba(244,63,94,0.04) 100%) !important;
            box-shadow: 0 12px 32px rgba(0,0,0,0.45),
                        0 0 0 1px rgba(244,63,94,0.10),
                        0 4px 16px rgba(244,63,94,0.08) !important;
        }

        /* ============ 头像：顶部居中 + 悬浮光环 ============ */
        #getav-sub-grid > div > a.flex .rounded-full {
            width: 72px !important;
            height: 72px !important;
            margin: 2px auto 0 !important;
            transition: box-shadow .22s ease, border-color .22s ease !important;
        }
        #getav-sub-grid > div:hover > a.flex .rounded-full {
            border-color: rgba(244,63,94,0.55) !important;
            box-shadow: 0 0 0 3px rgba(244,63,94,0.16),
                        0 0 14px rgba(244,63,94,0.28) !important;
        }

        /* ============ 链接区：竖排居中（头像在上，名字在下） ============ */
        #getav-sub-grid > div > a.flex {
            display: flex !important;
            flex-direction: column !important;
            align-items: center !important;
            justify-content: flex-start !important;
            width: 100% !important;
            gap: 10px !important;
            text-align: center !important;
            text-decoration: none !important;
        }
        /* 名字容器：显式撑满整行（不再依赖 flex 伸展，根治竖排问题） */
        #getav-sub-grid > div > a.flex > div.min-w-0 {
            width: 100% !important;
            min-width: 0 !important;
            text-align: center !important;
        }
        /* 中文名：最多两行，居中 */
        #getav-sub-grid p.truncate {
            font-size: 14px !important;
            font-weight: 600 !important;
            letter-spacing: 0.01em !important;
            line-height: 1.35 !important;
            color: #fff !important;
            white-space: normal !important;
            overflow: visible !important;
            text-overflow: unset !important;
            text-align: center !important;
        }
        /* 日文原名：小字居中 */
        #getav-sub-grid p.truncate + p {
            font-size: 11px !important;
            letter-spacing: 0.04em !important;
            color: rgba(255,255,255,0.40) !important;
            margin-top: 3px !important;
            text-align: center !important;
            white-space: normal !important;
            overflow: visible !important;
        }
        /* 卡片悬浮时名字高亮 */
        #getav-sub-grid > div:hover p.truncate {
            text-shadow: 0 0 12px rgba(244,63,94,0.35) !important;
        }

        /* ============ 取消订阅按钮 ============ */
        #getav-sub-grid > div > button {
            width: 100% !important;
            display: inline-flex !important;
            flex-direction: row !important;
            flex-wrap: nowrap !important;
            white-space: nowrap !important;
            align-items: center !important;
            justify-content: center !important;
            flex-shrink: 0 !important;
            margin-top: auto !important;
            padding: 9px 0 !important;
            font-size: 13px !important;
            letter-spacing: 0.1em !important;
            border-radius: 9999px !important;
            border: 1px solid rgba(255,255,255,0.10) !important;
            background: rgba(255,255,255,0.04) !important;
            color: rgba(255,255,255,0.62) !important;
            transition: all .2s ease !important;
        }
        #getav-sub-grid > div > button:hover {
            border-color: rgba(244,63,94,0.5) !important;
            background: rgba(244,63,94,0.12) !important;
            color: #fda4af !important;
            box-shadow: 0 2px 14px rgba(244,63,94,0.25) !important;
            transform: translateY(-1px) !important;
        }
        #getav-sub-grid > div > button:active {
            transform: scale(0.97) !important;
        }
        #getav-sub-grid > div > button svg {
            flex-shrink: 0 !important;
            margin-right: 6px !important;
            transition: transform .2s ease !important;
        }
        #getav-sub-grid > div > button:hover svg {
            transform: scale(1.12) rotate(-6deg) !important;
        }
        `;
        }
        const style = document.createElement('style');
        style.id = 'getav-full-title-style';
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    /** 订阅页网格卡片（内联样式与 CSS 双保险——站点大量使用内联样式，纯 CSS 打不赢优先级） */
    function styleGetavCards() {
        document.querySelectorAll('#getav-sub-grid > div').forEach((card) => {
            const anchor = card.querySelector(':scope > a.flex');
            const btn = card.querySelector(':scope > button');

            if (anchor) {
                anchor.style.setProperty('display', 'flex', 'important');
                anchor.style.setProperty('flex-direction', 'column', 'important');
                anchor.style.setProperty('align-items', 'center', 'important');
                anchor.style.setProperty('justify-content', 'flex-start', 'important');
                anchor.style.setProperty('width', '100%', 'important');
                anchor.style.setProperty('gap', '10px', 'important');
                anchor.style.setProperty('text-align', 'center', 'important');

                const textDiv = anchor.querySelector(':scope > div.min-w-0');
                if (textDiv) {
                    textDiv.style.setProperty('width', '100%', 'important');
                    textDiv.style.setProperty('min-width', '0', 'important');
                    textDiv.style.setProperty('text-align', 'center', 'important');
                    textDiv.style.setProperty('flex', 'none', 'important');
                }
                const ps = anchor.querySelectorAll('p');
                ps.forEach((p) => {
                    p.style.setProperty('white-space', 'normal', 'important');
                    p.style.setProperty('overflow', 'visible', 'important');
                    p.style.setProperty('text-overflow', 'unset', 'important');
                    p.style.setProperty('text-align', 'center', 'important');
                    p.style.setProperty('max-width', '100%', 'important');
                });
                // 日文名和中文名完全相同时，隐藏日文名（避免重复，如“友田彩也香”）
                if (ps.length >= 2 && ps[0].textContent.trim() === ps[1].textContent.trim()) {
                    ps[1].style.setProperty('display', 'none', 'important');
                }
            }

            if (btn) {
                btn.style.setProperty('width', '100%', 'important');
                btn.style.setProperty('display', 'inline-flex', 'important');
                btn.style.setProperty('flex-direction', 'row', 'important');
                btn.style.setProperty('flex-wrap', 'nowrap', 'important');
                btn.style.setProperty('white-space', 'nowrap', 'important');
                btn.style.setProperty('align-items', 'center', 'important');
                btn.style.setProperty('justify-content', 'center', 'important');
                btn.style.setProperty('margin-top', 'auto', 'important');
                btn.style.setProperty('box-sizing', 'border-box', 'important');
                const svg = btn.querySelector('svg');
                if (svg) svg.style.setProperty('flex-shrink', '0', 'important');
            }
        });
    }

    function makeGetavThreeColumns() {
        if (!isGetavSubscriptionsPage) return;
        const containers = document.querySelectorAll('div.divide-y');
        for (const c of containers) {
            if (c.id === 'getav-sub-grid') continue;
            const rows = Array.from(c.children).filter(
                (el) => el.matches && el.matches('div.flex.flex-col')
            );
            if (rows.length >= 3) {
                c.id = 'getav-sub-grid';
            }
        }
        styleGetavCards();
    }

    /** 展开仍被截断的元素 */
    function expandGetavTruncated(root) {
        const els = queryAllWithSelf(root, 'a, span, div, p, h1, h2, h3, h4, li');
        for (const el of els) {
            if (el.children.length > 3) continue;
            if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
                const cs = getComputedStyle(el);
                if (cs.whiteSpace === 'nowrap' || cs.textOverflow === 'ellipsis' ||
                    cs.overflow === 'hidden' || cs.webkitLineClamp !== 'none') {
                    el.style.setProperty('white-space', 'normal', 'important');
                    el.style.setProperty('overflow', 'visible', 'important');
                    el.style.setProperty('text-overflow', 'clip', 'important');
                    el.style.setProperty('-webkit-line-clamp', 'unset', 'important');
                    el.style.setProperty('display', 'block', 'important');
                    el.style.setProperty('max-height', 'none', 'important');
                    el.style.setProperty('height', 'auto', 'important');
                }
            }
        }
    }

    /** 用 title 属性补全文字 */
    function fillGetavFromTitle(root) {
        const els = queryAllWithSelf(root, 'a[title]');
        for (const el of els) {
            const t = el.getAttribute('title');
            if (t && (el.textContent.includes('…') || el.textContent.includes('...') ||
                el.textContent.trim().length < t.trim().length / 2)) {
                el.textContent = t;
            }
        }
    }

    /** 列表页标题字号大一号 */
    const getavEnlargedTitles = new WeakSet();
    function enlargeGetavListTitles(root) {
        // 订阅页有专门的名字样式，视频详情页（/videos/番号）不在此列，其余（首页/分类/搜索等）都算列表页
        if (isGetavSubscriptionsPage) return;
        if (/\/videos\//i.test(location.pathname)) return;
        const els = queryAllWithSelf(
            root,
            'a[title], h1, h2, h3, h4, .title, .video-title, [class*="title"], [class*="Title"]'
        );
        for (const el of els) {
            if (getavEnlargedTitles.has(el)) continue;
            if (el.closest('#getav-sub-grid')) continue;
            const size = parseFloat(getComputedStyle(el).fontSize);
            // 只对正文级别的标题放大；确认放大后才标记进 WeakSet（否则站点 CSS
            // 未加载完时字号暂时不在区间的元素会被永久跳过——已踩过的时序坑）
            if (size >= GETAV_MIN_FONT && size <= GETAV_MAX_FONT) {
                el.style.setProperty('font-size', Math.round(size * GETAV_ENLARGE_FACTOR) + 'px', 'important');
                getavEnlargedTitles.add(el);
            }
        }
    }

    /** GetAV 界面增强入口（自带独立 Observer：增量扫描新增节点） */
    function initGetavUi() {
        injectGetavStyles();
        let timer = null;
        let pendingRoots = []; // 收集新增节点：只扫变化子树，避免每次变动都全文档强制同步布局
        const schedule = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const roots = pendingRoots.length ? pendingRoots.splice(0) : [document];
                // 新增节点过多（整页重渲染）时退化为一次全文档扫描，反而更省
                const targets = roots.length > 20 ? [document] : roots;
                for (const root of targets) {
                    fillGetavFromTitle(root);
                    expandGetavTruncated(root);
                    enlargeGetavListTitles(root);
                }
                makeGetavThreeColumns();
            }, 300);
        };
        fillGetavFromTitle(document);
        expandGetavTruncated(document);
        enlargeGetavListTitles(document);
        makeGetavThreeColumns();
        new MutationObserver((muts) => {
            let hasAdded = false;
            for (const m of muts) {
                if (!m.addedNodes.length) continue;
                hasAdded = true;
                for (const n of m.addedNodes) {
                    if (n.nodeType === Node.ELEMENT_NODE) pendingRoots.push(n);
                }
            }
            if (hasAdded) schedule();
        }).observe(document.body, { childList: true, subtree: true });
        window.addEventListener('load', schedule);
    }

    /* ================================================================
     * 启动与监听
     * 顺序：rescue → grid（片单页先改造 DOM）→ dedup → preview → titles。
     * DOM 变化共用一个 body 级 MutationObserver，回调里分发两个
     * 防抖任务：纠正 MissAV Plus 筛选条错位 + 标题缓存回写。
     * ================================================================ */

    const debouncedRelocate = debounce(() => {
        if (gridUl && document.contains(gridUl)) relocateStrayFilterBars(gridUl);
    }, 200);
    const debouncedReapplyTitles = debounce(() => {
        if (!config.titlesEnabled) return;
        // Jable：新渲染的卡片（含轮播克隆）需要补徽章、记录原文并回写译文
        if (SITE === 'jable') processJableDom();
        else if (SITE === 'getav') processGetavDom();
        else applyCached(collectCards());
    }, 400);

    function init() {
        // rescue / grid / dedup / preview 是 MissAV 专属（Jable/GetAV 无对应页面结构；
        // Jable 的预览行为未做适配测试，预览独占暂不开启）
        if (SITE === 'missav') {
            rescueChallengePage();
            if (isPlaylistPage && config.gridEnabled) waitFor(applyGridLayout);
            if (config.dedupEnabled) waitFor(dedup);
            if (config.previewExclusive) initPreviewExclusive();
        }
        if (SITE === 'getav') initGetavUi();
        buildUI();
        if (config.titlesEnabled) {
            // 等去重和首屏渲染稳定后再处理标题
            setTimeout(enhanceTitles, 800);
        }
        // 兼容动态加载与 MissAV Plus 的标题重渲染 / 筛选条注入
        new MutationObserver(() => {
            debouncedRelocate();
            debouncedReapplyTitles();
        }).observe(document.body, { childList: true, subtree: true });
        if (typeof GM_registerMenuCommand === 'function') {
            const menuLabel = { jable: 'Jable 标题增强设置', getav: 'GetAV 增强设置' }[SITE] || 'MissAV 综合增强设置';
            GM_registerMenuCommand(menuLabel, togglePanel);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
