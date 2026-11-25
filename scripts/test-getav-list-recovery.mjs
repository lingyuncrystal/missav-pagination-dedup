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

class MockAnchor {
    constructor(href) { this.href = href; }
}

function makeDocument(hrefs, useMain = true) {
    return {
        querySelectorAll: (selector) => {
            if (selector === 'main a[href]') return useMain ? hrefs.map((href) => new MockAnchor(href)) : [];
            if (selector === 'a[href]') return hrefs.map((href) => new MockAnchor(href));
            return [];
        },
    };
}

const routeSnippet = between('    function getavListRouteInfo()', '    /** 实体首页只比较同类实体；实体详情和影片列表优先比较番号。 */');
const makeRoute = new Function('SITE', 'location', 'URLSearchParams', `${routeSnippet}; return getavListRouteInfo;`);

{
    const route = makeRoute('getav', {
        origin: 'https://getav.net', pathname: '/zh/new-releases', search: '?sort=releaseDate&page=3',
    }, URLSearchParams);
    const info = route();
    assert(info.path === '/new-releases' && info.page === 3 && info.sort === 'releaseDate', '识别带语言前缀的 GetAV 第 3 页列表路由');
    assert(info.key === 'https://getav.net/new-releases?page=3&sort=releaseDate', '快照键包含排序和页码');
}

{
    const route = makeRoute('getav', {
        origin: 'https://getav.net', pathname: '/zh/stars', search: '?page=3',
    }, URLSearchParams);
    const info = route();
    assert(info.path === '/stars' && info.page === 3, '演员列表页第 3 页纳入返回恢复');
}

{
    const route = makeRoute('getav', {
        origin: 'https://getav.net', pathname: '/zh/stars/1476', search: '?page=2',
    }, URLSearchParams);
    const info = route();
    assert(info.path === '/stars/1476' && info.page === 2, '演员作品详情第 2 页纳入返回恢复');
    assert(info.key === 'https://getav.net/stars/1476?page=2', '演员作品分页快照键保留详情 id 与页码');
}

for (const test of [
    { pathname: '/zh/series', search: '?page=3', path: '/series', page: 3, label: '系列总列表第 3 页纳入返回恢复' },
    { pathname: '/zh/series/abc123', search: '?page=2', path: '/series/abc123', page: 2, label: '系列作品列表分页纳入返回恢复' },
    { pathname: '/zh/makers', search: '', path: '/makers', page: 1, label: '片商首页提前保存列表快照' },
    { pathname: '/zh/labels/label-a', search: '?page=4', path: '/labels/label-a', page: 4, label: '发行商作品列表纳入返回恢复' },
    { pathname: '/zh/profile/favorites', search: '?page=2', path: '/profile/favorites', page: 2, label: '收藏分页纳入返回恢复' },
    { pathname: '/zh/custom-list', search: '?page=2', path: '/custom-list', page: 2, label: '其他带页码的非播放页自动按列表处理' },
]) {
    const route = makeRoute('getav', { origin: 'https://getav.net', ...test }, URLSearchParams);
    const info = route();
    assert(info?.path === test.path && info.page === test.page, test.label);
}

{
    const route = makeRoute('getav', {
        origin: 'https://getav.net', pathname: '/zh/search', search: '?q=abc&page=2&sort=releaseDate',
    }, URLSearchParams);
    assert(route().key === 'https://getav.net/search?page=2&q=abc&sort=releaseDate', '快照键保留搜索词与筛选条件');
}

{
    const route = makeRoute('getav', { origin: 'https://getav.net', pathname: '/zh/videos/miaa-711', search: '?page=2' }, URLSearchParams);
    assert(route() === null, '影片播放详情页不触发列表恢复');
    const nonList = makeRoute('getav', { origin: 'https://getav.net', pathname: '/zh/about', search: '' }, URLSearchParams);
    assert(nonList() === null, '无分页的普通页面不触发列表恢复');
}

const signatureSnippet = between('    /** 实体首页只比较同类实体；实体详情和影片列表优先比较番号。 */', '    function readGetavListSnapshot');
const makeSignature = new Function('document', 'location', 'URL', `${signatureSnippet}; return getavVisibleListSignature;`);
{
    const signature = makeSignature(makeDocument([
        'https://getav.net/zh/videos/fns-279',
        'https://getav.net/zh/videos/fns-279',
        'https://getav.net/zh/videos/jimmy-016',
    ]), { origin: 'https://getav.net' }, URL);
    assert(signature() === 'fns-279|jimmy-016', '列表快照去重影片链接并保留首屏顺序');
}
{
    const signature = makeSignature(makeDocument([
        'https://getav.net/zh/videos/representative-001',
        'https://getav.net/zh/series/77096fa21f804929',
        'https://getav.net/zh/series/77096fa21f804929',
        'https://getav.net/zh/series/c11a8d7599f765c1',
    ]), { origin: 'https://getav.net', pathname: '/zh/series' }, URL);
    assert(signature() === 'series:77096fa21f804929|series:c11a8d7599f765c1', '系列总列表忽略代表作影片链接并生成同类实体指纹');
}
{
    const signature = makeSignature(makeDocument([
        'https://getav.net/zh/stars/1476',
        'https://getav.net/zh/series/abc123',
        'https://getav.net/zh/videos/fns-279',
        'https://getav.net/zh/videos/jimmy-016',
    ]), { origin: 'https://getav.net' }, URL);
    assert(signature() === 'fns-279|jimmy-016', '作品列表存在演员等侧栏链接时仍优先使用影片指纹');
}
{
    const signature = makeSignature(makeDocument([
        'https://getav.net/zh/stars/1476',
        'https://getav.net/zh/stars/1488',
    ], false), { origin: 'https://getav.net' }, URL);
    assert(signature() === 'stars:1476|stars:1488', '旧版无 main 容器页面可回退到全文档链接');
}

const recoverySnippet = between('    function getavListRouteInfo()', '    function initGetavListRecovery');
{
    let stored = null;
    let reloads = 0;
    const location = { origin: 'https://getav.net', pathname: '/zh/new-releases', search: '?sort=releaseDate&page=3', reload: () => { reloads++; } };
    const document = makeDocument([
        'https://getav.net/zh/videos/fns-279',
        'https://getav.net/zh/videos/jimmy-016',
    ]);
    const sessionStorage = {
        getItem: () => stored,
        setItem: (_key, value) => { stored = value; },
    };
    const recover = new Function(
        'SITE', 'location', 'document', 'URL', 'URLSearchParams', 'sessionStorage', 'Date', 'setTimeout', 'log',
        `const getavListRecoveryState = { installed: false, reloadScheduled: false, pendingCheck: false, attempts: 0, timer: null };\n${recoverySnippet}; return { recoverGetavListAfterBack, captureGetavListSnapshot, getavListRecoveryState };`
    )('getav', location, document, URL, URLSearchParams, sessionStorage, Date, (fn) => fn(), () => {});
    stored = JSON.stringify({ page: 3, sort: 'releaseDate', signature: 'dldss-578|dldss-572', at: Date.now() });
    const originalSnapshot = stored;
    recover.getavListRecoveryState.pendingCheck = true;
    assert(recover.captureGetavListSnapshot() === false && stored === originalSnapshot, '返回校验完成前禁止错误内容覆盖原快照');
    assert(recover.recoverGetavListAfterBack() === true && reloads === 1, '第 3 页 URL 配第 1 页内容时触发重新加载');
}

{
    let stored = null;
    let reloads = 0;
    const location = { origin: 'https://getav.net', pathname: '/zh/series', search: '?page=3', reload: () => { reloads++; } };
    const document = makeDocument([
        'https://getav.net/zh/series/page-one-a',
        'https://getav.net/zh/series/page-one-b',
    ]);
    const sessionStorage = {
        getItem: () => stored,
        setItem: (_key, value) => { stored = value; },
    };
    const recover = new Function(
        'SITE', 'location', 'document', 'URL', 'URLSearchParams', 'sessionStorage', 'Date', 'setTimeout', 'log',
        `const getavListRecoveryState = { installed: false, reloadScheduled: false, pendingCheck: true, attempts: 0, timer: null };\n${recoverySnippet}; return recoverGetavListAfterBack;`
    )('getav', location, document, URL, URLSearchParams, sessionStorage, Date, (fn) => fn(), () => {});
    stored = JSON.stringify({ page: 3, sort: '', signature: 'series:page-three-a|series:page-three-b', at: Date.now() });
    assert(recover() === true && reloads === 1, '系列第 3 页返回成第 1 页内容时同样触发恢复');
}

console.log('GetAV 列表返回恢复夹具全部通过');
