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

/** 把真实脚本里的 netflav 数据层整段抽出来，注入 httpGet / DOMParser 后单独运行 */
const snippet = between('    const NETFLAV_ORIGIN', '    function renderFilmIntro(');
/** 版本后缀剥离在 utils 模块，数据层依赖它，一并从真实脚本抽取 */
const baseSnippet = between('    function baseCodeFromSlug(', '    /** 从链接（或当前 URL）提取番号 slug');

function loadSource({ httpGet, domParser } = {}) {
    return new Function(
        'httpGet', 'DOMParser', 'URL', 'filmIntroState',
        `${baseSnippet}
        ${snippet}
        return { normalizeFilmCode, baseCodeFromSlug, parseNetflavState, searchNetflavVideoId, parseNetflavIntro, fetchNetflavIntro, loadNetflavIntro };`
    )(
        httpGet || (async () => ({ status: 200, text: '' })),
        domParser || class { parseFromString() { return { querySelector: () => null }; } },
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

// ---------- 搜索：只认精确番号，模糊结果一律拒绝 ----------
{
    const docs = [
        { code: 'SONE-604', videoId: 'bnwYqWml4l', uCode: 'SONE-604-C' },
        { code: 'SONE-604', videoId: 'IQ493cPJTZ', uCode: 'SONE-604' },
    ];
    const { searchNetflavVideoId } = loadSource({
        httpGet: async () => ({ status: 200, text: page(searchState(docs)) }),
    });
    const id = await searchNetflavVideoId('sone-604');
    assert(id === 'bnwYqWml4l', '搜索按 code 精确命中并取到 videoId');
}

{
    const docs = [{ code: 'ABP-113', videoId: 'NhS8YZHrgi' }, { code: 'ABP-143', videoId: 'uJPCkzgfgS' }];
    const { searchNetflavVideoId } = loadSource({
        httpGet: async () => ({ status: 200, text: page(searchState(docs)) }),
    });
    assert(await searchNetflavVideoId('abp-123') === '', '模糊结果不含目标番号时返回空，不认错片');
}

{
    const docs = [{ code: 'SONE-604', videoId: 'gG5VrKud8H', uCode: 'SONE-604-C' }];
    const { searchNetflavVideoId } = loadSource({
        httpGet: async () => ({ status: 200, text: page(searchState(docs)) }),
    });
    assert(await searchNetflavVideoId('sone-604') !== '', '仅有中文字幕版记录时也能命中');
}

{
    const { searchNetflavVideoId } = loadSource({
        httpGet: async () => ({ status: 503, text: '' }),
    });
    let error = null;
    try { await searchNetflavVideoId('sone-604'); } catch (e) { error = e; }
    assert(error && /HTTP 503/.test(error.message), '搜索非 2xx 抛错，交由上层显示重试');
}

// ---------- 详情解析：__NEXT_DATA__ 优先 ----------
{
    const { parseNetflavIntro } = loadSource();
    const html = page(videoState({
        code: 'SONE-604',
        description: '  一段影片介绍  ',
        previewImages: ['https://pics.dmm.co.jp/a-1.jpg', 'https://pics.dmm.co.jp/a-2.jpg', 'https://pics.dmm.co.jp/a-1.jpg'],
    }));
    const data = parseNetflavIntro(html, 'sone-604');
    assert(data && data.text === '一段影片介绍', '简介取自 __NEXT_DATA__ 的 description 并去空白');
    assert(data.images.length === 2, '介绍图片去重后保留两张');
}

{
    const { parseNetflavIntro } = loadSource();
    const html = page(videoState({ code: 'SONE-604' }));
    assert(parseNetflavIntro(html, 'sone-604') === null, '无简介也无图片时返回 null');
}

{
    const { parseNetflavIntro } = loadSource();
    const html = page(videoState({ code: 'MIDE-081', description: '别的影片' }));
    assert(parseNetflavIntro(html, 'sone-604') === null, '详情页番号与目标番号不一致时拒绝解析');
}

// ---------- 详情解析：__NEXT_DATA__ 缺失时退回 DOM ----------
{
    const textNode = { textContent: '  DOM 里的介绍  ' };
    const codeNode = { textContent: '番號: SONE-604' };
    const domParser = class {
        parseFromString() {
            return {
                querySelector(selector) {
                    if (selector === '.videocoverheader_code') return codeNode;
                    if (selector === '.videocoverheader_description') return textNode;
                    return null;
                },
            };
        }
    };
    const { parseNetflavIntro } = loadSource({ domParser });
    const data = parseNetflavIntro('<html><body>no next data</body></html>', 'sone-604');
    assert(data && data.text === 'DOM 里的介绍', '无 __NEXT_DATA__ 时退回 .videocoverheader_description');
}

// ---------- 整条链路：搜索 → 详情 → 缓存 ----------
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
    const { loadNetflavIntro } = loadSource({ httpGet });
    const data = await loadNetflavIntro('jur-857');
    assert(data && data.text === '夫婦生活的崩潰' && data.images.length === 1, '搜索命中后取回简介与图片');
    assert(calls[0].includes('https://netflav.com/search?type=all&keyword=jur-857'), '搜索请求走 netflav 搜索页');
    assert(calls[1] === 'https://netflav.com/video?id=gG5VrKud8H', '详情请求带 videoId 走 netflav 详情页');
    const again = await loadNetflavIntro('jur-857');
    assert(again === data && calls.length === 2, '同一番号命中缓存，不再重复请求');
}

{
    // 带连字符写法 0 条时，自动改用紧凑写法再搜一次
    const calls = [];
    const httpGet = async (url) => {
        calls.push(url);
        if (url.includes('keyword=fc2-ppv-1234567')) return { status: 200, text: page(searchState([])) };
        if (url.includes('keyword=fc2ppv1234567')) {
            return { status: 200, text: page(searchState([{ code: 'FC2-PPV-1234567', videoId: 'abc123' }])) };
        }
        return { status: 200, text: page(videoState({ code: 'FC2-PPV-1234567', description: '素人作品' })) };
    };
    const { loadNetflavIntro } = loadSource({ httpGet });
    const data = await loadNetflavIntro('fc2-ppv-1234567');
    assert(data && data.text === '素人作品', '首次搜索落空时用紧凑写法补搜');
    assert(calls.length === 3, '补搜只多发一次搜索请求');
}

// ---------- 三站共用同一数据源 ----------
{
    assert((source.match(/loadNetflavIntro/g) || []).length === 4, 'loadNetflavIntro 被定义一次、MissAV / Jable / GetAV 各调用一次');
    assert(!/7mmtv/i.test(source), '脚本内已无 7mmtv 引用');
    assert(/^\/\/ @connect\s+netflav\.com$/m.test(source), '元数据 @connect 已放行 netflav.com');
}
