// ==UserScript==
// @name         MissAV 综合增强（翻页去重 + 标题修正 + 片单网格化）
// @namespace    https://missav.ws/
// @version      3.2.0
// @description  四合一：1) 翻页去重——列表翻页时服务端常在页边界返回重复影片，自动隐藏；2) 标题修正——默认抓取日文原版标题替换机翻中文，可选填入 Kimi(Moonshot) API Key 升级为大模型重译（演员名保留日文读音自然音译）；3) 片单网格化——播放列表页改造为分类页同款缩略图网格卡片；4) 预览独占——手机端点卡片看预览时，自动暂停上一个预览视频，同时只播一个
// @author       lingyuncrystal
// @license      MIT
// @icon         https://missav.ws/favicon.ico
// @match        https://missav.ws/*
// @match        https://missav.com/*
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
     * 模块五 titles：标题修正（日文原标题 / Kimi 大模型重译）
     * ================================================================ */

    const DEFAULTS = {
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

    const PROMPT_VERSION = 2; // 提示词版本：变更后旧 zh 译文作废

    let config = loadConfig();
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
                if (cache[k]) delete cache[k].zh;
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
                () => finish(reject, new Error('日文页加载超时（Cloudflare 验证未完成）')),
                30000
            );
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
                    if (Object.keys(map).length >= 3 || (own && map[own])) finish(resolve, map);
                }
            }, 600);
            f.src = url;
            (document.body || document.documentElement).appendChild(f);
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
        const prefs = [/^kimi-k2\.6/, /^kimi-k3/, /^kimi-latest/, /^kimi-k2/, /kimi/i];
        for (const re of prefs) {
            const hit = ids.find((id) => re.test(id));
            if (hit) return hit;
        }
        return ids[0] || null;
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

    function collectCards() {
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
        if (running) {
            rerunAfter = true;
            return;
        }
        const cards = collectCards().filter((c) => !c.hidden);
        if (!cards.length) return;

        applyCached(cards);
        const needJa = [...new Set(cards.map((c) => c.slug))].filter((s) => !cache[s] || !cache[s].ja);
        const needZh = config.mode === 'llm' && config.apiKey
            ? [...new Set(cards.map((c) => c.slug))].filter((s) => cache[s] && cache[s].ja && !cache[s].zh)
            : [];
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
                    cache[s].zh = zhArr[j];
                });
                saveCache(cache);
                applyCached(collectCards());
            }
        };
        try {
            if (needJa.length) {
                const isDetail = !!document.querySelector('h1') && !document.querySelector('.thumbnail');
                const jaMap = await fetchJaTitles(isDetail ? jaDetailUrl(needJa[0]) : jaListUrl(), isDetail);
                needJa.forEach((s) => {
                    if (jaMap[s]) cache[s] = Object.assign(cache[s] || {}, { ja: jaMap[s] });
                });
                saveCache(cache);
                applyCached(collectCards());
                // 先翻译列表页已覆盖的部分，用户尽早看到中文
                await translateTodo();
                // 各语言列表收录范围不同，日文列表页可能缺当前页的部分番号；
                // 缺口抓日文详情页补齐（两个并发，结果永久缓存，只补一次）
                if (!isDetail) {
                    const missing = needJa.filter((s) => !cache[s] || !cache[s].ja).slice(0, 8);
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
            let errText = String((e && e.message) || e);
            if (/404|Not found|not exist/i.test(errText)) {
                errText += '（模型不可用或已下线：已尝试自动切换可用模型，仍失败请在设置中手动修改模型名）';
            } else if (/401|Authentication|auth/i.test(errText)) {
                errText += '（API Key 无效，请检查设置）';
            } else if (/429|rate_limit/i.test(errText)) {
                errText += '（账号请求频率超限：已自动等待重试仍失败，请放慢翻页；你的 Moonshot 账户档位为 3 次/分钟，可在 platform.moonshot.cn 充值提升额度）';
            }
            lastError = errText;
            setButtonState('error', errText);
            if (panel && panel.style.display !== 'none') msg(errText);
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
            '<div style="font-weight:600;margin-bottom:10px">MissAV 综合增强设置</div>' +
            '<div style="margin-bottom:8px">' +
            '<label style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><input type="radio" name="mve-mode" id="mve-mode-ja" value="ja"> 日文原标题（无需 Key）</label>' +
            '<label style="display:flex;align-items:center;gap:6px"><input type="radio" name="mve-mode" id="mve-mode-llm" value="llm"> 大模型重译（需 Kimi Key）</label>' +
            '</div>' +
            '<label style="display:block;margin-bottom:6px">API 地址<br><input id="mve-base" style="width:100%;margin-top:2px;padding:5px;border-radius:6px;border:1px solid #4c566a;background:#2e3440;color:#eceff4"></label>' +
            '<label style="display:block;margin-bottom:6px">API Key<br><input id="mve-key" type="password" placeholder="sk-...（Moonshot/Kimi）" style="width:100%;margin-top:2px;padding:5px;border-radius:6px;border:1px solid #4c566a;background:#2e3440;color:#eceff4"></label>' +
            '<label style="display:block;margin-bottom:6px">模型<br><input id="mve-model" style="width:100%;margin-top:2px;padding:5px;border-radius:6px;border:1px solid #4c566a;background:#2e3440;color:#eceff4"></label>' +
            '<label style="display:flex;align-items:center;gap:6px;margin:8px 0"><input id="mve-enabled" type="checkbox"> 启用标题修正</label>' +
            '<label style="display:flex;align-items:center;gap:6px;margin:8px 0"><input id="mve-dedup" type="checkbox"> 启用翻页去重（改动后刷新页面生效）</label>' +
            '<label style="display:flex;align-items:center;gap:6px;margin:8px 0"><input id="mve-grid" type="checkbox"> 启用片单网格化（改动后刷新页面生效）</label>' +
            '<label style="display:flex;align-items:center;gap:6px;margin:8px 0"><input id="mve-preview" type="checkbox"> 预览独占：同时只播放一个预览视频（改动后刷新页面生效）</label>' +
            '<label style="display:flex;align-items:center;gap:6px;margin:8px 0"><input id="mve-showbtn" type="checkbox"> 显示右下角「译」按钮（隐藏后可用脚本菜单打开本设置）</label>' +
            '<div style="display:flex;gap:8px;margin-top:8px">' +
            '<button id="mve-save" style="flex:1;padding:6px;border:none;border-radius:6px;background:#3b7cd7;color:#fff;cursor:pointer">保存并应用</button>' +
            '<button id="mve-clear" style="padding:6px 10px;border:1px solid #4c566a;border-radius:6px;background:transparent;color:#d7dee9;cursor:pointer">清缓存</button>' +
            '</div>' +
            '<div id="mve-msg" style="margin-top:8px;font-size:12px;color:#9db8dd;min-height:14px"></div>';
        document.body.appendChild(panel);

        panel.querySelector('#mve-save').addEventListener('click', () => {
            config = {
                baseUrl: panel.querySelector('#mve-base').value.trim() || DEFAULTS.baseUrl,
                apiKey: panel.querySelector('#mve-key').value.trim(),
                model: panel.querySelector('#mve-model').value.trim() || DEFAULTS.model,
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
    }

    function msg(t) {
        const el = panel && panel.querySelector('#mve-msg');
        if (el) el.textContent = t;
    }

    function togglePanel() {
        if (!panel) return;
        const show = panel.style.display === 'none';
        panel.style.display = show ? 'block' : 'none';
        if (show) {
            panel.querySelector('#mve-base').value = config.baseUrl;
            panel.querySelector('#mve-key').value = config.apiKey;
            panel.querySelector('#mve-model').value = config.model;
            panel.querySelector(config.mode === 'llm' ? '#mve-mode-llm' : '#mve-mode-ja').checked = true;
            panel.querySelector('#mve-enabled').checked = config.titlesEnabled;
            panel.querySelector('#mve-dedup').checked = config.dedupEnabled;
            panel.querySelector('#mve-grid').checked = config.gridEnabled;
            panel.querySelector('#mve-preview').checked = config.previewExclusive;
            panel.querySelector('#mve-showbtn').checked = config.showButton;
            if (lastError) msg('上次出错：' + lastError);
            else msg(config.mode === 'llm' && !config.apiKey ? '重译模式需填 Kimi(Moonshot) API Key' : '');
        }
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
        if (config.titlesEnabled) applyCached(collectCards());
    }, 400);

    function init() {
        rescueChallengePage();
        if (isPlaylistPage && config.gridEnabled) waitFor(applyGridLayout);
        if (config.dedupEnabled) waitFor(dedup);
        if (config.previewExclusive) initPreviewExclusive();
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
            GM_registerMenuCommand('MissAV 综合增强设置', togglePanel);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
