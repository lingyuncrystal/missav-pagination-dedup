// ==UserScript==
// @name         MissAV 列表增强（翻页去重 + 标题重译）
// @namespace    https://missav.ws/
// @version      2.0.5
// @description  两个功能合一：1) 翻页去重——列表翻页时服务端常在页边界返回重复影片，自动隐藏；2) 标题修正——默认抓取日文原版标题替换机翻中文，可选填入 Kimi(Moonshot) API Key 升级为大模型重译（演员名保留日文原文）
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
     * 模块一：翻页去重（列表页码边界重叠的影片自动隐藏）
     * ================================================================ */

    const DEDUP_STORE_KEY = 'missav-dedup-v1';

    function currentPage() {
        const p = parseInt(new URL(location.href).searchParams.get('page') || '1', 10);
        return Number.isFinite(p) && p > 0 ? p : 1;
    }

    function listKey() {
        const u = new URL(location.href);
        u.searchParams.delete('page');
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

    function slugOf(card) {
        const a = card.querySelector('a[href]');
        if (!a) return null;
        try {
            const seg = new URL(a.href, location.origin).pathname.split('/').filter(Boolean);
            return (seg[seg.length - 1] || '').toLowerCase() || null;
        } catch {
            return null;
        }
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
        const grid = [...document.querySelectorAll('div.grid')].find((e) =>
            e.className.includes('xl:grid-cols-4')
        );
        if (!hasPagination || !grid) return false;
        if (grid.dataset.deduped === '1') return true;

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

        grid.dataset.deduped = '1';
        return true;
    }

    /* ================================================================
     * 模块二：标题修正（日文原标题 / Kimi 大模型重译）
     * ================================================================ */

    const DEFAULTS = {
        baseUrl: 'https://api.moonshot.cn/v1',
        apiKey: '',
        model: 'kimi-k2.6',
        mode: 'ja', // 'ja' = 日文原标题（无需 Key）；'llm' = 大模型重译（需 Key）
        showButton: true, // 右下角浮动「译」按钮
        titlesEnabled: true,
    };

    const hasGM = typeof GM_setValue === 'function' && typeof GM_getValue === 'function';

    function loadConfig() {
        try {
            const raw = hasGM ? GM_getValue('config', null) : localStorage.getItem('mve-config');
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

    let config = loadConfig();
    // moonshot-v1 系列与 kimi-k2.5 已于 2026-08-31 全平台下线（404），自动迁移
    if (/^moonshot-v1-/.test(config.model) || config.model === 'kimi-k2.5') {
        config.model = DEFAULTS.model;
        saveConfig(config);
    }
    let cache = loadCache(); // slug -> { ja, zh? }

    function slugFromHref(href) {
        try {
            const seg = new URL(href, location.origin).pathname.split('/').filter(Boolean);
            return (seg[seg.length - 1] || '').toLowerCase() || null;
        } catch {
            return null;
        }
    }

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

    function chatCompletion(messages, useJsonFormat) {
        const url = config.baseUrl.replace(/\/+$/, '') + '/chat/completions';
        const body = {
            model: config.model,
            messages,
            // 不传 temperature：kimi 新一代模型（k2.5 等）只允许 temperature=1，传 0.3 会报 400
        };
        if (useJsonFormat) body.response_format = { type: 'json_object' };
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
            '规则：1) 番号（如 MADV-646）原样保留；2) 演员名字保留日文原文，不要翻译或音译；' +
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
                        // 部分模型/网关不支持 response_format，去掉重试
                        text = await chatCompletion(messages, false);
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
                            console.warn('[MissAV 列表增强] 模型 ' + config.model + ' 不可用，自动切换为 ' + m);
                            config.model = m;
                            saveConfig(config);
                            continue;
                        }
                    } catch (e2) {
                        console.warn('[MissAV 列表增强] 模型自动发现失败', e2);
                    }
                }
                if (e.status === 429 && attempt < 3) {
                    const m = /after (\d+) second/i.exec(e.message || '');
                    const waitSec = (m ? parseInt(m[1], 10) : 20) + 2;
                    console.warn('[MissAV 列表增强] 触发限流，' + waitSec + ' 秒后重试（第 ' + (attempt + 1) + ' 次）');
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
        try {
            if (needJa.length) {
                const isDetail = !!document.querySelector('h1') && !document.querySelector('.thumbnail');
                const jaMap = await fetchJaTitles(isDetail ? jaDetailUrl(needJa[0]) : jaListUrl(), isDetail);
                needJa.forEach((s) => {
                    if (jaMap[s]) cache[s] = Object.assign(cache[s] || {}, { ja: jaMap[s] });
                });
                saveCache(cache);
                applyCached(collectCards());
                // 各语言列表收录范围不同，日文列表页可能缺当前页的部分番号；
                // 缺口逐个抓日文详情页补齐（结果永久缓存，只补一次）
                if (!isDetail) {
                    const missing = needJa.filter((s) => !cache[s] || !cache[s].ja);
                    for (const s of missing.slice(0, 8)) {
                        try {
                            const m = await fetchJaTitles(jaDetailUrl(s), true);
                            if (m[s]) {
                                cache[s] = Object.assign(cache[s] || {}, { ja: m[s] });
                                saveCache(cache);
                                applyCached(collectCards());
                            }
                        } catch (e) {
                            console.warn('[MissAV 列表增强] 详情页补抓失败 ' + s, e);
                        }
                    }
                }
            }
            if (config.mode === 'llm' && config.apiKey) {
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
            }
            lastError = null;
            setButtonState('done');
        } catch (e) {
            console.warn('[MissAV 列表增强]', e);
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

    /* ---------------- 设置面板 ---------------- */

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
            '<div style="font-weight:600;margin-bottom:10px">标题修正设置</div>' +
            '<div style="margin-bottom:8px">' +
            '<label style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><input type="radio" name="mve-mode" id="mve-mode-ja" value="ja"> 日文原标题（无需 Key）</label>' +
            '<label style="display:flex;align-items:center;gap:6px"><input type="radio" name="mve-mode" id="mve-mode-llm" value="llm"> 大模型重译（需 Kimi Key）</label>' +
            '</div>' +
            '<label style="display:block;margin-bottom:6px">API 地址<br><input id="mve-base" style="width:100%;margin-top:2px;padding:5px;border-radius:6px;border:1px solid #4c566a;background:#2e3440;color:#eceff4"></label>' +
            '<label style="display:block;margin-bottom:6px">API Key<br><input id="mve-key" type="password" placeholder="sk-...（Moonshot/Kimi）" style="width:100%;margin-top:2px;padding:5px;border-radius:6px;border:1px solid #4c566a;background:#2e3440;color:#eceff4"></label>' +
            '<label style="display:block;margin-bottom:6px">模型<br><input id="mve-model" style="width:100%;margin-top:2px;padding:5px;border-radius:6px;border:1px solid #4c566a;background:#2e3440;color:#eceff4"></label>' +
            '<label style="display:flex;align-items:center;gap:6px;margin:8px 0"><input id="mve-enabled" type="checkbox"> 启用标题修正</label>' +
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
            panel.querySelector('#mve-showbtn').checked = config.showButton;
            if (lastError) msg('上次出错：' + lastError);
            else msg(config.mode === 'llm' && !config.apiKey ? '重译模式需填 Kimi(Moonshot) API Key' : '');
        }
    }

    /* ================================================================
     * 启动与监听：先去重，再修正标题；DOM 变化时防抖回写缓存
     * ================================================================ */

    let scheduled = false;
    function scheduleRun() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
            scheduled = false;
            if (config.titlesEnabled) applyCached(collectCards());
        }, 400);
    }

    function init() {
        let tries = 0;
        const timer = setInterval(() => {
            if (dedup() || ++tries > 20) clearInterval(timer);
        }, 300);
        buildUI();
        if (config.titlesEnabled) {
            // 等去重和首屏渲染稳定后再处理标题
            setTimeout(enhanceTitles, 800);
        }
        // 兼容动态加载与 MissAV Plus 的标题重渲染：缓存命中即回写
        new MutationObserver(scheduleRun).observe(document.body, { childList: true, subtree: true });
        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('标题修正设置', togglePanel);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
