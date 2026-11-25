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

const parserSnippet = between('    function parseGetavStarName(html)', '    async function fetchGetavStarName');
const parse = new Function('DOMParser', 'HAN_RE', `${parserSnippet}; return parseGetavStarName;`);

class MockNode {
    constructor(text) { this.textContent = text; }
}
class MockDocument {
    constructor(h1) { this.h1 = h1; }
    querySelector(selector) { return selector === 'h1' ? this.h1 : null; }
}
class MockDOMParser {
    parseFromString(html) { return new MockDocument(new MockNode(String(html).replace(/<[^>]+>/g, ''))); }
}
const parseName = parse(MockDOMParser, /[一-鿿]/);
assert(parseName('<h1>三上悠亚女优</h1>') === '三上悠亚', '演员详情 h1 去掉女优后缀并保留中文名');
assert(parseName('<h1>三上悠亜男優</h1>') === '三上悠亜', '演员详情兼容男优后缀');
assert(parseName('<h1>Yua Mikami</h1>') === null, '没有中文名时不误写卡片');

const collectSnippet = between('    function collectGetavSubscriptionCards()', '    let getavStarRunning');
const collect = new Function('SITE', 'location', 'document', 'getComputedStyle',
    `function isGetavSubscriptionsPage() { return SITE === 'getav' && /\\/profile\\/subscriptions/.test(location.pathname); }\n${collectSnippet}; return collectGetavSubscriptionCards;`);
const card = {
    querySelector(selector) {
        if (selector === 'a[href*="/stars/"]') return { href: 'https://getav.net/zh/stars/440', querySelector: () => ({ textContent: '三上悠亜' }) };
        return null;
    },
};
const document = { querySelectorAll: () => [card] };
const cards = collect('getav', { pathname: '/zh/profile/subscriptions', origin: 'https://getav.net' }, document, () => ({ display: 'block' }))();
assert(cards.length === 1 && cards[0].id === '440' && cards[0].name.textContent === '三上悠亜', '订阅卡片提取数字演员详情 id 与名称节点');

console.log('GetAV 订阅页中文演员名夹具全部通过');
