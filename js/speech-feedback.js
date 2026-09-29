/* ==========================================================================
 * speech-feedback.js — 朗读的界面反馈层
 * --------------------------------------------------------------------------
 * 与 tts.js 的分工：
 *   tts.js             纯引擎：发音、语速、句队列，并给朗读中的元素打 is-speaking 标记
 *   speech-feedback.js 界面：语速档位、停止按钮、朗读状态徽标、兼容性提示
 *
 * 功能：
 *   1. 顶部语速三档（0.7 / 0.85 / 1.0）：点击即切换，并自动试听一句
 *   2. “⏹ 停止朗读”按钮：只在朗读中可点，点击立即停止
 *   3. 状态徽标：单句显示“朗读中”，整段播放显示“朗读中 2/4”
 *   4. 队列结束 / 出错时复位状态并给中文提示
 *   5. 浏览器不支持 Web Speech API 时，禁用控件并说明原因
 *
 * 后续可选扩展（尚未实现）：用 SpeechRecognition 做词级比对的「跟读练习」，
 * iOS Safari 不支持该 API 时降级为“听音 + 自评”。
 * ========================================================================== */

import { on, setRate, getRate, stopSpeaking, speak, isSupported } from './tts.js';

/** 切换语速后是否试听一句（中年用户靠听才分得清快慢，建议保持 true） */
const SPEAK_SAMPLE_ON_RATE_CHANGE = true;
const SAMPLE_TEXT = 'This is the new speed.';

let inited = false;
let notify = defaultNotify;
const dom = {};                                     // 缓存的 DOM 引用
let queueState = { active: false, index: -1, total: 0 };

/** 兜底提示：直接操作全局 #toast（app.js 一般会传入它自己的 toast） */
function defaultNotify(message, duration = 2000) {
  const box = document.getElementById('toast');
  if (!box) { console.warn('[feedback]', message); return; }
  box.textContent = message;
  box.hidden = false;
  clearTimeout(defaultNotify.timer);
  defaultNotify.timer = setTimeout(() => { box.hidden = true; }, duration);
}

/**
 * 初始化朗读界面反馈。
 * @param {{notify?: (msg: string, duration?: number) => void}} [options]
 */
export function initSpeechFeedback(options = {}) {
  if (inited) return;
  inited = true;
  if (typeof options.notify === 'function') notify = options.notify;

  dom.rateGroup = document.getElementById('rateGroup');
  dom.rateValue = document.getElementById('rateValue');
  dom.stopBtn   = document.getElementById('stopSpeak');
  dom.status    = document.getElementById('speakStatus');

  if (!isSupported()) {
    disableControls('当前浏览器不支持朗读，建议用 Safari / Chrome / Edge 打开');
    return;
  }

  bindRateButtons();
  bindStopButton();
  subscribeTTS();
  renderRate(getRate());
  renderState(false);
}

/* ---------------------------- 语速档位 ---------------------------- */
function bindRateButtons() {
  if (!dom.rateGroup) return;
  dom.rateGroup.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-rate]');
    if (!btn) return;

    setRate(Number(btn.dataset.rate));      // 内部会派发 ratechange → renderRate
    // 点击语速按钮本身就是用户手势，这里试听最合适（iOS 也允许发声）
    if (SPEAK_SAMPLE_ON_RATE_CHANGE) speakSample();
  });
}

/**
 * 用新语速读一句示例，方便用户马上分辨快慢。
 * 注意：必须同步调用 speak()，不能 await / 放进 .then()，否则 iOS 会拒绝发声。
 */
function speakSample() {
  speak(SAMPLE_TEXT, { element: null });
}

/** 渲染语速按钮的选中态与当前值（默认 0.9 不属于任何一档，此时三个按钮都不高亮） */
function renderRate(value) {
  const text = String(value);
  if (dom.rateValue) dom.rateValue.textContent = text;
  if (!dom.rateGroup) return;

  const buttons = dom.rateGroup.querySelectorAll('[data-rate]');
  Array.prototype.forEach.call(buttons, (btn) => {
    const active = Number(btn.dataset.rate) === Number(value);
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

/* ---------------------------- 停止按钮 ---------------------------- */
function bindStopButton() {
  if (!dom.stopBtn) return;
  dom.stopBtn.addEventListener('click', () => {
    stopSpeaking();
    queueState = { active: false, index: -1, total: 0 };
    renderState(false);
  });
}

/* ---------------------------- 订阅引擎事件 ---------------------------- */
function subscribeTTS() {
  on('start', () => renderState(true, progressText()));
  on('end', () => { if (!queueState.active) renderState(false); });
  on('queuechange', (payload) => {
    queueState = payload;
    if (payload.active) renderState(true, progressText());
    else renderState(false);
  });
  on('ratechange', (payload) => renderRate(payload.rate));
  on('error', handleError);
}

function progressText() {
  if (!queueState.active || queueState.index < 0) return '';
  return `${queueState.index + 1}/${queueState.total}`;
}

/** 统一刷新“朗读中”状态：停止按钮 + 状态徽标 */
function renderState(active, progress) {
  if (dom.stopBtn) {
    dom.stopBtn.disabled = !active;
    dom.stopBtn.classList.toggle('is-active', active);
  }
  if (dom.status) {
    dom.status.hidden = !active;
    if (active) dom.status.textContent = progress ? `朗读中 ${progress}` : '朗读中';
  }
}

/* ---------------------------- 异常与兼容性 ---------------------------- */
function handleError(payload) {
  const reason = payload && payload.reason;
  if (reason === 'not-allowed') notify('浏览器阻止了朗读，请先在页面上点一下再试 🔊');
  else notify('这句没能读出来，换个浏览器（Safari / Chrome / Edge）试试');
}

/** 不支持朗读时禁用控件并说明 */
function disableControls(message) {
  if (dom.rateGroup) {
    dom.rateGroup.classList.add('is-disabled');
    const buttons = dom.rateGroup.querySelectorAll('button');
    Array.prototype.forEach.call(buttons, (btn) => { btn.disabled = true; });
  }
  if (dom.stopBtn) dom.stopBtn.disabled = true;
  if (dom.status) {
    dom.status.hidden = false;
    dom.status.textContent = '不支持朗读';
  }
  notify(message, 3600);
}
