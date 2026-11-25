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

function makeDocument(hrefs) {
    return { querySelectorAll: (selector) => selector === 'a[href*="/videos/"]' ? hrefs.map((href) => new MockAnchor(href)) : [] };
}

const routeSnippet = between('    function getavListRouteInfo()', '    /** 只取去重后的前几部番号');
const makeRoute = new Function('SITE', 'location', 'URLSearchParams', `${routeSnippet}; return getavListRouteInfo;`);

{
    const route = makeRoute('getav', {
        origin: 'https://getav.net', pathname: '/zh/new-releases', search: '?sort=releaseDate&page=3',
    }, URLSearchParams);
    const info = route();
    assert(info.path === '/new-releases' && info.page === 3 && info.sort === 'releaseDate', '识别带语言前缀的 GetAV 第 3 页列表路由');
    assert(info.key === 'https://getav.net/new-releases?sort=releaseDate&page=3', '快照键包含排序和页码');
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
    assert(info.key === 'https://getav.net/stars/1476?sort=&page=2', '演员作品分页快照键保留详情 id 与页码');
}

{
    const route = makeRoute('getav', { origin: 'https://getav.net', pathname: '/zh/videos/miaa-711', search: '' }, URLSearchParams);
    assert(route() === null, '详情页不触发列表恢复');
}

const signatureSnippet = between('    /** 只取去重后的前几部番号', '    function readGetavListSnapshot');
const makeSignature = new Function('document', 'location', 'URL', `${signatureSnippet}; return getavVisibleListSignature;`);
{
    const signature = makeSignature(makeDocument([
        'https://getav.net/zh/videos/fns-279',
        'https://getav.net/zh/videos/fns-279',
        'https://getav.net/zh/videos/jimmy-016',
    ]), { origin: 'https://getav.net' }, URL);
    assert(signature() === 'fns-279|jimmy-016', '列表快照去重影片链接并保留首屏顺序');
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
        `const getavListRecoveryState = { installed: false, reloadScheduled: false };\n${recoverySnippet}; return { recoverGetavListAfterBack, captureGetavListSnapshot };`
    )('getav', location, document, URL, URLSearchParams, sessionStorage, Date, (fn) => fn(), () => {});
    stored = JSON.stringify({ page: 3, sort: 'releaseDate', signature: 'dldss-578|dldss-572', at: Date.now() });
    assert(recover.recoverGetavListAfterBack() === true && reloads === 1, '第 3 页 URL 配第 1 页内容时触发重新加载');
}

console.log('GetAV 列表返回恢复夹具全部通过');
