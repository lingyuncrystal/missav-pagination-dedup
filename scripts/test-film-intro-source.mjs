import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'missav-enhancer.user.js'), 'utf8');

function between(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    if (from < 0 || to < 0) throw new Error(`无法提取测试目标：${start}`);
    return source.slice(from, to);
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
    console.log('ok', message);
}

/** 把真实脚本里的影片介绍数据层整段抽出来，注入 httpGet / httpPost / DOMParser 后单独运行 */
const snippet = between('    const NETFLAV_ORIGIN', '    function renderFilmIntro(');
/** 版本后缀剥离在 utils 模块，数据层依赖它，一并从真实脚本抽取 */
const baseSnippet = between('    function baseCodeFromSlug(', '    /** 从链接（或当前 URL）提取番号 slug');

/** 极简 DOM 桩：按真实选择器从 HTML 串里取值，覆盖 netflav DOM 兜底与 7mmtv 详情结构 */
function makeDomParser(html) {
    const text = String(html || '');
    const pick = (re) => {
        const m = re.exec(text);
        return m ? { textContent: m[1].replace(/<[^>]+>/g, '').trim() } : null;
    };
    const pickClass = (cls) => pick(new RegExp(`class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)</div>`));
    const images = [];
    const gallery = /id=['"]fullvideo_showallcg['"]([\s\S]*?)<\/span>/i.exec(text);
    if (gallery) {
        const imgRe = /<img[^>]*>/gi;
        let tag;
        while ((tag = imgRe.exec(gallery[1]))) {
            const src = /data-src="([^"]+)"/i.exec(tag[0]) || /src="([^"]+)"/i.exec(tag[0]);
            if (src) images.push({ getAttribute: (name) => (name === 'data-src' || name === 'src' ? src[1] : null) });
        }
    }
    const scripts = [];
    const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let scriptTag;
    while ((scriptTag = scriptRe.exec(text))) scripts.push({ textContent: scriptTag[1] });
    const anchors = [];
    const anchorRe = /<a[^>]+href="([^"]+)"[^>]*>/gi;
    let anchorTag;
    while ((anchorTag = anchorRe.exec(text))) anchors.push({ href: anchorTag[1] });
    const doc = {
        querySelector(selector) {
            if (selector === '.fullvideo-title, h1') return pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
            if (selector === '.video-introduction-images-text') return pickClass('video-introduction-images-text');
            if (selector === '.videocoverheader_code') return pickClass('videocoverheader_code');
            if (selector === '.videocoverheader_description') return pickClass('videocoverheader_description');
            return null;
        },
        querySelectorAll(selector) {
            if (selector === '#fullvideo_showallcg img') return images;
            if (selector === 'script') return scripts;
            if (selector === 'a[href]') return anchors;
            return [];
        },
    };
    return doc;
}

function loadSource({ httpGet, httpPost, domParser } = {}) {
    return new Function(
        'httpGet', 'httpPost', 'DOMParser', 'URL', 'filmIntroState',
        `${baseSnippet}
        ${snippet}
        return { normalizeFilmCode, baseCodeFromSlug, parseNetflavState, searchNetflavVideoId, parseNetflavIntro,
                 fetchNetflavIntro, parse7mmtvIntro, fetch7mmtvIntro, fetch7mmtvFilmIntro, fetchFilmIntro, loadFilmIntro };`
    )(
        httpGet || (async () => ({ status: 200, text: '' })),
        httpPost || (async () => ({ status: 200, text: '' })),
        domParser || class { parseFromString(html) { return makeDomParser(html); } },
        URL,
        { cache: {} }
    );
}

/** 拼一个带 __NEXT_DATA__ 的最小 netflav 页面 */
function page(state) {
    return `<html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(state)}</script></body></html>`;
}

function searchState(docs) {
    return { props: { initialState: { search: { docs, total: docs.length } } } };
}

function videoState(data) {
    return { props: { initialState: { video: { data } } } };
}

/** 7mmtv 搜索页（带一个指向详情页的链接）和详情页 */
function sevenSearchPage(slug, lang) {
    return `<html><body><a href="https://7mmtv.sx/${lang}/chinese_content/55828/${slug.toUpperCase()}.html">x</a></body></html>`;
}

function sevenDetailPage({ slug, text, images = [] }) {
    return `<html><body>
        <h1>[無碼破解]${slug.toUpperCase()} 标题</h1>
        <article class="mb-4">${text ? `<div class="video-introduction-images-text"><p>${text}</p></div>` : ''}</article>
        <span id='fullvideo_showallcg'>${images.map((u) => `<img class="lazyload" data-src="${u}" >`).join('')}</span>
        <script>var fullvideo_showallcg_arr = [];</script>
    </body></html>`;
}

// ---------- 番号归一化 ----------
{
    const { normalizeFilmCode } = loadSource();
    assert(normalizeFilmCode('SONE-604') === 'sone604', '番号归一化忽略大小写与连字符');
    assert(normalizeFilmCode(' sone-604 ') === 'sone604', '番号归一化忽略首尾空格');
    assert(normalizeFilmCode('FC2-PPV-1234567') === normalizeFilmCode('fc2_ppv_1234567'), '番号归一化同时忽略下划线');
    assert(normalizeFilmCode('FC2-PPV 4507566') === normalizeFilmCode('fc2-ppv-4507566'), 'FC2 番号用空格也视为同一部片');
}

// ---------- 版本后缀剥离（与 slugFromHref 同一规则） ----------
{
    const { baseCodeFromSlug } = loadSource();
    assert(baseCodeFromSlug('ipzz-963-chinese-subtitle') === 'ipzz-963', '剥掉中文字幕后缀');
    assert(baseCodeFromSlug('sone-604-uncensored-leak') === 'sone-604', '剥掉无码流出后缀');
    assert(baseCodeFromSlug('jur-857') === 'jur-857', '标准番号不受影响');
}

// ---------- netflav 搜索：只认精确番号，模糊结果一律拒绝 ----------
{
    const docs = [
        { code: 'SONE-604', videoId: 'bnwYqWml4l', uCode: 'SONE-604-C' },
        { code: 'SONE-604', videoId: 'IQ493cPJTZ', uCode: 'SONE-604' },
    ];
    const { searchNetflavVideoId } = loadSource({
        httpGet: async () => ({ status: 200, text: page(searchState(docs)) }),
    });
    assert(await searchNetflavVideoId('sone-604') === 'bnwYqWml4l', 'netflav 搜索按 code 精确命中并取到 videoId');
}

{
    const docs = [{ code: 'ABP-113', videoId: 'NhS8YZHrgi' }, { code: 'ABP-143', videoId: 'uJPCkzgfgS' }];
    const { searchNetflavVideoId } = loadSource({
        httpGet: async () => ({ status: 200, text: page(searchState(docs)) }),
    });
    assert(await searchNetflavVideoId('abp-123') === '', 'netflav 模糊结果不含目标番号时返回空，不认错片');
}

{
    const { searchNetflavVideoId } = loadSource({
        httpGet: async () => ({ status: 503, text: '' }),
    });
    let error = null;
    try { await searchNetflavVideoId('sone-604'); } catch (e) { error = e; }
    assert(error && /HTTP 503/.test(error.message), 'netflav 搜索非 2xx 抛错，交由上层决定是否兜底');
}

// ---------- netflav 详情解析 ----------
{
    const { parseNetflavIntro } = loadSource();
    const html = page(videoState({
        code: 'SONE-604',
        description: '  一段影片介绍  ',
        previewImages: ['https://pics.dmm.co.jp/a-1.jpg', 'https://pics.dmm.co.jp/a-2.jpg', 'https://pics.dmm.co.jp/a-1.jpg'],
    }));
    const data = parseNetflavIntro(html, 'sone-604');
    assert(data && data.text === '一段影片介绍', 'netflav 简介取自 __NEXT_DATA__ 的 description 并去空白');
    assert(data.images.length === 2, 'netflav 介绍图片去重后保留两张');
}

{
    const { parseNetflavIntro } = loadSource();
    const html = page(videoState({ code: 'MIDE-081', description: '别的影片' }));
    assert(parseNetflavIntro(html, 'sone-604') === null, 'netflav 详情番号与目标不一致时拒绝解析');
}

{
    const { parseNetflavIntro } = loadSource();
    const html = '<html><body><div class="videocoverheader_code">番號: SONE-604</div>' +
        '<div class="videocoverheader_description"> DOM 里的介绍 </div></body></html>';
    const data = parseNetflavIntro(html, 'sone-604');
    assert(data && data.text === 'DOM 里的介绍', 'netflav 无 __NEXT_DATA__ 时退回 .videocoverheader_description');
}

// ---------- 7mmtv 解析 ----------
{
    const { parse7mmtvIntro } = loadSource();
    const html = sevenDetailPage({
        slug: 'mide-001',
        text: '7mmtv 的介绍',
        images: ['https://pics.dmm.co.jp/digital/video/mide00001/mide00001jp-1.jpg'],
    });
    const data = parse7mmtvIntro(html, 'mide-001');
    assert(data && data.text === '7mmtv 的介绍', '7mmtv 简介取自 .video-introduction-images-text');
    assert(data.images.length === 1, '7mmtv 图片取自 #fullvideo_showallcg');
}

{
    const { parse7mmtvIntro } = loadSource();
    const html = sevenDetailPage({ slug: 'abc-999', text: '别的影片' });
    assert(parse7mmtvIntro(html, 'mide-001') === null, '7mmtv 标题不含目标番号时拒绝解析');
}

// ---------- 主源命中：不请求 7mmtv ----------
{
    const calls = [];
    const searchHtml = page(searchState([{ code: 'JUR-857', videoId: 'gG5VrKud8H' }]));
    const detailHtml = page(videoState({
        code: 'JUR-857',
        description: '夫婦生活的崩潰',
        previewImages: ['https://pics.dmm.co.jp/jur-857-1.jpg'],
    }));
    const httpGet = async (url) => {
        calls.push(url);
        if (url.includes('/search?')) return { status: 200, text: searchHtml };
        if (url.includes('/video?id=')) return { status: 200, text: detailHtml };
        return { status: 404, text: '' };
    };
    const httpPost = async (url) => { calls.push('POST ' + url); return { status: 200, text: '' }; };
    const { loadFilmIntro } = loadSource({ httpGet, httpPost });
    const data = await loadFilmIntro('jur-857');
    assert(data && data.source === 'netflav' && data.text === '夫婦生活的崩潰', 'netflav 命中即返回并标记来源');
    assert(calls[1] === 'https://netflav.com/video?id=gG5VrKud8H', 'netflav 详情请求带 videoId');
    assert(!calls.some((c) => c.startsWith('POST')), 'netflav 命中时不请求 7mmtv');
    const again = await loadFilmIntro('jur-857');
    assert(again === data && calls.length === 2, '同一番号命中缓存，不再重复请求');
}

// ---------- netflav 未收录：回退 7mmtv ----------
{
    const calls = [];
    const httpGet = async (url) => {
        calls.push(url);
        if (url.includes('netflav.com/search')) return { status: 200, text: page(searchState([])) };
        if (url.includes('7mmtv.sx/zh/chinese_content/')) {
            return { status: 200, text: sevenDetailPage({
                slug: 'mide-001',
                text: '7mmtv 的中文介绍',
                images: ['https://pics.dmm.co.jp/digital/video/mide00001/mide00001jp-1.jpg'],
            }) };
        }
        return { status: 404, text: '' };
    };
    const httpPost = async (url) => {
        calls.push('POST ' + url);
        return { status: 200, text: sevenSearchPage('mide-001', 'zh') };
    };
    const { loadFilmIntro } = loadSource({ httpGet, httpPost });
    const data = await loadFilmIntro('mide-001');
    assert(data && data.source === '7mmtv' && data.lang === 'zh', 'netflav 未收录时回退 7mmtv 中文详情');
    assert(data.text === '7mmtv 的中文介绍' && data.images.length === 1, '7mmtv 兜底带回文字与图片');
    assert(calls.some((c) => c.includes('7mmtv.sx')), '兜底请求确实打到 7mmtv');
}

// ---------- 7mmtv 中文无结果：回退英文详情 ----------
{
    const posts = [];
    const httpPost = async (url) => {
        posts.push(url);
        if (url.includes('/zh/')) return { status: 200, text: '<html><body>没有结果</body></html>' };
        return { status: 200, text: sevenSearchPage('snis-001', 'en') };
    };
    const httpGet = async (url) => {
        if (url.includes('/en/')) return { status: 200, text: sevenDetailPage({ slug: 'snis-001', text: 'english intro' }) };
        return { status: 404, text: '' };
    };
    const { fetch7mmtvFilmIntro } = loadSource({ httpGet, httpPost });
    const data = await fetch7mmtvFilmIntro('snis-001');
    assert(data && data.lang === 'en' && data.text === 'english intro', '7mmtv 中文详情无结果时回退英文');
    assert(posts.length === 2, '7mmtv 中英文各只请求一次');
}

// ---------- 两源都未收录 ----------
{
    const httpGet = async (url) => {
        if (url.includes('netflav.com/search')) return { status: 200, text: page(searchState([])) };
        return { status: 404, text: '' };
    };
    const httpPost = async () => ({ status: 200, text: '<html><body>没有结果</body></html>' });
    const { loadFilmIntro } = loadSource({ httpGet, httpPost });
    assert(await loadFilmIntro('zzz-999') === null, '两源都未收录时返回 null（界面显示未找到）');
}

// ---------- 两源都失败：抛出合并后的错误 ----------
{
    const httpGet = async () => ({ status: 503, text: '' });
    const httpPost = async () => ({ status: 502, text: '' });
    const { loadFilmIntro } = loadSource({ httpGet, httpPost });
    let error = null;
    try { await loadFilmIntro('sone-604'); } catch (e) { error = e; }
    assert(error && /netflav 请求失败/.test(error.message) && /7mmtv 请求失败/.test(error.message),
        '两源都失败时错误信息同时包含 netflav 与 7mmtv 原因');
}

// ---------- 三站共用同一入口 + 双源元数据 ----------
{
    assert((source.match(/loadFilmIntro/g) || []).length === 4, 'loadFilmIntro 被定义一次、MissAV / Jable / GetAV 各调用一次');
    assert(/^\/\/ @connect\s+netflav\.com$/m.test(source), '元数据放行 netflav.com');
    assert(/^\/\/ @connect\s+7mmtv\.sx$/m.test(source), '元数据放行 7mmtv.sx（兜底源）');
    assert(/source:\s*'netflav'/.test(source) && /source:\s*'7mmtv'/.test(source), '两个来源都打上 source 标记供界面显示');
}
