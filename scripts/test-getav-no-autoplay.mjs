import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'missav-enhancer.user.js'), 'utf8');

function assert(condition, message) {
    if (!condition) throw new Error(message);
    console.log('ok', message);
}

assert(/@run-at\s+document-start/.test(source), '脚本在播放器加载前启动');
assert(/getavNoAutoplay:\s*true/.test(source), '禁止 GetAV 详情自动播放默认开启');
assert(source.includes('id="mve-getav-no-autoplay"'), '设置面板包含禁止自动播放开关');
assert(source.includes("safe('getav-no-autoplay', initGetavNoAutoplay)"), '自动播放监听在 DOM 就绪前安装');

const start = source.indexOf('    function isGetavVideoDetailPage()');
const end = source.indexOf('    /* ================================================================\n     * 模块五 titles', start);
if (start < 0 || end < 0) throw new Error('无法提取自动播放模块');
const snippet = source.slice(start, end);

function createHarness(pathname = '/zh/videos/rbd-578') {
    const listeners = {};
    const videos = [];
    const document = {
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        querySelectorAll(selector) { return selector === 'video' ? videos : []; },
    };
    const window = { addEventListener() {} };
    class FakeVideo {
        constructor(player = {}, { preview = false } = {}) {
            this.tagName = 'VIDEO';
            this.player = player;
            this.paused = false;
            this.autoplay = true;
            this.loop = preview;
            this.currentSrc = '';
            this.src = '';
            this.pauseCalls = 0;
            this.removed = [];
        }
        closest(selector) { return selector === '[data-media-player]' ? this.player : null; }
        pause() { this.pauseCalls++; this.paused = true; }
        removeAttribute(name) { this.removed.push(name); if (name === 'autoplay') this.autoplay = false; }
    }
    const config = { getavNoAutoplay: true };
    const location = { pathname };
    const factory = new Function('SITE', 'location', 'config', 'document', 'window', 'HTMLVideoElement',
        `function isPreviewVideo(v) { return v instanceof HTMLVideoElement && (v.loop || /preview/i.test(v.currentSrc || v.src || '')); }\n${snippet}; return { initGetavNoAutoplay, applyGetavNoAutoplay };`);
    const api = factory('getav', location, config, document, window, FakeVideo);
    api.initGetavNoAutoplay();
    const emit = (type, event) => listeners[type][0](event);
    return { api, config, location, listeners, videos, FakeVideo, emit };
}

const auto = createHarness();
const autoVideo = new auto.FakeVideo();
auto.videos.push(autoVideo);
let stopped = 0;
auto.emit('play', { target: autoVideo, preventDefault() {}, stopImmediatePropagation() { stopped++; } });
assert(autoVideo.pauseCalls === 1 && autoVideo.paused, '非用户手势触发的播放立即暂停');
assert(!autoVideo.autoplay && autoVideo.removed.includes('autoplay'), '移除播放器自动播放标记');
assert(stopped === 1, '自动播放事件不再传给播放器内部');

const manual = createHarness();
const manualPlayer = {};
const manualVideo = new manual.FakeVideo(manualPlayer);
const playButton = { tagName: 'BUTTON', closest: (selector) => selector === '[data-media-player]' ? manualPlayer : null };
manual.emit('pointerdown', { type: 'pointerdown', isTrusted: true, target: playButton });
manual.emit('play', { target: manualVideo });
manual.emit('playing', { target: manualVideo });
assert(manualVideo.pauseCalls === 0 && !manualVideo.paused, '用户点击后允许播放及缓冲恢复');
assert(!manualVideo.autoplay, '手动播放时同样不保留自动播放标记');

const keyboard = createHarness();
const keyboardPlayer = {};
const keyboardVideo = new keyboard.FakeVideo(keyboardPlayer);
keyboard.emit('keydown', { type: 'keydown', key: 'Enter', isTrusted: true, target: keyboardVideo });
keyboard.emit('play', { target: keyboardVideo });
assert(keyboardVideo.pauseCalls === 0, '键盘操作播放器也可手动播放');

const synthetic = createHarness();
const syntheticVideo = new synthetic.FakeVideo();
synthetic.emit('pointerdown', { type: 'pointerdown', isTrusted: false, target: syntheticVideo });
synthetic.emit('play', { target: syntheticVideo });
assert(syntheticVideo.pauseCalls === 1, '脚本模拟点击不被误认为用户播放');

const disabled = createHarness();
disabled.config.getavNoAutoplay = false;
const disabledVideo = new disabled.FakeVideo();
disabled.emit('play', { target: disabledVideo });
assert(disabledVideo.pauseCalls === 0 && disabledVideo.autoplay, '关闭设置后恢复站点播放行为');

const listPage = createHarness('/zh/profile/subscriptions');
const listVideo = new listPage.FakeVideo();
listPage.emit('play', { target: listVideo });
assert(listVideo.pauseCalls === 0, '非视频详情页不拦截播放');

const preview = createHarness();
const previewVideo = new preview.FakeVideo({}, { preview: true });
preview.emit('play', { target: previewVideo });
assert(previewVideo.pauseCalls === 0, '不误伤循环预览视频');

const existing = createHarness();
const existingVideo = new existing.FakeVideo();
existing.videos.push(existingVideo);
existing.api.applyGetavNoAutoplay();
assert(existingVideo.pauseCalls === 1 && !existingVideo.autoplay, '水合后清理已经在自动播放的播放器');

const idempotent = createHarness();
const count = idempotent.listeners.play.length;
idempotent.api.initGetavNoAutoplay();
assert(idempotent.listeners.play.length === count, '重复初始化不会重复安装监听');

console.log('GetAV 详情禁止自动播放夹具全部通过');
