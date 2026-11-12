// ==UserScript==
// @name         MissAV 翻页去重
// @namespace    https://missav.ws/
// @version      1.0.0
// @description  MissAV 列表页码翻页时，服务端常在页边界返回与前几页重复的影片；本脚本记住已看过的番号，自动隐藏重复卡片
// @author       lingyuncrystal
// @license      MIT
// @icon         https://missav.ws/favicon.ico
// @match        https://missav.ws/*
// @match        https://missav.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const STORE_KEY = 'missav-dedup-v1';
    const PAGE_SIZE_HINT = 'grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4';

    /** 当前页码（无 ?page= 参数视为第 1 页） */
    function currentPage() {
        const p = parseInt(new URL(location.href).searchParams.get('page') || '1', 10);
        return Number.isFinite(p) && p > 0 ? p : 1;
    }

    /** 列表身份：路径 + 除 page 外的查询参数（区分不同分类/筛选） */
    function listKey() {
        const u = new URL(location.href);
        u.searchParams.delete('page');
        return u.pathname + u.search;
    }

    function loadStore() {
        try {
            return JSON.parse(sessionStorage.getItem(STORE_KEY) || '{}');
        } catch {
            return {};
        }
    }

    function saveStore(store) {
        try {
            sessionStorage.setItem(STORE_KEY, JSON.stringify(store));
        } catch {
            /* 存储满时静默放弃，去重退化为当页无效 */
        }
    }

    /** 从卡片链接提取唯一 slug（如 /cn/madv-646 -> madv-646） */
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

    /** 在列表上方插入/更新提示条 */
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
        // 只处理带编号翻页的列表页
        const hasPagination = !!document.querySelector('a[href*="page="]');
        const grid = [...document.querySelectorAll('div.grid')].find((e) =>
            e.className.includes('xl:grid-cols-4')
        );
        if (!hasPagination || !grid) return false;
        if (grid.dataset.deduped === '1') return true;

        const page = currentPage();
        const store = loadStore();
        const listData = store[listKey()] || { pages: {} };

        // 之前页码出现过的 slug 集合（只向前去重，往回翻不受影响）
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
        saveStore(store);
        showNotice(grid, hidden);

        grid.dataset.deduped = '1';
        return true;
    }

    let tries = 0;
    const timer = setInterval(() => {
        if (dedup() || ++tries > 20) clearInterval(timer);
    }, 300);
})();
