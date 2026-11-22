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

class MockElement {
    constructor({ text = '', href = '', parent = null } = {}) {
        this.textContent = text;
        this.href = href;
        this.parentElement = parent;
        this.inserted = [];
    }

    contains(node) {
        for (let current = node; current; current = current.parentElement) {
            if (current === this) return true;
        }
        return false;
    }

    matches(selector) {
        return selector.split(',').some((part) => ['main', 'article', 'body'].includes(part.trim()) && this.tagName === part.trim());
    }

    insertAdjacentElement(position, node) {
        this.inserted.push({ position, node });
    }
}

const locatorSnippet = between('    function jableDetailSlug()', '    function findJableFeedbackBox()');
const loadLocators = new Function('SITE', 'location', 'document', `${locatorSnippet}; return { jableDetailSlug, findJableTagsSection };`);

{
    const location = { pathname: '/videos/JUR-857/', origin: 'https://jable.tv' };
    const { jableDetailSlug } = loadLocators('jable', location, { querySelectorAll: () => [] });
    assert(jableDetailSlug() === 'jur-857', 'Jable 详情页提取小写番号');
    location.pathname = '/s0/videos/MIAA-711/';
    assert(jableDetailSlug() === 'miaa-711', 'Jable s0 分片详情页提取小写番号');
    location.pathname = '/s12/videos/ABP-123/';
    assert(jableDetailSlug() === 'abp-123', 'Jable 其他数字分片路径沿用同一规则');
    location.pathname = '/tags/office-lady/';
    assert(jableDetailSlug() === '', 'Jable 非详情页不安装影片介绍');
    location.pathname = '/foo/videos/ABP-123/';
    assert(jableDetailSlug() === '', '拒绝未知前缀伪详情路径');
}

{
    const section = new MockElement();
    const group = new MockElement({ parent: section });
    const link = new MockElement({ href: 'https://jable.tv/tags/office-lady/', parent: group });
    const label = new MockElement({ text: '標籤：', parent: section });
    const document = {
        querySelectorAll(selector) {
            if (selector === 'a[href]') return [link];
            return [label];
        },
    };
    const { findJableTagsSection } = loadLocators('jable', { pathname: '/', origin: 'https://jable.tv' }, document);
    assert(findJableTagsSection() === section, '优先使用“標籤”标题所在内容块');
}

{
    const first = new MockElement();
    const second = new MockElement();
    const links = [
        new MockElement({ href: 'https://jable.tv/tags/a/', parent: first }),
        new MockElement({ href: 'https://jable.tv/tags/b/', parent: first }),
        new MockElement({ href: 'https://jable.tv/tags/c/', parent: second }),
    ];
    const document = { querySelectorAll: (selector) => selector === 'a[href]' ? links : [] };
    const { findJableTagsSection } = loadLocators('jable', { pathname: '/', origin: 'https://jable.tv' }, document);
    assert(findJableTagsSection() === first, '无标签标题时选择包含最多标签链接的容器');
}

const placementSnippet = between('    function placeJableFilmIntroCard(', '    function renderJableFilmIntroError(');
const loadPlacement = new Function('Node', 'findJableFeedbackBox', `${placementSnippet}; return placeJableFilmIntroCard;`);

{
    const common = new MockElement();
    const tags = new MockElement({ parent: common });
    const feedbackBranch = new MockElement({ parent: common });
    const feedback = new MockElement({ parent: feedbackBranch });
    tags.compareDocumentPosition = () => 4;
    common.insertBefore = (card, before) => { common.before = { card, before }; };
    const place = loadPlacement({ DOCUMENT_POSITION_FOLLOWING: 4 }, () => feedback);
    const card = new MockElement();
    place(card, tags);
    assert(common.before.card === card && common.before.before === feedbackBranch, '卡片插入标签之后、反馈框分支之前');
}

{
    const tags = new MockElement();
    const place = loadPlacement({ DOCUMENT_POSITION_FOLLOWING: 4 }, () => null);
    const card = new MockElement();
    place(card, tags);
    assert(tags.inserted[0].position === 'afterend' && tags.inserted[0].node === card, '反馈框延迟渲染时紧跟标签插入');
}

const lazySnippet = between('    function startJableFilmIntroLazyLoad(', '    function ensureJableFilmIntroCard()');

{
    const state = { loading: false };
    let requestCount = 0;
    let rendered = null;
    let instance = null;
    class MockIntersectionObserver {
        constructor(callback, options) {
            this.callback = callback;
            this.options = options;
            instance = this;
        }
        observe(node) { this.node = node; }
        disconnect() { this.disconnected = true; }
    }
    const startLazy = new Function(
        'jableFilmIntroState', 'IntersectionObserver', 'load7mmtvIntro', 'renderFilmIntro', 'renderJableFilmIntroError',
        `${lazySnippet}; return startJableFilmIntroLazyLoad;`
    )(
        state,
        MockIntersectionObserver,
        async (slug) => { requestCount++; return { slug, text: '介绍', images: [] }; },
        (_body, data) => { rendered = data; },
        () => { throw new Error('不应进入错误分支'); }
    );
    const card = {};
    const body = { textContent: '' };
    startLazy(card, body, 'jur-857');
    assert(requestCount === 0, '卡片未进入视口前不请求 7mmtv');
    assert(instance.node === card && instance.options.rootMargin === '300px 0px', '提前 300px 观察影片介绍卡片');
    instance.callback([{ isIntersecting: true }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(requestCount === 1 && rendered.slug === 'jur-857' && instance.disconnected, '进入视口后只启动一次加载并停止观察');
}

{
    const state = { loading: false };
    let attempts = 0;
    let retry = null;
    const startLazy = new Function(
        'jableFilmIntroState', 'IntersectionObserver', 'load7mmtvIntro', 'renderFilmIntro', 'renderJableFilmIntroError',
        `${lazySnippet}; return startJableFilmIntroLazyLoad;`
    )(
        state,
        undefined,
        async () => {
            attempts++;
            if (attempts === 1) throw new Error('临时失败');
            return { text: '重试成功', images: [] };
        },
        (_body, data) => { assert(data.text === '重试成功', '失败后点击重新加载可成功渲染'); },
        (_body, _error, retryFn) => { retry = retryFn; }
    );
    startLazy({}, { textContent: '' }, 'jur-857');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(attempts === 1 && typeof retry === 'function', '不支持 IntersectionObserver 时立即加载并保留重试入口');
    retry();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(attempts === 2, '重新加载只新增一次请求');
}
