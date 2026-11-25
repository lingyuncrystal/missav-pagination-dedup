import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'missav-enhancer.user.js'), 'utf8');

function assert(condition, message) {
    if (!condition) throw new Error(message);
    console.log('ok', message);
}

assert(!/resolveViaJable/.test(source), '标题替换链不再调用 Jable 中文源');
assert(source.includes('fetchJableTitle') && source.includes('initJableFilmIntro'), 'Jable 页面自身功能与影片介绍仍保留');
assert(source.includes('不再抓取 Jable'), '设置面板明确提示不再抓取 Jable');
assert(source.includes('缓存 → GetAV 精校 → Manko → 大模型'), '标题源说明已移除 Jable 层');

console.log('标题源夹具全部通过');
