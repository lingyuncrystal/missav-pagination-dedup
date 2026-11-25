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

const parserSnippet = between('    function parseGetavSeriesMeta(html)', '    async function fetchGetavSeriesMeta');
const parse = new Function('DOMParser', 'HAN_RE', `${parserSnippet}; return parseGetavSeriesMeta;`);

class MockNode {
    constructor(text) { this.textContent = text; }
}
class MockDocument {
    constructor(h1) { this.h1 = h1; }
    querySelector(selector) { return selector === 'h1' ? this.h1 : null; }
    querySelectorAll() { return []; }
}
class MockDOMParser {
    parseFromString(html) { return new MockDocument(new MockNode(String(html).replace(/<[^>]+>/g, ''))); }
}
const parseName = parse(MockDOMParser, /[一-鿿]/);
assert(parseName('<h1>制服系列</h1>')?.name === '制服系列', '系列详情 h1 读取中文名称');
assert(parseName('<h1>制服系列</h1>')?.image === '', '系列详情没有图片时保持空图片');
assert(parseName('<h1>Series 123</h1>') === null, '没有中文名时不误写系列卡片');

const collectSnippet = between('    function collectGetavSubscriptionCards()', '    let getavSeriesRunning');
const collect = new Function('SITE', 'location', 'document', 'getComputedStyle',
    `function isGetavSubscriptionsPage() { return SITE === 'getav' && /\\/profile\\/subscriptions/.test(location.pathname); }\n${collectSnippet}; return collectGetavSubscriptionCards;`);
const card = { querySelector: () => null, closest: () => card };
const anchor = { href: 'https://getav.net/zh/series/440', querySelector: () => ({ textContent: '制服 Series' }), closest: () => card };
const document = { querySelectorAll: () => [anchor] };
const cards = collect('getav', { pathname: '/zh/profile/subscriptions', origin: 'https://getav.net' }, document, () => ({ display: 'block' }))();
assert(cards.length === 1 && cards[0].id === '440' && cards[0].name.textContent === '制服 Series', '订阅卡片提取系列详情 id 与名称节点');

console.log('GetAV 订阅页中文演员名夹具全部通过');
