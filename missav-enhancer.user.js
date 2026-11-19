// ==UserScript==
// @name         MissAV 综合增强（研发版：翻页去重 + 标题修正 + 片单网格化）
// @namespace    https://missav.ws/dev
// @version      4.0.30-dev.12
// @description  MissAV / Jable / GetAV 三站合一：1) 翻页去重（MissAV）；2) 三站统一标题增强——中文标题按「缓存 → GetAV 精校中字 → Manko → Jable 繁中 → 大模型」优先级解析，番号为同一性主键跨站复用，最大限度少用大模型；大模型服务内置 Kimi/DeepSeek/OpenAI/GLM 预设；3) 片单网格化（MissAV）；4) 预览独占（MissAV）；5) GetAV 界面增强——标题完整显示、订阅页网格卡片（原 GetAV 脚本并入）；6) 标题完整显示不省略（Jable + MissAV，同排卡片自动等高）
// @author       Phaeton
// @license      MIT
// @icon         https://missav.ws/favicon.ico
// @updateURL    https://raw.githubusercontent.com/lingyuncrystal/missav-pagination-dedup/dev/missav-enhancer.user.js
// @downloadURL  https://raw.githubusercontent.com/lingyuncrystal/missav-pagination-dedup/dev/missav-enhancer.user.js
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
// @grant        GM_openInTab
// @connect      getav.net
// @connect      jable.tv
// @connect      7mmtv.sx
// @connect      manko.fun
// @connect      healertanker.com
// @connect      alpharomeo.shop
// @connect      api.moonshot.cn
// @connect      api.deepseek.com
// @connect      api.openai.com
// @connect      open.bigmodel.cn
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

    /**
     * 安全改写元素文本：优先改「文本节点的值」，不替换节点本身。
     * GetAV 已迁到 React（Next.js），React 的 fiber 持有服务端生成的文本节点引用；
     * 一旦我们按老办法 `el.textContent = ...` 整块换掉，React 之后卸载该节点时
     * removeChild 一个已脱离文档的旧节点会抛 NotFoundError，直接搞崩页面。
     * 改 nodeValue 则引用不变，React 自己重渲染时也能正常覆盖。
     * 附带好处：characterData 变动不触发 childList 型 MutationObserver，不会自我回环。
     * 结构复杂（含元素子节点）时退回整块替换，并计数供诊断面板上报。
     */
    const textWrites = { node: 0, block: 0, samples: [] };

    function setTextSafe(el, text) {
        if (!el) return false;
        const kids = el.childNodes;
        if (kids.length === 1 && kids[0].nodeType === Node.TEXT_NODE) {
            if (kids[0].nodeValue !== text) kids[0].nodeValue = text;
            textWrites.node++;
            return true;
        }
        if (!el.children.length) {
            // 纯文本多节点：只改第一个、其余置空——删节点会破坏 React 的引用
            let first = true;
            for (const n of kids) {
                if (n.nodeType !== Node.TEXT_NODE) continue;
                n.nodeValue = first ? text : '';
                first = false;
            }
            if (!first) {
                textWrites.node++;
                return true;
            }
        }
        el.textContent = text;
        textWrites.block++;
        // 记录前 3 个「整块替换」节点，诊断面板展示——这类节点结构复杂，
        // 是 React 站点上唯一还可能引发卸载异常的写入口，便于远程定位
        if (textWrites.samples.length < 3) {
            const cls = (el.getAttribute && el.getAttribute('class')) || '';
            textWrites.samples.push(el.tagName.toLowerCase() + (cls ? '.' + cls.split(/\s+/)[0] : ''));
        }
        return false;
    }

    /** 从链接（或当前 URL）提取番号 slug：路径末段小写，如 madv-646 */
    function slugFromHref(href) {
        try {
            const seg = new URL(href, location.origin).pathname.split('/').filter(Boolean);
            const raw = (seg[seg.length - 1] || '').toLowerCase();
            if (!raw) return null;
            // MissAV 给带字幕/无码版本的详情页 URL 追加后缀（如 ipzz-963-chinese-subtitle）。
            // 番号是跨站同一性主键（缓存键 + GetAV 查询参数），必须剥掉后缀还原成标准番号，
            // 否则 GetAV 查询全部 404、缓存键被污染、跨站复用失效。
            return raw.replace(/-(chinese-subtitle|english-subtitle|uncensored-leak|uncensored)$/i, '') || null;
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
            //    因此片单页标题也能自动获得统一的中文标题（缓存/GetAV/Jable/大模型）。
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
     * 模块五 titles：标题修正（中文标题链：缓存 → GetAV → Manko → Jable → 大模型）
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
     * manko（中文资料）> getav（精校中字）> jable（官方繁中）> llm（大模型译文）。
     * 高优先级来源可以覆盖低优先级；低优先级永远不能覆盖高优先级。
     * 旧缓存条目没有 zhSrc 字段：有 zh 即视为 llm 级（1）。 */
    const ZH_SRC_PRIORITY = { getav: 4, manko: 3, jable: 2, llm: 1 };

    /** 按优先级写入中文标题；返回是否真正发生变更（供保存缓存判断） */
    function setZh(slug, zh, src) {
        const hit = cache[slug] || {};
        const curPri = hit.zh ? (ZH_SRC_PRIORITY[hit.zhSrc] || ZH_SRC_PRIORITY.llm) : 0;
        if ((ZH_SRC_PRIORITY[src] || 0) < curPri) return false; // 低优先级不覆盖
        if (hit.zh === zh && hit.zhSrc === src) return false;
        hit.zh = zh;
        hit.zhSrc = src;
        hit.zhAt = Date.now(); // 写入时间：llm 译文「来源升级」按此判断新旧
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
    // 4.0.20 起取消「日文原标题」选项：标题统一走中文链，清掉旧配置里的 mode 字段
    if ('mode' in config) {
        delete config.mode;
        saveConfig(config);
    }
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
    // v4.0.5 一次性缓存清洗：早期版本在异常网络下可能把跳转/提示页的文本
    // （如 h1 为 miss.ws 的页面）当作标题入库。规则：ja/zh 必须包含番号本体，
    // 不含即判定为污染数据删除（番号键为小写，标题里的番号大小写不敏感比较）
    try {
        const sanitizeKey = 'cacheSanitizedV1';
        const sanitized = hasGM ? GM_getValue(sanitizeKey, false) : localStorage.getItem('mve-sanitized-v1');
        if (!sanitized) {
            let removed = 0;
            Object.keys(cache).forEach((k) => {
                const c = cache[k];
                if (!c) return;
                ['ja', 'zh'].forEach((f) => {
                    if (c[f] && String(c[f]).toLowerCase().indexOf(k) === -1) {
                        delete c[f];
                        removed++;
                    }
                });
            });
            if (removed) {
                saveCache(cache);
                log('缓存清洗完成，移除疑似污染条目', removed, '个');
            }
            if (hasGM) GM_setValue(sanitizeKey, true);
            else localStorage.setItem('mve-sanitized-v1', '1');
        }
    } catch {}
    // 提示词升级后丢弃旧译文（日文原标题保留，无需重新抓取）
    try {
        const verKey = 'promptVersion';
        const storedVer = hasGM ? GM_getValue(verKey, 0) : Number(localStorage.getItem('mve-prompt-ver') || 0);
        if (storedVer !== PROMPT_VERSION) {
            Object.keys(cache).forEach((k) => {
                // 免费来源不是大模型产物，不随提示词升级作废
                if (cache[k] && !['getav', 'jable', 'manko'].includes(cache[k].zhSrc)) delete cache[k].zh;
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
                    if (h1 && slug) {
                        const t = h1.textContent.trim();
                        // MissAV 详情页 h1 必含番号；不含说明 iframe 被重定向到了
                        // 跳转/提示页（如某些网络环境下 h1 为 miss.ws 的页面），
                        // 直接放弃本番号，绝不入库污染缓存
                        if (t.toLowerCase().indexOf(slug) !== -1) finish(resolve, { [slug]: t });
                        else finish(resolve, {});
                    }
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
                    if (h1 && own && /\d/.test(own) && !map[own]) {
                        const t = h1.textContent.trim();
                        // 同上：h1 必须含番号本体，防跳转/提示页污染
                        if (t.toLowerCase().indexOf(own) !== -1) map[own] = t;
                    }
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

    /* ---------------- GetAV 中文标题源（优先级第三：精校中字） ----------------
     * GetAV 视频页（/zh/videos/<番号>）服务端直出完整中文标题，
     * 油猴 GM_xhr 跨站 GET 即可拿到，无需 iframe、无 Cloudflare。
     * 未收录的番号记负缓存 getavMiss（7 天），避免每次翻页重复查询。 */

    const MISS_TTL = 24 * 3600 * 1000; // 负缓存 24 小时（新片可能随后收录，原 7 天太久——GetAV 收录后用户长时间看不到精校标题）；GetAV/Jable 两源共用

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

    /** 跨站 POST，供 7mmtv 的番号搜索表单使用 */
    function httpPost(url, body) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('当前脚本管理器不支持 GM_xmlhttpRequest'));
                return;
            }
            GM_xmlhttpRequest({
                method: 'POST',
                url,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data: body,
                timeout: 30000,
                onload: (r) => resolve({ status: r.status, text: r.responseText }),
                onerror: () => reject(new Error('网络错误')),
                ontimeout: () => reject(new Error('超时')),
            });
        });
    }

    /** 从 GetAV 视频页 HTML 解析中文标题；404 / 未收录返回 null */
    function parseGetavTitle(html, slug) {
        if (!html) return null;
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const h1 = doc.querySelector('h1');
        if (!h1) return null; // SPA 壳或兜底首页
        const t = h1.textContent.trim();
        if (!t || t === '404' || /页面未找到/.test(t)) return null;
        // 异常页面防污染：GetAV 详情页 h1 必含番号本体；不含说明拿到的是
        // 跳转/提示/劫持页（如某些网络下被劫持到标题为 miss.ws 的页面），
        // 绝不能入库，否则标题会被替换成垃圾文本
        if (slug && t.toLowerCase().indexOf(slug) === -1) return null;
        return t;
    }

    /**
     * 按番号查 GetAV 中文标题。命中返回标题文本；未收录返回 null 并写负缓存；
     * 网络失败 / 异常页面返回 null 但【不写】负缓存（下次重试）。
     */
    async function fetchGetavTitle(slug) {
        const hit = cache[slug];
        if (hit && hit.getavMiss && Date.now() - hit.getavMiss < MISS_TTL) return null;
        try {
            const r = await httpGet('https://getav.net/zh/videos/' + encodeURIComponent(slug));
            if (r.status < 200 || r.status >= 300) {
                // 404 = 确认未收录，写负缓存；5xx 等异常不写，下次重试
                if (r.status === 404) {
                    cache[slug] = Object.assign(cache[slug] || {}, { getavMiss: Date.now() });
                }
                return null;
            }
            const title = parseGetavTitle(r.text, slug);
            // 200 但解析不出合规标题 = 异常页面（劫持/跳转/软错误），
            // 不是「确认未收录」——绝不写负缓存，否则一次网络波动把番号打入冷宫 7 天
            return title || null;
        } catch (e) {
            log('GetAV 查询失败 ' + slug, e);
            return null;
        }
    }

    /** 手机研发版备用：在 GetAV 顶层页面由脚本自身读取标题并写入共享缓存。 */
    function openGetavVerifyPage() {
        const card = collectCards().find((c) => c && c.slug && /\d/.test(c.slug));
        const slug = card ? card.slug : slugFromHref(location.href);
        if (!slug || !/\d/.test(slug)) {
            msg('当前页面没有识别到有效番号，请进入具体影片详情页或列表页后再试');
            return;
        }
        const url = 'https://getav.net/zh/videos/' + encodeURIComponent(slug);
        let tab = null;
        if (typeof GM_openInTab === 'function') {
            try { tab = GM_openInTab(url, { active: true, insert: true, setParent: true }); } catch (e) { log('GM_openInTab 失败', e); }
        }
        if (!tab) tab = window.open(url, '_blank');
        if (tab) msg('已打开 GetAV 验证页；页面显示中文标题后返回，再点「重查未收录」');
        else {
            msg('新标签页被拦截，正在当前页打开 GetAV；完成后用浏览器返回原页面');
            location.href = url;
        }
    }

    /* ---------------- Jable 官方中文标题源（优先级第四） ----------------
     * Jable 视频页（/videos/<番号小写>/）服务端直出官方繁中标题（h4），
     * 未收录返回干净的 HTTP 404。与 GetAV 同规则：标题必须含番号本体，
     * 负缓存只认 404，异常页面不写。
     * 注意：Jable 整站挂 Cloudflare，GM_xhr 拿不到 cf_clearance（桌面
     * Tampermonkey 与移动脚本管理器实测均被 403 挑战页拦截）。检测到
     * CF 拦截后【本会话内停用 Jable 层】——否则 403 不写负缓存，每页都会
     * 对每个未命中番号重复发注定失败的请求。不写持久标记：CF 按 IP/网络
     * 环境触发，换网络后可能恢复，下次会话自动重试。 */

    let jableBlocked = false;   // 会话级停用标记；同时镜像到 <html> dataset 便于诊断/测试读取
    let jableBlockReason = '';  // 停用原因（CF 拦截 / 连续网络失败），诊断面板展示
    let jableNetFails = 0;      // 连续失败计数：移动端 GM_xhr 常在网络层直接失败（收不到 403 响应），
    const JABLE_MAX_NET_FAILS = 3; // 连续 3 次失败同样判定为本环境不可用，避免每页重复发无效请求

    function markJableBlocked(reason) {
        if (jableBlocked) return;
        jableBlocked = true;
        jableBlockReason = reason;
        document.documentElement.dataset.mveJableBlocked = reason;
        log('Jable 查询不可用（' + reason + '），本会话停用 Jable 层（中文标题降级为大模型兜底）');
    }

    /** 判断响应是否为 Cloudflare 人机验证挑战页 */
    function isCfChallenge(r) {
        return r.status === 403 && /just a moment|cf-chl|cloudflare/i.test(r.text || '');
    }

    /** 从 Jable 视频页 HTML 解析官方中文标题；404 / 未收录返回 null */
    function parseJableTitle(html, slug) {
        if (!html) return null;
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const h4 = doc.querySelector('h4');
        if (!h4) return null;
        const t = h4.textContent.trim();
        if (!t) return null;
        // 同 GetAV 防污染：标题必须含番号本体
        if (slug && t.toLowerCase().indexOf(slug) === -1) return null;
        return t;
    }

    /**
     * 按番号查 Jable 官方中文标题。命中返回标题文本；未收录返回 null 并写负缓存；
     * 网络失败 / 异常页面返回 null 但【不写】负缓存（下次重试）；
     * CF 拦截或连续网络失败达到阈值，返回 null 并停用本会话的 Jable 层。
     */
    async function fetchJableTitle(slug) {
        if (jableBlocked) return null;
        const hit = cache[slug];
        if (hit && hit.jableMiss && Date.now() - hit.jableMiss < MISS_TTL) return null;
        try {
            const r = await httpGet('https://jable.tv/videos/' + encodeURIComponent(slug) + '/');
            if (r.status < 200 || r.status >= 300) {
                if (isCfChallenge(r)) {
                    markJableBlocked('Cloudflare 人机验证拦截');
                } else if (r.status === 404) {
                    // 404 = 网络链路正常（服务器明确应答），重置失败计数
                    jableNetFails = 0;
                    cache[slug] = Object.assign(cache[slug] || {}, { jableMiss: Date.now() });
                } else if (++jableNetFails >= JABLE_MAX_NET_FAILS) {
                    // 5xx 等持续异常也计入熔断，避免对故障中的服务器反复请求
                    markJableBlocked('连续 ' + jableNetFails + ' 次请求失败（HTTP ' + r.status + '）');
                }
                return null;
            }
            jableNetFails = 0; // 2xx：链路正常，重置计数
            return parseJableTitle(r.text, slug) || null;
        } catch (e) {
            // 网络层失败（部分移动脚本管理器的 GM_xhr 到 CF 站点直接走不到响应）
            jableNetFails++;
            if (jableNetFails >= JABLE_MAX_NET_FAILS) {
                markJableBlocked('连续 ' + jableNetFails + ' 次网络失败');
            } else {
                log('Jable 查询失败 ' + slug, e);
            }
            return null;
        }
    }

    /* ---------------- Manko 中文资料源（研发版第三源） ----------------
     * manko.fun 页面把检索 API 代理到公开的后端域名，返回轻量字节编码的 JSON。
     * 这里先检索番号拿到内部 _id，再读取详情；不依赖 Cloudflare 页面 DOM，且只把
     * 详情中的 zh 标题/简介写入缓存。网络异常不写负缓存，404/空结果才记 mankoMiss。 */
    const MANKO_MISS_TTL = MISS_TTL;
    const MANKO_API_HOSTS = ['healertanker.com', 'alpharomeo.shop'];
    const MANKO_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"';

    function decodeMankoPayload(encoded) {
        const bytes = [];
        let acc = 0, bits = 0, pending = -1;
        for (const ch of String(encoded || '')) {
            const value = MANKO_ALPHABET.indexOf(ch);
            if (value < 0) continue;
            if (pending < 0) {
                pending = value;
            } else {
                acc |= (pending + 91 * value) << bits;
                bits += (8191 & (pending + 91 * value)) > 88 ? 13 : 14;
                do {
                    bytes.push(255 & acc);
                    acc >>= 8;
                    bits -= 8;
                } while (bits > 7);
                pending = -1;
            }
        }
        if (pending > -1) bytes.push(255 & (acc | pending << bits));
        return new TextDecoder().decode(new Uint8Array(bytes));
    }

    async function fetchMankoApi(path) {
        let lastError = null;
        for (const host of MANKO_API_HOSTS) {
            try {
                const r = await httpGet('https://' + host + '/' + path);
                if (r.status < 200 || r.status >= 300) {
                    lastError = new Error('HTTP ' + r.status);
                    continue;
                }
                const outer = JSON.parse(r.text || '{}');
                return JSON.parse(decodeMankoPayload(outer.data));
            } catch (e) {
                lastError = e;
            }
        }
        throw lastError || new Error('Manko 请求失败');
    }

    function pickMankoChineseTitle(detail, slug) {
        const names = Array.isArray(detail && detail.title_display_name) ? detail.title_display_name : [];
        const zhName = names.find((x) => /^zh(?:-|$)/i.test(String(x && x.language || '')) && x.title);
        const zhOverview = Array.isArray(detail && detail.discription)
            ? detail.discription.find((x) => /^zh(?:-|$)/i.test(String(x && x.language || '')) && x.overview)
            : null;
        const title = String((zhName && zhName.title) || (zhOverview && zhOverview.overview) || '').trim();
        if (!title || title.length > 240 || /just a moment|cloudflare|页面未找到/i.test(title)) return null;
        // 详情 API 已按 _id 关联番号；仅拒绝明显的错误占位，不强制中文简介包含番号。
        if (slug && title.toLowerCase() === slug.toLowerCase()) return null;
        return title;
    }

    async function fetchMankoTitle(slug) {
        const hit = cache[slug];
        if (hit && hit.mankoMiss && Date.now() - hit.mankoMiss < MANKO_MISS_TTL) return null;
        try {
            const list = await fetchMankoApi('swx/movie/search?keyword=' + encodeURIComponent(slug) + '&size=24&page=1');
            const rows = Array.isArray(list) ? list : (Array.isArray(list && list.data) ? list.data : []);
            const row = rows.find((x) => String(x && (x.title || x.title_display_name && x.title_display_name[0] && x.title_display_name[0].title) || '').toLowerCase() === slug.toLowerCase()) || rows[0];
            if (!row || !row._id) {
                cache[slug] = Object.assign(cache[slug] || {}, { mankoMiss: Date.now() });
                return null;
            }
            const detail = await fetchMankoApi('swx/movie/detail/' + encodeURIComponent(row._id));
            const title = pickMankoChineseTitle(detail, slug);
            if (!title) cache[slug] = Object.assign(cache[slug] || {}, { mankoMiss: Date.now() });
            return title;
        } catch (e) {
            log('Manko 查询失败 ' + slug, e);
            return null;
        }
    }

    /**
     * 批量解析：批量查 GetAV（并发 ≤2），命中的按来源优先级写缓存并即时回写页面。
     * 返回未命中的番号数组，交给下一层。
     */
    async function resolveVia(slugs, fetchTitle, src) {
        const missed = [];
        for (let i = 0; i < slugs.length; i += 2) {
            await Promise.all(slugs.slice(i, i + 2).map(async (s) => {
                const title = await fetchTitle(s);
                if (title && setZh(s, title, src)) {
                    saveCache(cache);
                    applyCached(collectCards());
                }
                if (!title) missed.push(s);
            }));
        }
        return missed;
    }
    const resolveViaGetav = (slugs) => resolveVia(slugs, fetchGetavTitle, 'getav');
    const resolveViaJable = (slugs) => resolveVia(slugs, fetchJableTitle, 'jable');
    const resolveViaManko = (slugs) => resolveVia(slugs, fetchMankoTitle, 'manko');

    /* ---------------- 免费标题源查询候选（含「来源升级」） ----------------
     * GetAV 的收录是增长的：昨天 404 的番号今天可能有了精校中字。
     * 两类番号需要查 GetAV：
     * 1) 尚无中文标题的——常规查询；
     * 2) 只有旧 llm 译文的——「升级查询」：译文超过 UPGRADE_AFTER 且
     *    近期没查过 GetAV，就重查一次，命中则以精校替换机翻
     *    （setZh 优先级 getav > llm 自动完成替换）。
     * 频率天然有界：404 会写 24h 负缓存，升级候选按 3 天节奏复查。 */
    const UPGRADE_AFTER = 3 * 24 * 3600 * 1000;

    function needMankoQuery(slugs) {
        const now = Date.now();
        return slugs.filter((s) => {
            const hit = cache[s];
            if (hit && (hit.zhSrc === 'getav' || hit.zhSrc === 'manko')) return false;
            if (hit && hit.mankoMiss && now - hit.mankoMiss < MISS_TTL) return false;
            return true;
        });
    }

    function needGetavQuery(slugs) {
        const now = Date.now();
        return slugs.filter((s) => {
            const hit = cache[s];
            if (!hit || !hit.zh) return true;                                  // 无中文：常规查询
            if (hit.zhSrc !== 'llm') return false;                             // 已是 Manko/精校/官方中文
            if (hit.zhAt && now - hit.zhAt < UPGRADE_AFTER) return false;      // 译文还新鲜
            if (hit.getavMiss && now - hit.getavMiss < UPGRADE_AFTER) return false; // 近期确认未收录
            return true;                                                       // 旧机翻：尝试升级
        });
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

    /**
     * 兜底收集：站点改版或首页用了不同卡片结构时，主选择器可能一张都匹配不到。
     * 用「链接文本里含番号本身」这条强特征定位标题链接（番号是跨站同一性主键），
     * 再用文本长度排除整块容器。只在主选择器为空时调用，不影响正常页面。
     */
    function collectAnchorsBySlug(selector, maxTextLen) {
        const out = [];
        document.querySelectorAll(selector).forEach((a) => {
            const slug = slugFromHref(a.href);
            if (!slug || !/\d/.test(slug)) return;
            const txt = a.textContent.trim();
            if (!txt || txt.length > maxTextLen) return;
            if (!txt.toUpperCase().includes(slug.toUpperCase())) return;
            out.push({ slug, anchor: a, hidden: false });
        });
        return out;
    }

    /** Jable 卡片：h6.title 里的番号链接 + 同卡 .video-img-box 封面容器 */
    function collectJableCards() {
        const out = [];
        document.querySelectorAll('h6.title a[href*="/videos/"]').forEach((anchor) => {
            const slug = slugFromHref(anchor.href);
            if (!slug) return;
            out.push({ slug, anchor, box: anchor.closest('.video-img-box'), hidden: false });
        });
        // 首页/改版兜底：找带番号文本的视频链接，补上封面容器（有则加字幕徽章）
        if (!out.length) {
            collectAnchorsBySlug('a[href*="/videos/"]', 200).forEach((c) => {
                c.box = c.anchor.closest('.video-img-box');
                out.push(c);
            });
        }
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
                // 只写 zh 不碰 ja——ja 保留站点原文供翻译/语言判定；
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

    /** Jable 主流程：原标题就在当前页 DOM，按 GetAV → Manko → 大模型补齐 */
    async function enhanceJableTitles() {
        if (running) {
            rerunAfter = true;
            return;
        }
        const cards = processJableDom();
        if (!cards.length) return;
        const slugs = [...new Set(cards.map((c) => c.slug))];
        // 先算好有没有网络工作要做：全部命中缓存时直接早退——
        // Observer 高频回调（我们自己改 DOM 也会触发）不能让按钮状态空闪
        const wantZh = needGetavQuery(slugs);
        const wantManko = needMankoQuery(slugs);
        const needLlm = () => config.apiKey
            ? slugs.filter((s) => cache[s] && cache[s].ja && !cache[s].zh)
            : [];
        if (!wantManko.length && !wantZh.length && !needLlm().length) return;
        running = true;
        setButtonState('translating');
        try {
            // 第 2 层：GetAV 精校中文（无需 Key）
            if (wantZh.length) await resolveViaGetav(wantZh);
            // 第 3 层：Manko 中文资料（GetAV 未命中时补查）
            const stillNeedManko = wantManko.filter((s) => !cache[s] || !cache[s].zh);
            if (stillNeedManko.length) await resolveViaManko(stillNeedManko);
            // Jable 当前页已经是本源，不能重复请求自己；剩余部分交给大模型
            const todo = needLlm();
            for (let i = 0; i < todo.length; i += 20) {
                const chunk = todo.slice(i, i + 20);
                const zhArr = await translateBatch(chunk.map((s) => cache[s].ja));
                chunk.forEach((s, j) => {
                    setZh(s, zhArr[j], 'llm');
                });
                saveCache(cache);
                applyCached(collectJableCards());
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
            // 2026-11 新版 GetAV（Next.js 改版）：指向视频的 <a> 包着「标题 + 播放量/演员」
            // 整块信息，标题实际在内层 h3。若直接把 textContent 写进 <a>，会把统计信息
            // 一起抹掉、缓存里也会混入播放量等杂质。只在标题元素文本确实含番号时才改目标，
            // 旧版结构（<a> 本身就是标题链接）自动走回退分支。
            const titleEl = anchor.querySelector('h1, h2, h3, h4');
            const target = titleEl && titleEl.textContent.toUpperCase().includes(slug.toUpperCase())
                ? titleEl : anchor;
            out.push({ slug, anchor: target, hidden: false });
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

    /** GetAV 主流程：本站中文直接入缓存；日文原标题走「缓存 → Manko → Jable → 大模型」（不查自己） */
    async function enhanceGetavTitles() {
        if (running) {
            rerunAfter = true;
            return;
        }
        const cards = processGetavDom();
        if (!cards.length) return;
        const slugs = [...new Set(cards.map((c) => c.slug))];
        // 同样先算工作量再启动：Observer 高频回调不能让按钮状态空闪
        const wantManko = needMankoQuery(slugs);
        const wantZh = slugs.filter((s) => !cache[s] || !cache[s].zh);
        const needLlm = () => config.apiKey
            ? slugs.filter((s) => cache[s] && cache[s].ja && !cache[s].zh)
            : [];
        if (!wantManko.length && !wantZh.length && !needLlm().length) return;
        running = true;
        setButtonState('translating');
        try {
            // GetAV 上的日文原标题：先查 Manko，再查 Jable，最后轮到大模型
            if (wantManko.length) await resolveViaManko(wantManko);
            const stillNeedJable = wantZh.filter((s) => !cache[s] || !cache[s].zh);
            if (stillNeedJable.length) await resolveViaJable(stillNeedJable);
            const todo = needLlm();
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
            // 标题链接优先在卡片内部找：首页（推荐/新着等网格）把 .my-2 标题放在
            // .thumbnail 里、而 .thumbnail 直接挂在 grid 下，若先查 parentElement，
            // 每张卡都会拿到整个网格里第一张卡的标题链接——所有卡片指向同一个番号，
            // 结果只有第一张卡的标题被替换（「首页标题不生效」的根因）。
            // 列表页标题若在卡片外层（每个卡片有独立包裹 div），内部查不到时再回退父级。
            const anchor = thumb.querySelector('.my-2 a[href], a.mv-full-title[href]') ||
                thumb.parentElement.querySelector('.my-2 a[href], a.mv-full-title[href]');
            if (!anchor) return;
            const slug = slugFromHref(anchor.href);
            if (!slug) return;
            const card = thumb.parentElement;
            const hidden = card && getComputedStyle(card).display === 'none';
            out.push({ slug, anchor, hidden });
        });
        // 首页/改版兜底：整页没有任何 .thumbnail 时，按「链接文本含番号」识别标题链接
        if (!out.length) out.push(...collectAnchorsBySlug('a[href]', 160));
        // 详情页主标题 h1（路径末段含数字视为番号页，排除 release 等列表页）
        const h1 = document.querySelector('h1');
        const pageSlug = slugFromHref(location.href);
        if (h1 && pageSlug && /\d/.test(pageSlug)) {
            out.push({ slug: pageSlug, anchor: h1, isDetail: true, hidden: false });
        }
        return out;
    }

    /** 缓存命中即回写中文译文；没有中文来源的番号保持原标题 */
    function applyCached(cards) {
        let applied = 0;
        cards.forEach(({ slug, anchor, hidden }) => {
            if (hidden) return; // 去重隐藏的卡片不写
            const hit = cache[slug];
            // 只写中文：没有中文来源的番号保持原标题（不再有「日文原标题」模式）
            const want = hit && hit.zh;
            if (want && anchor.textContent.trim() !== want) {
                setTextSafe(anchor, want);
                applied++;
            }
        });
        return applied;
    }

    /** 主流程：先取中文（GetAV / Jable），未收录的再抓日文交给大模型兜底 */
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
        // 中文标题链：GetAV 精校中文免费、无需 Key，缺中文的番号就是有工作可做
        // （含「来源升级」：超过 3 天的 llm 旧译文会重查 GetAV，命中以精校替换机翻）
        const needZh = needGetavQuery(allSlugs);
        const needManko = needMankoQuery(allSlugs);
        // 日文抓取（iframe + CF 验证，成本高）只服务大模型翻译：没填 Key 抓到也没人翻，
        // 直接跳过，只跑免费中文源
        const jaWanted = !!config.apiKey;
        if ((!needJa.length || !jaWanted) && !needManko.length && !needZh.length) return;

        running = true;
        setButtonState('translating');
        // 把当前可翻的（已有日文、缺中文）送去大模型；返回是否还有剩余
        const translateTodo = async () => {
            if (!config.apiKey) return;
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
            // 第 2 层：GetAV 精校中文源
            if (needZh.length) await resolveViaGetav(needZh);
            // 第 3 层：Manko 中文资料源（GetAV 未命中时补查）
            const stillNeedManko = needManko.filter((s) => !cache[s] || !cache[s].zh);
            if (stillNeedManko.length) await resolveViaManko(stillNeedManko);
            // 第 4 层：Jable 官方中文源
            const stillNeedJable = stillNeedManko.filter((s) => !cache[s] || !cache[s].zh);
            if (stillNeedJable.length) await resolveViaJable(stillNeedJable);
            // 免费源命中的番号已有可靠中文，连日文原文都不再需要——
            // 日文抓取和大模型只为免费源都没收录的番号兜底
            const needJa2 = needJa.filter((s) => !cache[s] || !cache[s].zh);
            if (needJa2.length && jaWanted) {
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
            'position:fixed;right:16px;bottom:124px;z-index:99999;width:300px;max-width:calc(100vw - 32px);' +
            // 手机小屏：面板高度封顶并内部滚动（dvh 适配移动浏览器地址栏，vh 兜底）
            'max-height:calc(100vh - 150px);max-height:calc(100dvh - 150px);' +
            'overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;' +
            'padding:14px;border-radius:10px;' +
            'background:#1f2430;border:1px solid #3b7cd7;color:#d7dee9;font-size:13px;display:none;' +
            'box-shadow:0 4px 20px rgba(0,0,0,.6);';
        // 面板分四组折叠（<details>）：默认只展开「大模型与 Key」，
        // 其余按需展开——元素多，手机上一口气铺开会超屏
        const secStyle = 'cursor:pointer;padding:7px 0;font-weight:600;color:#cbd5e1;';
        const boxStyle = 'padding:2px 0 4px';
        const inputStyle = 'width:100%;margin-top:2px;padding:5px;border-radius:6px;border:1px solid #4c566a;background:#2e3440;color:#eceff4';
        const ghostBtn = 'padding:6px;border:1px solid #4c566a;border-radius:6px;background:transparent;color:#d7dee9;cursor:pointer;font-size:12px';
        panel.innerHTML =
            '<div style="font-weight:600;margin-bottom:8px">' + ({ jable: 'Jable 标题增强设置', getav: 'GetAV 增强设置' }[SITE] || 'MissAV 综合增强设置') + '</div>' +
            '<button id="mve-save" style="width:100%;padding:6px;border:none;border-radius:6px;background:#3b7cd7;color:#fff;cursor:pointer">保存并应用</button>' +
            '<div style="margin:6px 0 2px;font-size:11px;color:#8b93a5">中文标题：缓存 → GetAV 精校 → Manko → Jable 繁中 → 大模型兜底（前四级无需 Key）</div>' +
            '<details open style="border-top:1px solid #2e3440;margin-top:4px">' +
            '<summary style="' + secStyle + '">大模型与 Key</summary>' +
            '<div style="' + boxStyle + '">' +
            '<label style="display:block;margin-bottom:2px">大模型服务<br><select id="mve-provider" style="' + inputStyle + '">' +
            PROVIDERS.map((p) => '<option value="' + p.id + '">' + p.name + '</option>').join('') +
            '</select></label>' +
            '<div id="mve-key-hint" style="margin:0 0 6px;font-size:11px;color:#8b93a5"></div>' +
            '<label style="display:block;margin-bottom:6px">API Key<br><input id="mve-key" type="password" placeholder="sk-..." style="' + inputStyle + '"></label>' +
            // 选「自定义」才展开的手填区；预设服务商的地址/模型由 PROVIDERS 提供
            '<div id="mve-custom-fields" style="display:none">' +
            '<label style="display:block;margin-bottom:6px">API 地址<br><input id="mve-base" style="' + inputStyle + '"></label>' +
            '<label style="display:block;margin-bottom:6px">模型<br><input id="mve-model" style="' + inputStyle + '"></label>' +
            '</div>' +
            '</div>' +
            '</details>' +
            '<details style="border-top:1px solid #2e3440">' +
            '<summary style="' + secStyle + '">功能开关</summary>' +
            '<div style="' + boxStyle + '">' +
            '<label style="display:flex;align-items:center;gap:6px;margin:6px 0"><input id="mve-enabled" type="checkbox"> 启用标题修正</label>' +
            '<label style="display:flex;align-items:center;gap:6px;margin:6px 0"><input id="mve-showbtn" type="checkbox"> 显示右下角「译」按钮（隐藏后可用脚本菜单打开本设置）</label>' +
            '<label style="display:flex;align-items:center;gap:6px;margin:6px 0"><input id="mve-dedup" type="checkbox"> 启用翻页去重（刷新生效）</label>' +
            '<label style="display:flex;align-items:center;gap:6px;margin:6px 0"><input id="mve-grid" type="checkbox"> 启用片单网格化（刷新生效）</label>' +
            '<label style="display:flex;align-items:center;gap:6px;margin:6px 0"><input id="mve-preview" type="checkbox"> 预览独占：同时只播放一个预览视频（刷新生效）</label>' +
            '</div>' +
            '</details>' +
            '<details style="border-top:1px solid #2e3440">' +
            '<summary style="' + secStyle + '">数据（缓存 / 备份）</summary>' +
            '<div style="' + boxStyle + '">' +
            '<div style="display:flex;gap:8px;margin-top:6px">' +
            '<button id="mve-export" style="flex:1;' + ghostBtn + '">导出配置+缓存</button>' +
            '<button id="mve-import" style="flex:1;' + ghostBtn + '">导入</button>' +
            '<input id="mve-import-file" type="file" accept=".json,application/json" style="display:none">' +
            '</div>' +
            '<div style="display:flex;gap:8px;margin-top:8px">' +
            '<button id="mve-clear" style="flex:1;' + ghostBtn + '">清缓存</button>' +
            '</div>' +
            '<div style="margin-top:6px;font-size:11px;color:#8b93a5">导出文件含明文 API Key，注意保管；可存入 iCloud 云盘跨浏览器导入</div>' +
            '</div>' +
            '</details>' +
            '<details style="border-top:1px solid #2e3440">' +
            '<summary style="' + secStyle + '">诊断与重查</summary>' +
            '<div style="' + boxStyle + '">' +
            '<div style="display:flex;gap:8px;margin-top:6px">' +
            '<button id="mve-retry" style="flex:1;' + ghostBtn + '">重查未收录</button>' +
            '<button id="mve-diag" style="flex:1;' + ghostBtn + '">诊断</button>' +
            '</div>' +
            '<button id="mve-getav-verify" style="width:100%;margin-top:8px;' + ghostBtn + '">打开 GetAV 验证页（研发版）</button>' +
            '<pre id="mve-diag-out" style="display:none;margin-top:6px;padding:8px;border-radius:6px;background:#12151d;color:#9db8dd;font-size:11px;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto"></pre>' +
            '</div>' +
            '</details>' +
            '<div id="mve-msg" style="margin-top:8px;font-size:12px;color:#9db8dd;min-height:14px"></div>';
        document.body.appendChild(panel);

        if (SITE !== 'missav') {
            // 这三个功能是 MissAV 专属，其他站点隐藏无关开关（保留配置值，回显/保存不受影响）
            ['#mve-dedup', '#mve-grid', '#mve-preview'].forEach((sel) => {
                const label = panel.querySelector(sel).closest('label');
                if (label) label.style.display = 'none';
            });
        }
        if (SITE === 'getav') {
            const verify = panel.querySelector('#mve-getav-verify');
            if (verify) verify.style.display = 'none';
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
                titlesEnabled: panel.querySelector('#mve-enabled').checked,
                dedupEnabled: panel.querySelector('#mve-dedup').checked,
                gridEnabled: panel.querySelector('#mve-grid').checked,
                previewExclusive: panel.querySelector('#mve-preview').checked,
                showButton: panel.querySelector('#mve-showbtn').checked,
            };
            btn.style.display = config.showButton ? '' : 'none';
            saveConfig(config);
            lastError = null;
            msg('已保存' + (!config.apiKey ? '（未填 Key：GetAV 精校 / Jable 中文照常使用，未收录的保持原标题）' : ''));
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
        panel.querySelector('#mve-diag').addEventListener('click', runDiagnostics);
        panel.querySelector('#mve-getav-verify').addEventListener('click', openGetavVerifyPage);
        // 「重查未收录」：清掉 GetAV/Jable/Manko 的负缓存标记并立即重跑标题链。
        // 适用场景：明知某站刚收录了新片（负缓存 24h 内），不想等自动过期
        panel.querySelector('#mve-retry').addEventListener('click', () => {
            let n = 0;
            Object.keys(cache).forEach((k) => {
                const c = cache[k];
                if (!c) return;
                if (c.getavMiss) { delete c.getavMiss; n++; }
                if (c.jableMiss) { delete c.jableMiss; n++; }
                if (c.mankoMiss) { delete c.mankoMiss; n++; }
            });
            saveCache(cache);
            msg('已清除 ' + n + ' 条「未收录」标记，正在重新查询…');
            togglePanel();
            enhanceTitles();
        });
    }

    /* ---------------- 环境诊断（面板一键自检，结果可复制反馈） ---------------- */

    async function runDiagnostics() {
        const out = panel.querySelector('#mve-diag-out');
        out.style.display = 'block';
        const lines = [];
        const add = (k, v) => { lines.push(k + '：' + v); out.textContent = lines.join('\n'); };
        const diagnosticSlug = (() => {
            try {
                const card = collectCards().find((c) => c && c.slug && /\d/.test(c.slug));
                return (card && card.slug) || 'jur-857';
            } catch {
                return 'jur-857';
            }
        })();
        const ver = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '?';
        add('脚本版本', ver + '（站点：' + SITE + '）');
        add('GM_xhr', typeof GM_xmlhttpRequest === 'function' ? '✓ 存在' : '✗ 不存在（GetAV 跨站查询无法工作）');
        add('GM 存储', hasGM ? '✓ 存在' : '✗ 不存在（用 localStorage 兜底，缓存不跨站共享）');
        if (SITE === 'getav') {
            add('React 水合', !hydrationInfo.checked ? '等待中（门控尚未放行）'
                : (hydrationInfo.hydrated ? '✓ 已检测到 React 接管' : '✗ 未检测到 React') +
                  '，放行原因 ' + hydrationInfo.why + '，等待 ' + hydrationInfo.waitedMs + 'ms');
            add('文本改写', 'nodeValue ' + textWrites.node + ' 次 / 整块替换 ' + textWrites.block + ' 次' +
                (textWrites.samples.length ? '（' + textWrites.samples.join('，') + '）' : ''));
        }
        // 当前页卡片识别情况：排查「首页/某类页面标题不替换」时一眼看出是没识别到卡片，
        // 还是识别到了但两个中文源都没收录
        try {
            const cardsNow = collectCards();
            const uniq = [...new Set(cardsNow.map((c) => c.slug))];
            const src = { getav: 0, jable: 0, manko: 0, llm: 0 };
            uniq.forEach((s) => {
                const h = cache[s];
                if (h && h.zh) src[h.zhSrc && src[h.zhSrc] !== undefined ? h.zhSrc : 'llm']++;
            });
            add('页面卡片', cardsNow.length + ' 个标题链接 / ' + uniq.length + ' 个番号');
            add('缓存中文', 'getav ' + src.getav + ' / manko ' + src.manko + ' / jable ' + src.jable + ' / llm ' + src.llm);
        } catch (e) {
            add('页面卡片', '识别失败：' + (e && e.message));
        }
        const keys = Object.keys(cache);
        const zhN = keys.filter((k) => cache[k] && cache[k].zh).length;
        const missN = keys.filter((k) => cache[k] && cache[k].getavMiss).length;
        const mankoMissN = keys.filter((k) => cache[k] && cache[k].mankoMiss).length;
        add('缓存', keys.length + ' 条（含中文 ' + zhN + '，GetAV 负缓存 ' + missN + '，Manko 负缓存 ' + mankoMissN + '）');
        if (SITE !== 'getav' && typeof GM_xmlhttpRequest === 'function') {
            add('GetAV 查询', '测试中…');
            try {
                const r = await httpGet('https://getav.net/zh/videos/jur-857');
                const t = parseGetavTitle(r.text, 'jur-857');
                lines[lines.length - 1] = 'GetAV 查询：HTTP ' + r.status +
                    (t ? '，✓ 标题：' + t.slice(0, 40)
                       : '，但解析不到合规标题（异常页面，前 100 字：' + r.text.slice(0, 100).replace(/\s+/g, ' ') + '）');
            } catch (e) {
                lines[lines.length - 1] = 'GetAV 查询：✗ 失败——' + e.message +
                    '（研发版可点「打开 GetAV 验证页」，由手机顶层页面读取标题）';
            }
            out.textContent = lines.join('\n');
        }
        if (typeof GM_xmlhttpRequest === 'function') {
            add('Manko 查询', '测试中（番号 ' + diagnosticSlug + '）…');
            try {
                const list = await fetchMankoApi('swx/movie/search?keyword=' + encodeURIComponent(diagnosticSlug) + '&size=24&page=1');
                const rows = Array.isArray(list) ? list : (Array.isArray(list && list.data) ? list.data : []);
                const row = rows.find((x) => String(x && x.title || '').toLowerCase() === diagnosticSlug.toLowerCase()) || rows[0];
                if (!row || !row._id) {
                    lines[lines.length - 1] = 'Manko 查询：搜索 HTTP 200，但未找到匹配番号';
                } else {
                    const detail = await fetchMankoApi('swx/movie/detail/' + encodeURIComponent(row._id));
                    const title = pickMankoChineseTitle(detail, diagnosticSlug);
                    lines[lines.length - 1] = 'Manko 查询：搜索/详情 HTTP 200' +
                        (title ? '，✓ 中文资料：' + title.slice(0, 60) : '，但详情没有合规中文标题/简介');
                }
            } catch (e) {
                lines[lines.length - 1] = 'Manko 查询：✗ 失败——' + e.message + '（可能是网络、后端域名或 @connect 授权限制）';
            }
            out.textContent = lines.join('\n');
        }
        if (SITE !== 'jable' && typeof GM_xmlhttpRequest === 'function') {
            add('Jable 查询', '测试中…');
            try {
                const r = await httpGet('https://jable.tv/videos/jur-857/');
                if (isCfChallenge(r)) {
                    markJableBlocked('Cloudflare 人机验证拦截');
                    lines[lines.length - 1] = 'Jable 查询：✗ HTTP 403——Cloudflare 人机验证拦截（本环境的 GM_xhr 过不了 CF，属环境限制非脚本故障；Jable 层本会话已自动停用，中文标题由其他来源兜底）';
                } else {
                    const t = parseJableTitle(r.text, 'jur-857');
                    lines[lines.length - 1] = 'Jable 查询：HTTP ' + r.status +
                        (t ? '，✓ 标题：' + t.slice(0, 40)
                           : '，但解析不到合规标题（异常页面，前 100 字：' + r.text.slice(0, 100).replace(/\s+/g, ' ') + '）');
                }
            } catch (e) {
                // 网络层失败（移动端常见）：单次不熔断，但提示这同样属于环境限制
                lines[lines.length - 1] = 'Jable 查询：✗ 失败——' + e.message +
                    '（本环境的 GM_xhr 无法连通 jable.tv，多为 Cloudflare 对脚本管理器请求的限制，属环境限制非脚本故障；连续失败 ' + JABLE_MAX_NET_FAILS + ' 次后 Jable 层会自动停用）';
            }
            out.textContent = lines.join('\n');
            add('Jable 层状态', jableBlocked ? '本会话已停用（' + jableBlockReason + '）' : '正常');
        }
        add('提示', '以上结果可截图发给作者排查');
    }

    /* ---------------- 导出 / 导入（跨浏览器迁移，文件可存 iCloud 云盘） ---------------- */

    function exportBackup() {
        const data = {
            app: 'missav-enhancer',
            version: (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || 'unknown',
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
                    delete config.mode; // 旧备份里的「日文原标题」字段已废弃
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
            panel.querySelector('#mve-enabled').checked = config.titlesEnabled;
            panel.querySelector('#mve-dedup').checked = config.dedupEnabled;
            panel.querySelector('#mve-grid').checked = config.gridEnabled;
            panel.querySelector('#mve-preview').checked = config.previewExclusive;
            panel.querySelector('#mve-showbtn').checked = config.showButton;
            if (lastError) msg('上次出错：' + lastError);
            else msg(!config.apiKey ? '未填 API Key：只用 GetAV / Jable 免费中文源，未收录的保持原标题' : '');
        }
    }

    /* ================================================================
     * 模块七 getav-ui：GetAV 界面增强（原 getav-full-titles 脚本并入）
     * 三个功能：解除标题截断、title 属性补全、订阅页三列网格卡片。
     * 与主流程共用 document-idle 启动，
     * 首次渲染可能有极短暂的截断闪现，Observer 会立即修正。
     * ================================================================ */

    /**
     * 当前是否 GetAV 订阅页。用函数而非常量：GetAV 是 Next.js 客户端路由，
     * 站内跳转不会重新加载脚本——常量会在脚本加载时定死，之后从别的页面
     * 点进订阅页就永远不生效（用户实测「首次进入没反应、刷新后才好」即此）。
     */
    function isGetavSubscriptionsPage() {
        return SITE === 'getav' && /\/profile\/subscriptions/.test(location.pathname);
    }

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
        // 订阅页样式常驻注入（只在 #getav-sub-grid 存在时生效）：
        // SPA 跳转到订阅页不会再走一遍 init，按路径条件注入会漏掉样式
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
        if (!isGetavSubscriptionsPage()) return;
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
                setTextSafe(el, t);
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
                }
                makeGetavThreeColumns();
            }, 300);
        };
        fillGetavFromTitle(document);
        expandGetavTruncated(document);
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
     * 模块八 film-intro：MissAV 详情页「影片介绍」Tab
     * 7mmtv 的详情页有中文/英文两套页面：先 POST 搜索中文详情，找不到或无介绍
     * 时回退英文；文字和图片都从详情 HTML 解析，点击 Tab 前不发请求。
     * 图片只限制宽度为容器宽度，保持原始比例，不裁剪、不拉伸。
     * ================================================================ */

    const filmIntroState = { installed: false, loading: false, cache: {} };

    function missavDetailSlug() {
        const slug = slugFromHref(location.href);
        return slug && /\d/.test(slug) && document.querySelector('h1') ? slug : '';
    }

    function parse7mmtvIntro(html, slug) {
        const doc = new DOMParser().parseFromString(html || '', 'text/html');
        const heading = doc.querySelector('.fullvideo-title, h1');
        const headingText = heading ? heading.textContent.trim() : '';
        if (slug && headingText && headingText.toLowerCase().indexOf(slug.toLowerCase()) === -1) return null;
        const textNode = doc.querySelector('.video-introduction-images-text');
        const text = textNode ? textNode.textContent.trim() : '';
        const images = [];
        const addImage = (url) => {
            try {
                const u = new URL(String(url || ''), 'https://7mmtv.sx');
                if (u.protocol === 'https:' && !images.includes(u.href)) images.push(u.href);
            } catch { /* 忽略无效图片地址 */ }
        };
        doc.querySelectorAll('#fullvideo_showallcg img').forEach((img) => {
            addImage(img.getAttribute('data-src') || img.getAttribute('src'));
        });
        doc.querySelectorAll('script').forEach((script) => {
            const source = script.textContent || '';
            const re = /fullvideo_showallcg_arr\[\d+\]\s*=\s*['"]([^'"]+)['"]/g;
            let match;
            while ((match = re.exec(source))) addImage(match[1]);
        });
        if (!text && !images.length) return null;
        return { text, images };
    }

    async function fetch7mmtvIntro(slug, lang) {
        const prefix = lang === 'zh' ? 'zh' : 'en';
        const searchUrl = 'https://7mmtv.sx/' + prefix + '/searchform_search/all/index.html';
        const body = 'op=search&search_keyword=' + encodeURIComponent(slug) + '&search_type=searchall';
        const search = await httpPost(searchUrl, body);
        if (search.status < 200 || search.status >= 300) throw new Error(prefix + ' 搜索 HTTP ' + search.status);
        const searchDoc = new DOMParser().parseFromString(search.text || '', 'text/html');
        const needle = slug.toLowerCase();
        let detailUrl = '';
        for (const anchor of searchDoc.querySelectorAll('a[href]')) {
            try {
                const u = new URL(anchor.href, 'https://7mmtv.sx');
                const last = decodeURIComponent(u.pathname.split('/').pop() || '').replace(/\.html$/i, '');
                if (last.toLowerCase() === needle && /_content\//i.test(u.pathname)) {
                    detailUrl = u.href;
                    break;
                }
            } catch { /* 忽略异常链接 */ }
        }
        if (!detailUrl) return null;
        const detail = await httpGet(detailUrl);
        if (detail.status < 200 || detail.status >= 300) throw new Error(prefix + ' 详情 HTTP ' + detail.status);
        const parsed = parse7mmtvIntro(detail.text, slug);
        return parsed ? Object.assign(parsed, { lang: prefix, url: detailUrl }) : null;
    }

    async function load7mmtvIntro(slug) {
        if (filmIntroState.cache[slug]) return filmIntroState.cache[slug];
        let zhError = null;
        try {
            const zh = await fetch7mmtvIntro(slug, 'zh');
            if (zh) return (filmIntroState.cache[slug] = zh);
        } catch (e) { zhError = e; }
        try {
            const en = await fetch7mmtvIntro(slug, 'en');
            if (en) return (filmIntroState.cache[slug] = en);
        } catch (e) {
            throw new Error('中文/英文详情均请求失败：' + ((e && e.message) || e));
        }
        if (zhError) throw new Error('中文详情无影片介绍，英文详情也未找到对应影片');
        return null;
    }

    function renderFilmIntro(panel, data) {
        panel.textContent = '';
        if (!data) {
            panel.textContent = '7mmtv 未找到对应的影片介绍。';
            return;
        }
        if (data.text) {
            const text = document.createElement('div');
            text.className = 'mve-film-intro-text';
            text.textContent = data.text;
            panel.appendChild(text);
        }
        if (data.images.length) {
            const gallery = document.createElement('div');
            gallery.className = 'mve-film-intro-images';
            data.images.forEach((url) => {
                const img = document.createElement('img');
                img.src = url;
                img.alt = '影片介绍图片';
                img.loading = 'lazy';
                gallery.appendChild(img);
            });
            panel.appendChild(gallery);
        }
        if (data.url) {
            const source = document.createElement('a');
            source.href = data.url;
            source.target = '_blank';
            source.rel = 'noopener noreferrer';
            source.className = 'mve-film-intro-source';
            source.textContent = '来源：7mmtv.sx（' + (data.lang === 'zh' ? '中文' : '英文') + '详情）';
            panel.appendChild(source);
        }
    }

    function activateFilmIntroTab(tab, panel, tabList, contentRoot, detailPanel, detailRoot, detailState) {
        try {
            if (detailRoot && typeof Alpine !== 'undefined' && typeof Alpine.evaluate === 'function') {
                Alpine.evaluate(detailRoot, 'currentTab = "film_intro"');
            } else if (detailState) {
                detailState.currentTab = 'film_intro';
            }
        } catch { if (detailState) detailState.currentTab = 'film_intro'; }
        tabList.querySelectorAll('a,button,[role="tab"]').forEach((el) => {
            if (el !== tab) {
                el.setAttribute('aria-selected', 'false');
                el.classList.remove('active');
            }
        });
        tab.setAttribute('aria-selected', 'true');
        tab.classList.add('active');
        contentRoot.querySelectorAll('.tab-pane, [role="tabpanel"]').forEach((pane) => {
            if (pane !== panel) pane.classList.remove('active', 'show');
            if (pane !== panel) pane.hidden = true;
        });
        if (detailPanel && detailPanel !== panel) {
            detailPanel.hidden = true;
            detailPanel.classList.remove('active', 'show');
        }
        panel.hidden = false;
        panel.classList.add('active', 'show');
        if (filmIntroState.loading) return;
        const slug = missavDetailSlug();
        if (!slug || filmIntroState.cache[slug]) {
            if (slug) renderFilmIntro(panel, filmIntroState.cache[slug]);
            return;
        }
        filmIntroState.loading = true;
        panel.textContent = '正在读取 7mmtv 影片介绍…';
        load7mmtvIntro(slug).then((data) => renderFilmIntro(panel, data)).catch((e) => {
            panel.textContent = '影片介绍读取失败：' + ((e && e.message) || e);
        }).finally(() => { filmIntroState.loading = false; });
    }

    function ensureFilmIntroTab() {
        if (filmIntroState.installed || !missavDetailSlug()) return filmIntroState.installed;
        const candidates = [...document.querySelectorAll('a,button,[role="tab"]')].filter((el) => {
            const text = el.textContent.trim();
            return text === '详情' || /^详情\s*(页|信息)?$/.test(text) || /^details?$/i.test(text);
        });
        const original = candidates[0];
        if (!original) return false;
        const tabList = original.closest('[role="tablist"],ul,.nav-tabs,.tabs') || original.parentElement;
        const targetRef = original.getAttribute('data-bs-target') || original.getAttribute('data-target') ||
            (original.getAttribute('href') || '').split('?')[0];
        let detailPanel = null;
        if (targetRef && targetRef.charAt(0) === '#') {
            try { detailPanel = document.querySelector(targetRef); } catch { /* 忽略无效选择器 */ }
        }
        if (!detailPanel) detailPanel = document.querySelector('[x-show*="video_details"]');
        const detailRoot = [...document.querySelectorAll('[x-data]')].find((el) =>
            (el.getAttribute('x-data') || '').indexOf('currentTab') !== -1
        );
        let detailState = null;
        try {
            if (detailRoot && typeof Alpine !== 'undefined' && Alpine.closestDataStack) {
                detailState = (Alpine.closestDataStack(detailRoot) || [])[0] || null;
            }
        } catch { /* Alpine 尚未完全初始化时仍可用 DOM 兜底 */ }
        const contentRoot = document.querySelector('.tab-content') ||
            original.closest('section,main,article') || document.body;
        const panel = document.createElement('div');
        panel.id = 'mve-film-intro-panel';
        panel.className = 'tab-pane mve-film-intro-panel';
        panel.hidden = true;
        const item = original.closest('li');
        const tab = (item ? item.cloneNode(true) : original.cloneNode(true));
        tab.querySelectorAll ? tab.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id')) : null;
        tab.classList.remove('active', 'show');
        const tabControl = tab.matches && tab.matches('a,button,[role="tab"]') ? tab : tab.querySelector('a,button,[role="tab"]');
        if (!tabControl) return false;
        tabControl.classList.remove('active', 'show');
        ['data-toggle', 'data-bs-toggle', 'data-target', 'data-bs-target', 'aria-controls'].forEach((name) => tabControl.removeAttribute(name));
        ['@click', 'x-on:click', ':class', 'x-bind:class', 'aria-current'].forEach((name) => tabControl.removeAttribute(name));
        tabControl.classList.remove('border-red-400', 'text-red-400');
        tabControl.classList.add('border-transparent', 'text-gray-500', 'hover:text-nord4', 'hover:border-gray-400');
        tabControl.textContent = '影片介绍';
        tabControl.classList.add('mve-film-intro-tab');
        tabControl.setAttribute('href', '#mve-film-intro-panel');
        tabControl.setAttribute('role', 'tab');
        tabControl.setAttribute('aria-selected', 'false');
        tabControl.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            activateFilmIntroTab(tabControl, panel, tabList, contentRoot, detailPanel, detailRoot, detailState);
        });
        tabList.appendChild(tab);
        contentRoot.appendChild(panel);
        tabList.addEventListener('click', (event) => {
            if (!event.target.closest('.mve-film-intro-tab')) {
                panel.hidden = true;
                if (detailPanel) detailPanel.hidden = false;
            }
        });
        filmIntroState.installed = true;
        return true;
    }

    function initFilmIntroTab() {
        injectStyleOnce('mve-film-intro-style',
            '.mve-film-intro-panel{padding:12px 0;line-height:1.7;}' +
            '.mve-film-intro-text{white-space:pre-wrap;margin-bottom:16px;}' +
            '.mve-film-intro-images img{display:block;width:100%;height:auto;object-fit:contain;margin:0 auto 12px;}' +
            '.mve-film-intro-source{display:block;margin-top:16px;font-size:12px;opacity:.75;}');
        if (ensureFilmIntroTab()) return;
        const observer = new MutationObserver(() => {
            if (ensureFilmIntroTab()) observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => observer.disconnect(), 12000);
    }

    /* ================================================================
     * 模块九 ui-titles：列表页标题完整显示（Jable / MissAV）
     * Jable 卡片标题 h6.title、MissAV 卡片标题 .my-2.truncate 都用
     * 单行省略截断，长标题只能看到一半。放开换行即可全量展示：
     * 两站列表容器分别是 flex-wrap / grid，同一排各列默认 stretch
     * 自动等高——「标题全显示 + 每行高度一致」由布局天然保证。
     * （桌面若装有 MissAV Plus，其「完整标题」设置已做同样的事，
     *  本样式与其方向一致，叠加无副作用；手机端没有 Plus 时生效）
     * ================================================================ */

    /** 注入一次性样式（幂等：已注入过直接返回） */
    function injectStyleOnce(id, css) {
        if (document.getElementById(id)) return;
        const style = document.createElement('style');
        style.id = id;
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    function initJableUi() {
        injectStyleOnce('mve-jable-full-title',
            'h6.title{white-space:normal !important;overflow:visible !important;' +
            'text-overflow:clip !important;overflow-wrap:break-word;}');
    }

    function initMissavUi() {
        // .my-2.truncate 是卡片标题容器（含片单页网格化模块生成的同款结构）
        injectStyleOnce('mve-missav-full-title',
            '.my-2.truncate{white-space:normal !important;overflow:visible !important;' +
            'text-overflow:clip !important;overflow-wrap:break-word;}');
        initFilmIntroTab();
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
        // 动态新增的内容（Jable AJAX 翻页、无限滚动、MissAV Plus 重渲染等）
        // 直接重走完整标题链：各站流程内部都有「无网络工作即早退」，
        // 全部命中缓存的页面不会发出任何请求，按钮状态也不空闪
        enhanceTitles();
    }, 400);

    /**
     * 单模块容错执行：任何一个模块初始化失败都只记日志、跳过，
     * 绝不允许拖垮整个 init（真实教训：GetAV 的 UI 增强若在手机
     * 浏览器上因 DOM 差异抛错，排在它后面的设置按钮就建不出来）。
     * 失败记录进 initErrors，供兜底按钮展示（手机端看不到 console）。
     */
    const initErrors = [];
    function safe(name, fn) {
        try {
            fn();
        } catch (e) {
            const m = String((e && e.message) || e);
            initErrors.push(name + '：' + m);
            log('模块 ' + name + ' 初始化失败（已跳过，不影响其他功能）：', e);
        }
    }

    /** 兜底入口：正常面板构建失败时放一个极简按钮，点击弹出失败原因（手机端排查用） */
    function buildFallbackButton() {
        try {
            const b = document.createElement('button');
            b.textContent = '译!';
            b.style.cssText =
                'position:fixed;right:16px;bottom:76px;z-index:2147483647;width:40px;height:40px;' +
                'border-radius:50%;border:1px solid #ef4444;background:#1f2430;color:#ef4444;font-size:14px;';
            b.addEventListener('click', () => {
                const ver = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '?';
                alert('设置面板构建失败（v' + ver + '），请截图反馈：\n\n' +
                    (initErrors.length ? initErrors.join('\n') : '未捕获到具体错误') +
                    '\n\n站点：' + SITE + '\nbody：' + (document.body ? '存在' : '不存在'));
            });
            (document.body || document.documentElement).appendChild(b);
        } catch (e) { /* 连兜底都失败就只能放弃 */ }
    }

    /* ---------------- React 水合门控（GetAV 专用） ----------------
     * GetAV 现在是 React（Next.js）应用。React 水合时会把服务端 HTML 与客户端
     * 首次渲染逐节点比对：只要我们在水合完成前改过文本、插过节点（哪怕只是补全
     * 截断标题、注入一个「译」按钮），React 就判定不一致并抛 #418
     * 「Hydration failed…this tree will be regenerated on the client」，
     * 随后丢弃整棵服务端 DOM 重新渲染——注入的按钮/面板消失、标题改写被还原。
     * 所以 GetAV 上的一切 DOM 写入都推迟到水合完成之后。
     */

    const hydrationInfo = { checked: false, hydrated: false, waitedMs: 0, why: '' };

    /** React 接管 DOM 后会给真实节点挂 __reactFiber$ / __reactProps$ 内部属性（水合完成的可靠信号） */
    function hasReactFiber() {
        const root = document.body;
        if (!root) return false;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let n = 0;
        let el = root;
        // 前 300 个元素足够覆盖页头/首屏（React 水合会给所有真实节点挂 fiber）
        while (el && n++ < 300) {
            const keys = Object.keys(el);
            for (let i = 0; i < keys.length; i++) {
                if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactProps$') === 0) {
                    return true;
                }
            }
            el = walker.nextNode();
        }
        return false;
    }

    /**
     * 等 React 水合完成再执行（仅 GetAV 需要；其他站点不是 React，直接执行）。
     * 放行条件：检测到 fiber 属性 + 最近 300ms 页面无 childList 变动（避开水合后的
     * 首批数据渲染）；检测到后最多再等 1.5 秒，整体最多 8 秒兜底放行，避免非 React
     * 页面或异常页面被永久卡住。
     */
    function whenHydrated(cb) {
        if (SITE !== 'getav') { cb(); return; }
        const t0 = Date.now();
        let lastMutation = Date.now();
        let hydratedAt = 0;
        const mo = new MutationObserver(() => { lastMutation = Date.now(); });
        try {
            mo.observe(document.documentElement, { childList: true, subtree: true });
        } catch (e) { log('水合观察器启动失败：', e); }
        const finish = (why) => {
            mo.disconnect();
            hydrationInfo.checked = true;
            hydrationInfo.hydrated = !!hydratedAt;
            hydrationInfo.waitedMs = Date.now() - t0;
            hydrationInfo.why = why;
            log('水合门控放行（' + why + '），等待 ' + hydrationInfo.waitedMs + 'ms');
            cb();
        };
        const tick = () => {
            if (!hydratedAt && hasReactFiber()) hydratedAt = Date.now();
            const quiet = Date.now() - lastMutation >= 300;
            if (hydratedAt && (quiet || Date.now() - hydratedAt > 1500)) return finish('react');
            if (Date.now() - t0 > 8000) return finish(hydratedAt ? 'react-timeout' : 'no-react-timeout');
            setTimeout(tick, 100);
        };
        tick();
    }

    /** DOM 变化监听：兼容动态加载、MissAV Plus 标题重渲染、Jable AJAX 翻页、GetAV 客户端路由 */
    function startObserver() {
        new MutationObserver(() => {
            debouncedRelocate();
            debouncedReapplyTitles();
        }).observe(document.body, { childList: true, subtree: true });
    }

    /**
     * 标题链启动节奏：首屏 800ms 跑一次，2.5s / 6s 再补两次。
     * 首页（MissAV 推荐位、Jable 的 AJAX 分区等）内容比列表页晚到，只跑一次会漏；
     * 各站流程都有「无网络工作即早退」，全部命中缓存时补跑零请求、不闪按钮状态。
     */
    function scheduleTitleRuns() {
        if (!config.titlesEnabled) return;
        [800, 2500, 6000].forEach((ms) => setTimeout(() => safe('titles', enhanceTitles), ms));
        window.addEventListener('pageshow', () => safe('titles', enhanceTitles));
    }

    function init() {
        // 极端环境兜底：部分手机浏览器在 document-idle 时 body 尚未就绪，
        // appendChild 会抛错——等 body 出现再初始化（最多约 10 秒）
        if (!document.body) {
            waitFor(() => !!document.body, { interval: 200, tries: 50 }).then((ok) => {
                if (ok) init();
            });
            return;
        }
        // 菜单入口无 DOM 依赖，最先注册：水合门控/模块异常都不会让用户失去入口
        if (typeof GM_registerMenuCommand === 'function') {
            const menuLabel = { jable: 'Jable 标题增强设置', getav: 'GetAV 增强设置' }[SITE] || 'MissAV 综合增强设置';
            GM_registerMenuCommand(menuLabel, togglePanel);
        }
        // GetAV 是 React 应用：水合前任何 DOM 写入都会触发 #418 并被整棵重建，
        // 因此设置入口、界面增强、标题链、Observer 全部等水合完成后再启动
        if (SITE === 'getav') {
            whenHydrated(() => {
                safe('settings-ui', buildUI);
                if (!btn) buildFallbackButton(); // 面板没建出来 → 放兜底按钮报告原因
                safe('getav-ui', initGetavUi);
                scheduleTitleRuns();
                safe('observer', startObserver);
            });
            return;
        }
        // 设置入口最先建：后续任何模块失败都不丢用户入口
        safe('settings-ui', buildUI);
        if (!btn) buildFallbackButton(); // 面板没建出来 → 放兜底按钮报告原因
        // rescue / grid / dedup / preview 是 MissAV 专属（Jable/GetAV 无对应页面结构；
        // Jable 的预览行为未做适配测试，预览独占暂不开启）
        if (SITE === 'missav') {
            safe('rescue', rescueChallengePage);
            if (isPlaylistPage && config.gridEnabled) safe('grid', () => waitFor(applyGridLayout));
            if (config.dedupEnabled) safe('dedup', () => waitFor(dedup));
            if (config.previewExclusive) safe('preview', initPreviewExclusive);
            safe('missav-ui', initMissavUi);
        }
        if (SITE === 'jable') safe('jable-ui', initJableUi);
        scheduleTitleRuns();
        safe('observer', startObserver);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
