/* ==========================================================================
 * tts.js — Web Speech API 朗读引擎（全站唯一的英文发音入口）
 * --------------------------------------------------------------------------
 * 对外 API：
 *   initTTS()                    初始化：加载英语语音、注册 iOS 手势预热
 *   speak(text, options)         朗读一段英文（必须在用户手势中同步调用）
 *   stopSpeaking()               立即停止，并清空队列与高亮
 *   setRate(rate) / getRate()    语速（三档 0.7 / 0.85 / 1.0，默认 0.9，自动记忆）
 *   bindSpeakable(root)          用事件委托绑定 .speakable / [data-speak]
 *   speakQueue(items, options)   逐句串行朗读（长对话“整段播放”用）
 *   isSpeaking() / isSupported() / on(event, fn) / off(event, fn)
 *
 * HTML 约定（三条，够用且不啰嗦）：
 *   <span class="speakable">Nice to meet you.</span>
 *       点它 → 朗读 textContent 里的英文，中文与 emoji 会被自动剔除
 *   <p class="speakable" data-speak="How's it going?">How's it going?</p>
 *       data-speak 优先级最高，适合内容里混着中文的场合
 *   <button data-speak="Nice to meet you." data-speak-for="line1">🔈 朗读</button>
 *       data-speak-for 指定要高亮的元素（按 id 查），不写就高亮按钮自己
 *
 * 事件：start / end / error / queuechange / ratechange
 * ========================================================================== */

/* ============================ 1. 常量与状态 ============================ */
const LANG = 'en-US';
const DEFAULT_RATE = 0.9;
const RATE_PRESETS = [0.7, 0.85, 1.0];
const MIN_RATE = 0.5;
const MAX_RATE = 1.5;
const RATE_STORAGE_KEY = 'elapp.tts.rate';
const SPEAKABLE_SELECTOR = '.speakable, [data-speak]';

let synth = null;               // speechSynthesis 实例
let supported = false;          // 浏览器是否支持
let voices = [];                // 语音列表
let voice = null;               // 当前选中的英语语音
let rate = DEFAULT_RATE;        // 当前语速
let primed = false;             // iOS 是否已在用户手势中预热过
let speakToken = 0;             // 每次朗读自增，用于丢弃过期回调
let speakingFlag = false;       // 是否正在朗读
let currentElement = null;      // 当前高亮的元素

/* 句队列（“整段播放”）状态 */
let queue = [];
let queueIndex = -1;
let queueActive = false;
let queueTotal = 0;

/* 事件订阅表 */
const listeners = { start: new Set(), end: new Set(), error: new Set(), queuechange: new Set(), ratechange: new Set() };

/** 订阅事件，返回取消订阅函数 */
export function on(event, handler) {
  const set = listeners[event];
  if (!set || typeof handler !== 'function') return () => {};
  set.add(handler);
  return () => set.delete(handler);
}

/** 取消订阅 */
export function off(event, handler) {
  const set = listeners[event];
  if (set) set.delete(handler);
}

/** 派发事件（单个回调出错不影响其它回调） */
function emit(event, payload) {
  const set = listeners[event];
  if (!set) return;
  set.forEach((fn) => {
    try { fn(payload); } catch (err) { console.warn('[tts] 事件回调异常：', event, err); }
  });
}

/* ============================ 2. 初始化 ============================ */
/**
 * 初始化朗读引擎（在 app.js 启动时调用一次）。
 * @returns {boolean} 浏览器是否支持朗读
 */
export function initTTS() {
  if (synth) return supported;

  synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  supported = !!(synth && typeof window.SpeechSynthesisUtterance === 'function');
  if (!supported) {
    console.warn('[tts] 当前浏览器不支持 Web Speech API，朗读不可用');
    return false;
  }

  rate = loadSavedRate();
  loadVoices();

  // 语音列表在部分浏览器里是异步就绪的：先监听事件，再兜底重试一次
  if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', loadVoices);
  else synth.onvoiceschanged = loadVoices;
  setTimeout(loadVoices, 300);

  primeOnFirstGesture();
  return true;
}

/** 是否支持朗读 */
export function isSupported() { return supported; }

/** 读取系统语音列表并挑出最合适的英语语音 */
function loadVoices() {
  if (!synth) return voices;
  try {
    voices = synth.getVoices() || [];
  } catch (err) {
    voices = [];
  }
  voice = pickVoice(voices);
  return voices;
}

/** 评分挑选：优先 en-US → 本地语音 → 常见高质量语音；非英语语音直接排除 */
function pickVoice(all) {
  if (!all || !all.length) return null;

  const scoreOf = (v) => {
    const lang = String(v.lang || '').toLowerCase().replace('_', '-');
    let score = 0;
    if (lang === 'en-us') score += 4;
    else if (lang.indexOf('en') === 0) score += 2;
    else return -1;
    if (v.localService) score += 1;
    if (/samantha|alex|aria|jenny|zira|google us english/i.test(v.name || '')) score += 1;
    return score;
  };

  let best = null;
  let bestScore = -1;
  all.forEach((v) => {
    const s = scoreOf(v);
    if (s > bestScore) { best = v; bestScore = s; }
  });
  return best;
}

/**
 * iOS / Safari 适配：必须在“用户手势”里真正调用一次 speak，语音引擎才会解锁；
 * 解锁之后，onend 回调里（例如队列的下一句）才能继续发声。
 * 这里用一条静音 utterance 预热，用户听不到声音。
 */
function primeOnFirstGesture() {
  const prime = () => {
    if (primed || !supported) return;
    primed = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.lang = LANG;
      u.volume = 0;
      u.rate = 2;
      synth.resume();          // 有些浏览器初始处于 paused 状态
      synth.speak(u);
    } catch (err) {
      console.warn('[tts] 语音引擎预热失败：', err);
    }
  };

  // once 只保证“注册一次”，真正的去重靠 primed 标记
  ['pointerdown', 'touchstart', 'click', 'keydown'].forEach((type) => {
    document.addEventListener(type, prime, { once: true, passive: true, capture: true });
  });
}

/* ============================ 3. 朗读 ============================ */
/**
 * 朗读一段英文（公共入口：会先结束正在播放的队列）。
 * 注意：必须在用户点击等手势的同步调用栈里执行，iOS 才允许发声。
 * @param {string} text 纯英文文本
 * @param {{rate?:number, lang?:string, element?:HTMLElement}} [options]
 * @returns {boolean} 是否成功发起朗读
 */
export function speak(text, options = {}) {
  stopQueue(true);
  return speakInternal(text, options);
}

/** 内部朗读：不清理队列，供 speak() 与 speakQueue() 复用 */
function speakInternal(text, options = {}) {
  const content = String(text == null ? '' : text).trim();
  if (!supported || !synth || !content) return false;

  const token = ++speakToken;
  const element = options.element || null;

  // 规范要求：每次朗读前先 cancel()，避免上一句还在读造成叠音
  try { synth.cancel(); } catch (err) { /* 某些浏览器 cancel 会抛错，忽略 */ }
  clearSpeakingMarks();

  const utterance = new SpeechSynthesisUtterance(content);
  utterance.lang = options.lang || LANG;
  utterance.rate = typeof options.rate === 'number' ? options.rate : rate;
  utterance.pitch = 1;
  utterance.volume = 1;
  if (voice) {
    // 个别浏览器在赋 voice 时会抛错，容错处理，退化为使用系统默认语音
    try { utterance.voice = voice; } catch (err) { /* 忽略 */ }
  }

  const finish = (cancelled, reason) => {
    if (token !== speakToken) return;        // 已被更新的朗读取代，丢弃过期回调
    speakingFlag = false;
    unmarkSpeaking(element);
    emit('end', { text: content, element, cancelled, reason, token });
    if (typeof options.onDone === 'function') options.onDone({ cancelled, reason });
  };

  utterance.onstart = () => {
    if (token !== speakToken) return;
    speakingFlag = true;
    markSpeaking(element);
    emit('start', { text: content, element, token });
  };
  utterance.onend = () => finish(false, 'end');
  utterance.onerror = (event) => {
    const reason = (event && event.error) ? event.error : 'error';
    // interrupted / canceled 属于“被新的朗读或停止打断”，不算失败
    if (reason !== 'interrupted' && reason !== 'canceled') {
      console.warn('[tts] 朗读出错：', reason);
      emit('error', { text: content, element, reason });
    }
    finish(true, reason);
  };

  try {
    synth.resume();
    synth.speak(utterance);
  } catch (err) {
    console.warn('[tts] 朗读失败：', err);
    emit('error', { text: content, element, reason: 'exception' });
    finish(true, 'exception');
    return false;
  }
  return true;
}

/**
 * 逐句串行朗读（“整段播放”）。
 * 前一句 onend 之后再读下一句：每句都能单独高亮，也能被 stopSpeaking() 随时中断。
 * 这在 iOS 上尤其重要——如果一次性把长文本交给引擎，中途无法逐句高亮也无法可靠中断。
 * @param {Array<{text:string, element?:HTMLElement}>} items
 * @param {{rate?:number}} [options]
 * @returns {boolean} 是否成功发起
 */
export function speakQueue(items, options = {}) {
  const list = (items || [])
    .map((item) => ({
      text: extractEnglish(item && item.text != null ? item.text : ''),
      element: (item && item.element) || null
    }))
    .filter((item) => item.text);

  if (!list.length || !supported) return false;

  stopQueue(false);
  queue = list;
  queueTotal = list.length;
  queueIndex = -1;
  queueActive = true;
  emit('queuechange', { active: true, index: -1, total: queueTotal });
  playQueueStep(options);
  return true;
}

/** 播放队列中的下一句 */
function playQueueStep(options) {
  if (!queueActive) return;

  queueIndex += 1;
  if (queueIndex >= queue.length) {          // 全部读完了
    stopQueue(true);
    return;
  }

  const item = queue[queueIndex];
  emit('queuechange', { active: true, index: queueIndex, total: queueTotal });

  speakInternal(item.text, {
    element: item.element,
    rate: options && typeof options.rate === 'number' ? options.rate : undefined,
    // 出错也继续下一句，避免整段播放卡住
    onDone: () => { if (queueActive) playQueueStep(options); }
  });
}

/** 重置队列状态；finished=true 表示“正常读完”，也需要通知 UI */
function stopQueue(finished) {
  const wasActive = queueActive;
  queueActive = false;
  queue = [];
  queueIndex = -1;
  if (wasActive || finished) emit('queuechange', { active: false, index: -1, total: queueTotal });
}

/** 立即停止朗读（同时清空队列与高亮） */
export function stopSpeaking() {
  const wasSpeaking = speakingFlag || queueActive;

  speakToken += 1;                       // 让所有在途回调失效，避免旧回调把高亮又加回来
  stopQueue(true);
  if (synth) {
    try { synth.cancel(); } catch (err) { /* 忽略 */ }
  }
  clearSpeakingMarks();
  speakingFlag = false;

  if (wasSpeaking) {
    emit('end', { text: '', element: null, cancelled: true, reason: 'stopped', token: speakToken });
  }
}

/** 是否正在朗读（含“整段播放”中） */
export function isSpeaking() {
  return speakingFlag || queueActive;
}

/* ============================ 4. 语速 ============================ */
/**
 * 设置语速（0.5 ~ 1.5，超出会自动夹紧），并记住用户的选择。
 * @param {number} next
 * @returns {number} 生效后的语速
 */
export function setRate(next) {
  const n = Number(next);
  if (!isFinite(n)) return rate;
  const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, Math.round(n * 100) / 100));
  if (clamped === rate) return rate;
  rate = clamped;
  saveRate(rate);
  emit('ratechange', { rate });
  return rate;
}

/** 当前语速 */
export function getRate() { return rate; }

/** 三档预设 [0.7, 0.85, 1.0] */
export function getRatePresets() { return RATE_PRESETS.slice(); }

function loadSavedRate() {
  try {
    const saved = Number(localStorage.getItem(RATE_STORAGE_KEY));
    if (isFinite(saved) && saved >= MIN_RATE && saved <= MAX_RATE) return Math.round(saved * 100) / 100;
  } catch (err) {
    // 无痕模式或禁用存储时 localStorage 会抛错，忽略即可
  }
  return DEFAULT_RATE;
}

function saveRate(value) {
  try { localStorage.setItem(RATE_STORAGE_KEY, String(value)); } catch (err) { /* 忽略 */ }
}

/* ================ 5. 英文文本提取（中文绝不朗读） ================ */
/**
 * 取出元素要朗读的英文：
 *   1. data-speak 优先（内容里中英混排时最稳）
 *   2. 否则从 textContent 提取英文片段，中文与 emoji 自动剔除
 */
export function getSpeakText(element) {
  if (!element) return '';
  const explicit = element.getAttribute ? element.getAttribute('data-speak') : '';
  if (explicit && explicit.trim()) return explicit.trim();
  return extractEnglish(element.textContent || '');
}

/** 只保留英文字母、数字与英文常用标点，其它（中文、emoji）全部丢弃 */
export function extractEnglish(text) {
  const raw = String(text == null ? '' : text);
  if (!raw) return '';
  const chunks = raw.match(/[A-Za-z0-9'’\-.,!?;:%$&()\[\]\/ ]+/g);
  if (!chunks) return '';
  return chunks
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')   // 修掉拼接后的 "hello ." 之类空格
    .trim();
}

/* ============================ 6. 高亮与滚动 ============================ */
/** 给朗读中的元素加 is-speaking（同一时间只保留一个高亮） */
function markSpeaking(element) {
  if (!element || !element.classList) return;
  clearSpeakingMarks(element);
  element.classList.add('is-speaking');
  currentElement = element;
  ensureVisible(element);
}

/** 移除某个元素的高亮 */
function unmarkSpeaking(element) {
  if (element && element.classList) element.classList.remove('is-speaking');
  if (element && element === currentElement) currentElement = null;
}

/** 清除全站 is-speaking 标记（except 指定的元素保留） */
function clearSpeakingMarks(except) {
  const nodes = document.querySelectorAll('.is-speaking');
  Array.prototype.forEach.call(nodes, (node) => {
    if (node !== except) node.classList.remove('is-speaking');
  });
  if (!except) currentElement = null;
}

/**
 * 让朗读中的内容保持在可视区（整段播放长对话时特别有用）。
 * 只有元素确实滚出可视区才滚动，避免每次点击都跳屏。
 */
function ensureVisible(element) {
  if (!element || typeof element.getBoundingClientRect !== 'function') return;
  const rect = element.getBoundingClientRect();
  const header = document.querySelector('.app-header');
  const topLimit = (header ? header.offsetHeight : 60) + 12;
  const bottomLimit = window.innerHeight - 96;
  if (rect.top < topLimit || rect.bottom > bottomLimit) {
    try { element.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    catch (err) { element.scrollIntoView(); }
  }
}

/* ============================ 7. 事件委托绑定 ============================ */
const boundRoots = new WeakSet();

/**
 * 绑定可朗读元素（按规范用 document 级事件委托，绝不给每个元素单独绑事件）。
 * @param {Document|HTMLElement} root 默认 document
 */
export function bindSpeakable(root = document) {
  if (!root || boundRoots.has(root)) return;
  boundRoots.add(root);
  root.addEventListener('click', onSpeakableClick);
}

function onSpeakableClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;

  const node = target.closest(SPEAKABLE_SELECTOR);
  if (!node) return;

  const text = getSpeakText(node);
  if (!text) return;                      // 纯中文元素不会进来（没有 speakable 也没有 data-speak）

  // 只有占位链接才阻止默认行为，真实外链保持可跳转
  if (node.tagName === 'A' && (node.getAttribute('href') || '#') === '#') event.preventDefault();

  // data-speak-for：点“🔈 朗读”按钮时高亮对应的英文句子
  const forId = node.getAttribute('data-speak-for');
  const highlight = forId ? document.getElementById(forId) : node;

  speak(text, { element: highlight || node });
}





