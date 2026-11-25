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

assert(/\*:\/\/getav\.co\//.test(source) && /\*:\/\/getav\.live\//.test(source) &&
    /\*:\/\/getav\.top\//.test(source) && /\*:\/\/getav\.me\//.test(source),
    '用户脚本匹配 getav.co/live/top/me 域名');
assert(/getav\\\.\(\?:net\|co\|live\|top\|me\)/.test(source), '站点识别覆盖全部 GetAV 域名');
const seriesImageCss = between('        .mve-getav-series-image,', '        /* 名字容器');
assert(/object-position:\s*right center\s*!important/.test(seriesImageCss), '系列圆形封面优先显示原图右侧区域');
const touchEditCss = between('        /* 触屏设备没有 hover', '        /* ============ 订阅页：网格');
assert(/@media \(hover: none\), \(pointer: coarse\)/.test(touchEditCss) &&
    /li\.relative\.group > button\.absolute\.opacity-0/.test(touchEditCss) &&
    /opacity:\s*1\s*!important/.test(touchEditCss),
    '触屏设备常显普通收藏列表编辑按钮');

const parserSnippet = between('    function parseGetavSeriesMeta(html, fallbackName)', '    async function getavSeriesHttpGet');
const parse = new Function('DOMParser', 'HAN_RE', 'location', `${parserSnippet}; return parseGetavSeriesMeta;`);

class MockNode {
    constructor(text = '', attrs = {}) { this.textContent = text; this.attrs = attrs; }
    getAttribute(name) { return this.attrs[name] ?? null; }
}
class MockDocument {
    constructor(h1, meta = null, images = []) { this.h1 = h1; this.meta = meta; this.images = images; }
    querySelector(selector) {
        if (selector === 'h1') return this.h1;
        if (selector.startsWith('meta[')) return this.meta;
        return null;
    }
    querySelectorAll(selector) { return selector.startsWith('img[') ? this.images : []; }
}
function parseDoc(doc, fallbackName = '') {
    class Parser { parseFromString() { return doc; } }
    return parse(Parser, /[一-鿿]/, { origin: 'https://getav.net' })('<html></html>', fallbackName);
}
function parseName(html) {
    return parseDoc(new MockDocument(new MockNode(String(html).replace(/<[^>]+>/g, ''))));
}
assert(parseName('<h1>制服系列</h1>')?.name === '制服系列', '系列详情 h1 读取中文名称');
assert(parseName('<h1>制服系列</h1>')?.image === '', '系列详情没有图片时保持空图片');
assert(parseName('<h1>Series 123</h1>') === null, '没有中文名时不误写系列卡片');

const cover = 'https://static.worldstatic.com/images/cover/thumb/RBD-578_thumb.avif';
const currentDoc = new MockDocument(
    new MockNode('被锁链束缚的新娘系列'),
    new MockNode('', { content: 'https://getav.net/opengraph-image.png' }),
    [
        new MockNode('', { src: 'https://www.google.com/s2/favicons?domain=example.com&sz=64' }),
        new MockNode('', { src: cover }),
    ],
);
const currentMeta = parseDoc(currentDoc);
assert(currentMeta?.name === '被锁链束缚的新娘系列', '解析当前系列详情中文标题');
assert(currentMeta?.image === cover, '跳过通用 og 图和 favicon，选用详情作品封面');
const fallbackMeta = parseDoc(new MockDocument(null, null, [new MockNode('', { src: cover })]), '列表中文系列');
assert(fallbackMeta?.name === '列表中文系列' && fallbackMeta?.image === cover, '中文列表名可作为补图时的标题兜底');

const httpSnippet = between('    async function getavSeriesHttpGet(url)', '    async function fetchGetavSeriesMeta');
const makeHttpGet = new Function('fetch', 'httpGet', 'log', `${httpSnippet}; return getavSeriesHttpGet;`);
let fetchArgs = null;
const sameOriginGet = makeHttpGet(async (...args) => {
    fetchArgs = args;
    return { status: 200, text: async () => '<h1>中文系列</h1>' };
}, async () => { throw new Error('不应调用 GM_xhr'); }, () => {});
const sameOriginResponse = await sameOriginGet('https://getav.net/zh/series/abc');
assert(sameOriginResponse.status === 200 && sameOriginResponse.text.includes('中文系列'), '系列详情优先使用同源 fetch');
assert(fetchArgs[1]?.credentials === 'same-origin', '同源请求显式携带当前登录态');

const collectSnippet = between('    function collectGetavSubscriptionCards()', '    let getavSeriesRunning');
const collect = new Function('SITE', 'location', 'document', 'getComputedStyle',
    `function isGetavSubscriptionsPage() { return SITE === 'getav' && /\\/profile\\/subscriptions/.test(location.pathname); }\n${collectSnippet}; return collectGetavSubscriptionCards;`);
const card = { querySelector: () => null, closest: () => card };
const anchor = { href: 'https://getav.net/zh/series/440', querySelector: () => ({ textContent: '制服 Series' }), closest: () => card };
const document = { querySelectorAll: () => [anchor] };
const cards = collect('getav', { pathname: '/zh/profile/subscriptions', origin: 'https://getav.net' }, document, () => ({ display: 'block' }))();
assert(cards.length === 1 && cards[0].id === '440' && cards[0].name.textContent === '制服 Series', '订阅卡片提取系列详情 id 与名称节点');

const applyImageSnippet = between('    function applyGetavSeriesImage(card, image)', '    async function enhanceGetavSubscriptionNames');
const applyImage = new Function('document', `${applyImageSnippet}; return applyGetavSeriesImage;`);
const injected = [];
const placeholderStyles = [];
const placeholder = { style: { setProperty: (...args) => placeholderStyles.push(args) } };
const imageAnchor = {
    firstChild: {},
    querySelector(selector) {
        if (selector === 'img[data-mve-getav-series-image]') return injected[0] || null;
        if (selector === ':scope > div.rounded-full') return placeholder;
        return null;
    },
    insertBefore(img) { injected.push(img); },
};
const imageDocument = {
    createElement() {
        return {
            dataset: {},
            attrs: {},
            getAttribute(name) { return this.attrs[name] || null; },
            setAttribute(name, value) { this.attrs[name] = value; },
        };
    },
};
const imageCard = { anchor: imageAnchor, name: { textContent: '详情中文标题' } };
const applied = applyImage(imageDocument)(imageCard, cover);
assert(applied === true && injected.length === 1, '真实封面函数直接向卡片链接插入图片');
assert(injected[0].getAttribute('src') === cover && injected[0].alt === '详情中文标题', '真实封面函数写入图片地址和替代文本');
assert(placeholderStyles.some(([name, value]) => name === 'display' && value === 'none'), '真实封面函数隐藏原胶片图标占位');
applyImage(imageDocument)(imageCard, cover);
assert(injected.length === 1, '重复应用封面不会重复插入图片');

const enhanceSnippet = between('    async function enhanceGetavSubscriptionNames()', '    /** querySelectorAll 的补充');
const makeEnhance = new Function('config', 'isGetavSubscriptionsPage', 'collectGetavSubscriptionCards',
    'cache', 'getavSeriesCacheKey', 'setTextSafe', 'applyGetavSeriesImage', 'classifyTitle',
    'saveCache', 'fetchGetavSeriesMeta', 'document', 'GETAV_SERIES_IMAGE_MISS_TTL',
    `let getavSeriesRunning = false; let getavSeriesRerun = false;\n${enhanceSnippet}; return enhanceGetavSubscriptionNames;`);
const chineseCard = { id: 'abc', hidden: false, name: { textContent: '已经是中文' } };
const enhancedImages = [];
let detailFetches = 0;
const enhancedCache = {};
const enhance = makeEnhance({ titlesEnabled: true }, () => true, () => [chineseCard], enhancedCache,
    (id) => '@getav-series:' + id, (el, text) => { el.textContent = text; },
    (card, image) => enhancedImages.push([card.id, image]), () => 'cn', () => {},
    async (id) => {
        detailFetches++;
        const meta = { zh: '详情中文标题', image: cover };
        enhancedCache['@getav-series:' + id] = meta;
        return meta;
    }, { contains: () => true }, 24 * 3600 * 1000);
await enhance();
assert(detailFetches === 1, '列表已有中文标题时仍请求详情补封面');
assert(chineseCard.name.textContent === '详情中文标题' && enhancedImages[0]?.[1] === cover, '详情标题和封面同时回写卡片');

const tabSnippet = between('    const GETAV_SUBSCRIPTION_TAB_LABELS', '    function collectGetavSubscriptionCards()');
const makeTabs = new Function('location', 'history', 'document',
    `function isGetavSubscriptionsPage() { return /\\/profile\\/subscriptions/.test(location.pathname); }\n${tabSnippet}; return { getavSubscriptionTabKey, saveGetavSubscriptionTab, restoreGetavSubscriptionTab };`);
const tabLocation = { pathname: '/zh/profile/subscriptions', href: 'https://getav.net/zh/profile/subscriptions' };
const tabHistory = { state: { kept: true }, replaceState(state, unused, href) { this.state = state; tabLocation.href = href; } };
const actorButton = { textContent: '演员124', className: 'bg-white/[0.08]', clicks: 0, getAttribute: () => null, click() { this.clicks++; } };
const seriesButton = { textContent: '系列94', className: '', clicks: 0, getAttribute: () => null, click() { this.clicks++; } };
const tabs = makeTabs(tabLocation, tabHistory, { querySelectorAll: () => [actorButton, seriesButton] });
assert(tabs.getavSubscriptionTabKey(seriesButton) === 'series', '识别带数量的系列标签');
tabs.saveGetavSubscriptionTab('series');
assert(new URL(tabLocation.href).searchParams.get('tab') === 'series' && tabHistory.state.kept, '系列标签写入 URL 且保留路由历史状态');
tabs.restoreGetavSubscriptionTab();
assert(seriesButton.clicks === 1, '返回订阅页时恢复 URL 指定的系列标签');
tabs.saveGetavSubscriptionTab('actors');
assert(!new URL(tabLocation.href).searchParams.has('tab'), '默认演员标签不制造多余 URL 参数');

console.log('GetAV 订阅页中文标题、封面与标签恢复夹具全部通过');
