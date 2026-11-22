import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'missav-enhancer.user.js'), 'utf8');

function extractFunction(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    if (from < 0 || to < 0) throw new Error(`无法提取测试目标：${start}`);
    return source.slice(from, to);
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
    console.log('ok', message);
}

const snippet = extractFunction('    function collectJableCards()', '    /** 封面左上角加「字幕」标识');
const makeCollector = new Function(
    'document', 'slugFromHref', 'collectAnchorsBySlug', 'jableDetailSlug',
    `${snippet}; return collectJableCards;`
);

function anchor(href, text) {
    return {
        href,
        textContent: text,
        closest: () => ({ kind: 'cover' }),
    };
}

{
    const detail = { textContent: 'MIAA-711 原始繁中标题' };
    const related = anchor('https://jable.tv/s0/videos/abp-123/', 'ABP-123 相关推荐');
    const document = {
        querySelectorAll: () => [related],
        querySelector: (selector) => selector === '.header-left > h4' ? detail : null,
    };
    const collect = makeCollector(
        document,
        (href) => href.split('/').filter(Boolean).pop().toLowerCase(),
        () => [],
        () => 'miaa-711'
    );
    const cards = collect();
    assert(cards.length === 2, 'Jable 详情标题与推荐卡片同时进入收集结果');
    assert(cards[0].slug === 'miaa-711' && cards[0].anchor === detail && cards[0].isDetail, 's0 详情页无链接 h4 作为当前番号标题');
    assert(cards[1].slug === 'abp-123', '推荐卡片处理保持不变');
}

{
    const wrong = { textContent: 'ABP-123 其他标题' };
    const document = {
        querySelectorAll: () => [],
        querySelector: () => wrong,
    };
    const collect = makeCollector(document, () => null, () => [], () => 'miaa-711');
    assert(collect().length === 0, '详情标题不含当前番号时拒绝误写');
}

{
    let queried = false;
    const document = {
        querySelectorAll: () => [],
        querySelector: () => { queried = true; return null; },
    };
    const collect = makeCollector(document, () => null, () => [], () => '');
    assert(collect().length === 0 && !queried, 'Jable 非详情页不查询主标题 h4');
}
