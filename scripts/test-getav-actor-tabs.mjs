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

const routeSnippet = between('    function getavDetailSlug()', '    function isGetavActorProfileLink(');
const makeRoute = new Function('SITE', 'location', `${routeSnippet}; return getavDetailSlug;`);

{
    const location = { pathname: '/zh/videos/MIAA-711/' };
    const detailSlug = makeRoute('getav', location);
    assert(detailSlug() === 'miaa-711', 'GetAV 中文详情路由提取小写番号');
    location.pathname = '/videos/ABP-123';
    assert(detailSlug() === 'abp-123', 'GetAV 无语言前缀详情路由可识别');
    location.pathname = '/ja-jp/videos/SONE-604/';
    assert(detailSlug() === 'sone-604', 'GetAV 带地区语言前缀详情路由可识别');
    location.pathname = '/zh/stars/example';
    assert(detailSlug() === '', 'GetAV 非影片详情路由不安装双 Tab');
}

class MockElement {
    constructor({ text = '', href = '', parent = null, labels = [], semantic = null } = {}) {
        this.textContent = text;
        this.href = href;
        this.parentElement = parent;
        this.labels = labels;
        this.semantic = semantic;
    }

    matches(selector) {
        return selector.split(',').some((item) => ['main', 'body', 'html'].includes(item.trim()) && this.kind === item.trim());
    }

    querySelectorAll() { return this.labels; }

    closest() { return this.semantic; }
}

const locatorSnippet = between('    function isGetavActorProfileLink(', '    function restoreGetavActorContent()');
const makeLocator = new Function('document', 'location', `${locatorSnippet}; return findGetavActorCard;`);

{
    const card = new MockElement({ labels: [{ textContent: '演员：' }] });
    const inner = new MockElement({ parent: card });
    const link = new MockElement({ href: 'https://getav.net/zh/stars/yua-mikami', parent: inner });
    const document = { querySelectorAll: () => [link] };
    assert(makeLocator(document, { origin: 'https://getav.net' })() === card, '按演员标签与明星资料链接定位原演员卡片');
}

{
    const cardA = new MockElement({ labels: [{ textContent: '演员' }] });
    const cardB = new MockElement({ labels: [{ textContent: 'Cast' }] });
    const links = [
        new MockElement({ href: '/zh/stars/a', parent: cardA }),
        new MockElement({ href: '/zh/stars/b', parent: cardB }),
    ];
    const document = { querySelectorAll: () => links };
    assert(makeLocator(document, { origin: 'https://getav.net' })() === null, '多个演员卡片候选歧义时拒绝误挂载');
}

{
    const card = new MockElement();
    const link = new MockElement({ href: '/zh/stars/a', semantic: card });
    const document = { querySelectorAll: () => [link] };
    assert(makeLocator(document, { origin: 'https://getav.net' })() === card, '无标签时接受唯一语义卡片作为保守回退');
}

const preloadSnippet = between('    function startGetavActorFilmPreload(', '    function ensureGetavActorTabs()');

{
    let instance = null;
    let loaded = 0;
    class MockIntersectionObserver {
        constructor(callback, options) {
            this.callback = callback;
            this.options = options;
            instance = this;
        }
        observe(node) { this.node = node; }
    }
    const state = { observer: null };
    const preload = new Function(
        'IntersectionObserver', 'loadGetavActorFilmIntro', 'getavActorTabsState',
        `${preloadSnippet}; return startGetavActorFilmPreload;`
    )(MockIntersectionObserver, () => { loaded++; }, state);
    const card = {};
    const panel = {};
    preload(card, panel, 'miaa-711');
    assert(loaded === 0, '演员卡片未接近视口前不请求影片介绍');
    assert(instance.node === card && instance.options.rootMargin === '300px 0px', '演员卡片提前 300px 触发预载');
    instance.callback([{ isIntersecting: true }]);
    assert(loaded === 1 && state.observer === instance, '进入观察范围后使用当前面板和番号加载');
}

const ensureSnippet = between('    function ensureGetavActorTabs()', '    /* ================================================================\n     * 模块八 film-intro');
assert(ensureSnippet.includes('const originalChildren = [...card.children]'), '挂载前记录原演员内容节点');
assert(!ensureSnippet.includes('cloneNode('), '演员卡片原内容不复制、不搬动');
assert(ensureSnippet.includes("profileTab.textContent = '简介'") && ensureSnippet.includes("filmTab.textContent = '影片介绍'"), '创建简介与影片介绍两个 Tab');
assert(ensureSnippet.includes("profileTab.setAttribute('aria-selected', 'true')"), '默认选中简介 Tab');
assert(ensureSnippet.includes('startGetavActorFilmPreload(card, panel, slug)'), '挂载后立即启动临近视口预载');

const switchSnippet = between('    function setGetavActorTab(', '    async function loadGetavActorFilmIntro(');
assert(switchSnippet.includes("node.style.setProperty('display', 'none', 'important')"), '影片介绍 Tab 只隐藏原演员节点');
assert(switchSnippet.includes("node.style.removeProperty('display')"), '返回简介 Tab 时恢复原演员节点显示');

console.log('GetAV 演员卡片双 Tab 夹具全部通过');
