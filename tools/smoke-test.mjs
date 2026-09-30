/* 临时冒烟测试脚本（不入库）：用 Chrome DevTools Protocol 跑 5 条路由，
   收集 console 错误 + 关键 DOM 断言。运行：node tools/smoke-test.mjs */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8099/index.html';
const PORT = 9333;
const ROUTES = ['home', 'roots', 'dialogues', 'vocabulary', 'websites'];
const results = [];

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--disable-gpu',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--user-data-dir=' + process.env.TEMP + '\\smoke-profile-' + Date.now(), 'about:blank'
], { stdio: 'ignore' });

await sleep(2500);
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));

let msgId = 0;
const pending = new Map();
const consoleErrors = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    consoleErrors.push('EXCEPTION: ' + (d.exception?.description || d.text));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push('CONSOLE.ERROR: ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    consoleErrors.push('LOG: ' + msg.params.entry.text + ' @ ' + (msg.params.entry.url || ''));
  }
});

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve) => {
    pending.set(id, (m) => resolve(m.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description };
  return r && r.result ? r.result.value : undefined;
}

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

for (const route of ROUTES) {
  consoleErrors.length = 0;
  await send('Page.navigate', { url: `${BASE}#/${route}` });
  await sleep(2200);

  const probe = await evalJs(`(() => {
    const q = (s) => document.querySelector(s);
    const qa = (s) => Array.from(document.querySelectorAll(s));
    const bar = q('.filterbar');
    const back = q('.back-to-top');
    const input = q('#searchInput');
    return {
      // 需求1：常驻搜索框
      noToggleBtn: !q('#searchToggle'),
      noCancelBtn: !q('#searchCancel'),
      noFieldWrap: !q('#searchField'),
      searchInputVisible: !!input && input.offsetWidth > 200 && input.offsetHeight > 30,
      searchInputW: input ? Math.round(input.getBoundingClientRect().width) : 0,
      headerTitle: !!q('.app-header__title'),
      // 需求3：默认展开
      barExists: !!bar,
      barCollapsed: bar ? bar.classList.contains('is-collapsed') : null,
      barHeight: bar ? Math.round(bar.querySelector('.filterbar__list').getBoundingClientRect().height) : 0,
      listWraps: bar ? bar.querySelector('.filterbar__list').scrollWidth > bar.querySelector('.filterbar__list').clientWidth : null,
      // 需求4：胶囊
      caretSize: (() => { const c = q('.filterbar__caret'); if (!c) return null;
        const r = c.getBoundingClientRect(); const i = c.querySelector('.filterbar__caret-icon').getBoundingClientRect();
        const chip = c.previousElementSibling.getBoundingClientRect();
        return { hit: Math.round(r.width)+'x'+Math.round(r.height), pill: Math.round(i.width)+'x'+Math.round(i.height),
                 gap: Math.round(i.left - chip.right) }; })(),
      caretBorderAll: (() => { const i = q('.filterbar__caret-icon'); if (!i) return null;
        const s = getComputedStyle(i); return { bl: s.borderLeftWidth, br: s.borderRightWidth, bt: s.borderTopWidth, bb: s.borderBottomWidth, radius: s.borderTopLeftRadius }; })(),
      caretBg: (() => { const i = q('.filterbar__caret-icon'); return i ? getComputedStyle(i).backgroundColor : null; })(),
      // 其他保持不变
      chips: qa('.filterbar__chip').length, caret: qa('.filterbar__caret').length,
      subs: qa('.filterbar__sub').length,
      // 第 5 轮：[全选][清空勾选][▸/▾] 三按钮；旧 .filterbar__reset 应已不存在
      resetGone: !q('.filterbar__reset'),
      tools: ['.filterbar__tool--primary', '.filterbar__tool--ghost', '.filterbar__toggle'].map((s) => {
        const b = q(s); if (!b) return null;
        const r = b.getBoundingClientRect();
        return Math.round(r.width) + 'x' + Math.round(r.height);
      }),
      toggle: !!q('.filterbar__toggle'),
      rateButtons: qa('.rate__btn').map(b => b.dataset.rateStep),
      rateValue: q('#rateValue')?.textContent,
      speakbarH: q('.speakbar') ? Math.round(q('.speakbar').getBoundingClientRect().height) : 0,
      homeCards: qa('.home-card').length,
      cardPool: window.__app?.homeCards?.getPool?.()?.length ?? null,
      rootsCat: qa('.roots-category').length, rootsGroup: qa('.roots-group').length,
      dialogueScene: qa('.dialogue-scene').length,
      vocabCard: qa('.word-card').length, websiteCard: qa('.website-card').length,
      tabbar: !!q('#tabbar'), speakable: qa('.speakable').length,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  })()`);
  // 第 5 轮：每页实测「全选态 → 点清空 → 空态 → 点全选 → 全选态」+ 置灰时机 + 空态文案
  //（home 无筛选条、vocabulary 无工具按钮 → 自动 skip）
  const toolCycle = await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const p = q('.filterbar__tool--primary'), g = q('.filterbar__tool--ghost');
    if (!p || !g) return { skip: true, hasBar: !!q('.filterbar') };
    const st = () => {
      const e = q('.filterbar__empty');
      return {
        visible: document.querySelectorAll('.dialogue-scene:not([hidden]), .roots-category:not([hidden]), .website-category:not([hidden])').length,
        selectAllDisabled: p.disabled,
        clearDisabled: g.disabled,
        emptyShown: e ? !e.hidden : null,
        emptyText: e && !e.hidden ? e.innerText : null,
        emptyStyle: e && !e.hidden ? (() => { const s = getComputedStyle(e); return { fontSize: s.fontSize, color: s.color, textAlign: s.textAlign }; })() : null
      };
    };
    const out = { s1_allSelected: st() };
    if (g.disabled) return { ...out, error: 'initial: clear button should be enabled' };
    g.click(); await sleep(400);
    out.s2_afterClear = st();
    if (p.disabled) out.error = 'after clear: select-all should be enabled';
    p.click(); await sleep(400);
    out.s3_afterSelectAll = st();
    if (g.disabled) out.error = 'after select-all: clear should be enabled';
    return out;
  })()`);
  results.push({ route, errors: [...consoleErrors], probe, toolCycle });
}
console.log(JSON.stringify({ results }, null, 1));

// ---- 搜索交互（需求 1 / 保留项） ----
await send('Page.navigate', { url: `${BASE}#/home` });
await sleep(2000);
const searchTest = await evalJs(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const out = {};
  out.noToggleBtn = !q('#searchToggle');
  out.noCancelBtn = !q('#searchCancel');
  out.noFieldWrap = !q('#searchField');
  const input = q('#searchInput');
  out.inputVisibleOnLoad = input.offsetWidth > 200;
  out.notAutoFocused = document.activeElement !== input;
  out.decorativeIcon = !!q('.search__icon');
  out.iconNotClickable = getComputedStyle(q('.search__icon')).pointerEvents === 'none';
  input.focus();
  input.value = 'inspect'; input.dispatchEvent(new Event('input', {bubbles:true}));
  await sleep(900);
  out.resultRows = qa('.search-result').length;
  out.resultsVisible = !q('#searchResults').hidden;
  q('.search-result').click(); await sleep(1400);
  out.afterJumpKeyword = input.value;
  out.afterJumpPanelHidden = q('#searchResults').hidden;
  out.afterJumpBlurred = document.activeElement !== input;
  out.afterJumpHash = location.hash;
  input.focus(); input.dispatchEvent(new Event('input', {bubbles:true})); await sleep(900);
  out.panelOpenAgain = !q('#searchResults').hidden;
  document.querySelector('.app-main').click(); await sleep(400);
  out.afterOutsidePanelHidden = q('#searchResults').hidden;
  out.afterOutsideKeyword = input.value;
  input.focus(); input.dispatchEvent(new Event('input', {bubbles:true})); await sleep(900);
  out.panelOpenThird = !q('#searchResults').hidden;
  input.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
  await sleep(400);
  out.afterEscPanelHidden = q('#searchResults').hidden;
  out.afterEscKeyword = input.value;
  out.clearBtnExists = !!q('#searchClear');
  return out;
})()`);
console.log('SEARCH ' + JSON.stringify(searchTest));

// ---- 需求 3：默认展开 + 手动切换 ----
const collapseTest = {};
for (const r of ['roots', 'dialogues', 'websites', 'vocabulary']) {
  await send('Page.navigate', { url: `${BASE}#/${r}` });
  await sleep(2200);
  collapseTest[r] = await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const list = q('.filterbar__list');
    const bar = q('.filterbar');
    const out = {};
    const tp = q('.filterbar__tool--primary'), tg = q('.filterbar__tool--ghost');
    out.toolsBefore = [tp ? tp.disabled : null, tg ? tg.disabled : null];     // 第 5 轮：展开/收起不改变置灰
    out.defaultCollapsed = bar.classList.contains('is-collapsed');
    out.defaultH = Math.round(list.getBoundingClientRect().height);
    out.defaultIcon = q('.filterbar__toggle-icon').textContent;
    q('.filterbar__toggle').click(); await sleep(420);
    out.afterToggleCollapsed = bar.classList.contains('is-collapsed');
    out.afterToggleH = Math.round(list.getBoundingClientRect().height);
    out.afterToggleIcon = q('.filterbar__toggle-icon').textContent;
    q('.filterbar__toggle').click(); await sleep(420);
    out.backToExpanded = !bar.classList.contains('is-collapsed');
    out.allChipsInView = Array.from(document.querySelectorAll('.filterbar__chip'))
      .filter(c => { const b = c.getBoundingClientRect(); return b.top >= -1 && b.left >= -1; }).length;
    out.toolsAfter = [tp ? tp.disabled : null, tg ? tg.disabled : null];
    out.toolsUnchanged = JSON.stringify(out.toolsBefore) === JSON.stringify(out.toolsAfter);
    return out;
  })()`);
}
console.log('COLLAPSE ' + JSON.stringify(collapseTest, null, 1));

// ---- 需求 4：一级按钮 + 胶囊间距/尺寸 + 点击行为 ----
await send('Page.navigate', { url: `${BASE}#/roots` });
await sleep(2200);
// 静态几何：胶囊尺寸 / 间距 / 图标码位（0x25B8=▸ 收起，0x25BE=▾ 展开）
const caretTest0 = await evalJs(`(() => {
  const q = (s) => document.querySelector(s);
  const c = q('.filterbar__caret'), i = q('.filterbar__caret-icon'), chip = q('.filterbar__chip');
  const code = (el) => el.textContent.codePointAt(0).toString(16);
  const gap = Math.round(i.getBoundingClientRect().left - chip.getBoundingClientRect().right);
  return { hit: Math.round(c.getBoundingClientRect().width)+'x'+Math.round(c.getBoundingClientRect().height),
           pill: Math.round(i.getBoundingClientRect().width)+'x'+Math.round(i.getBoundingClientRect().height),
           gap, initialIcon: code(i), initialAria: c.getAttribute('aria-expanded') };
})()`);
console.log('CARET0 ' + JSON.stringify(caretTest0));

const caretTest = await evalJs(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const out = {};
  const c = q('.filterbar__caret'), i = q('.filterbar__caret-icon');
  const code = () => i.textContent.codePointAt(0).toString(16);
  // 第 5 轮：先取消一个勾 → 部分状态，验证手风琴展开/收起不改变置灰与勾选
  q('.filterbar__chip').click(); await sleep(300);
  out.toolsPartialBefore = [q('.filterbar__tool--primary').disabled, q('.filterbar__tool--ghost').disabled];
  out.chipOnBefore = q('.filterbar__chip').classList.contains('is-on');
  out.subsOnBefore = qa('.filterbar__sub').map((s) => s.classList.contains('is-on'));
  out.iconClosed = code();
  c.click(); await sleep(300);
  out.subsAfterFirstClick = !q('.filterbar__subs').hidden;
  out.ariaAfterOpen = c.getAttribute('aria-expanded');
  out.iconOpen = code();
  c.click(); await sleep(300);
  out.subsAfterSecondClick = !q('.filterbar__subs').hidden;
  out.ariaAfterClose = c.getAttribute('aria-expanded');
  out.iconClosedAgain = code();
  const s2 = getComputedStyle(q('.filterbar__sub'));
  out.subStyleUnchanged = { minH: s2.minHeight, border: s2.borderTopWidth, radius: s2.borderTopLeftRadius, pad: s2.paddingLeft };
  // 第 5 轮：手风琴切换后 —— 置灰状态与勾选状态都必须保持不变
  out.toolsAfterAccordion = [q('.filterbar__tool--primary').disabled, q('.filterbar__tool--ghost').disabled];
  out.chipOnAfter = q('.filterbar__chip').classList.contains('is-on');
  out.subsOnAfter = qa('.filterbar__sub').map((s) => s.classList.contains('is-on'));
  out.toolsUnchanged = JSON.stringify(out.toolsPartialBefore) === JSON.stringify(out.toolsAfterAccordion);
  out.selectionUnchanged = out.chipOnBefore === out.chipOnAfter &&
    JSON.stringify(out.subsOnBefore) === JSON.stringify(out.subsOnAfter);
  return out;
})()`);
console.log('CARET ' + JSON.stringify(caretTest));

// ---- 回归：筛选 / 全选 / 清空勾选 / 卡片池 / 语速 / 返回顶部 ----
await send('Page.navigate', { url: `${BASE}#/dialogues` });
await sleep(2200);
const regress = await evalJs(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const p = q('.filterbar__tool--primary'), g = q('.filterbar__tool--ghost');
  const out = {};
  out.allScenes = qa('.dialogue-scene:not([hidden])').length;
  out.initial = { selectAllDisabled: p.disabled, clearDisabled: g.disabled };   // 全选态：全选置灰、清空可点
  qa('.filterbar__chip')[0].click(); await sleep(300);                          // → 部分勾选
  out.afterUncheck1 = qa('.dialogue-scene:not([hidden])').length;
  out.partial = { selectAllDisabled: p.disabled, clearDisabled: g.disabled };   // 部分勾选：两个都亮
  g.click(); await sleep(300);                                                  // → 清空勾选
  out.afterClear = qa('.dialogue-scene:not([hidden])').length;
  out.cleared = { selectAllDisabled: p.disabled, clearDisabled: g.disabled };   // 空态：清空置灰、全选可点
  out.emptyShown = !q('.filterbar__empty').hidden;
  out.emptyText = q('.filterbar__empty').innerText;
  p.click(); await sleep(300);                                                  // → 全选恢复
  out.afterSelectAll = qa('.dialogue-scene:not([hidden])').length;
  out.restored = { selectAllDisabled: p.disabled, clearDisabled: g.disabled };
  out.emptyHiddenAgain = q('.filterbar__empty').hidden;
  return out;
})()`);
const misc = await evalJs(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const out = {};
  out.rateBefore = q('#rateValue').textContent;
  q('[data-rate-step="1"]').click(); out.rateAfterPlus = q('#rateValue').textContent;
  q('[data-rate-step="-1"]').click(); out.rateBack = q('#rateValue').textContent;
  out.speakbarH = Math.round(q('.speakbar').getBoundingClientRect().height);
  const b = q('.back-to-top');
  out.backHiddenAtTop = b.hidden;
  window.scrollTo(0, 900); await sleep(500);
  out.backVisible = !b.hidden;
  const r = b.getBoundingClientRect();
  out.backSize = Math.round(r.width) + 'x' + Math.round(r.height);
  out.backPxAboveTabbar = Math.round(document.querySelector('#tabbar').getBoundingClientRect().top - r.bottom);
  b.click(); await sleep(1200);
  out.scrollYAfterClick = Math.round(window.scrollY);
  return out;
})()`);
console.log('REGRESS ' + JSON.stringify({ dialogues: regress, misc }, null, 1));

// ---- 小屏 360px 回归 ----
await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: `${BASE}#/roots` });
await sleep(2200);
const small = await evalJs(`(() => {
  const q = (s) => document.querySelector(s);
  const out = {};
  out.overflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  out.speakbarH = Math.round(q('.speakbar').getBoundingClientRect().height);
  out.searchW = Math.round(q('#searchInput').getBoundingClientRect().width);
  const c = q('.filterbar__caret'), i = q('.filterbar__caret-icon'), chip = q('.filterbar__chip');
  out.caretHit = Math.round(c.getBoundingClientRect().width) + 'x' + Math.round(c.getBoundingClientRect().height);
  out.caretGap = Math.round(i.getBoundingClientRect().left - chip.getBoundingClientRect().right);
  return out;
})()`);
console.log('SMALL ' + JSON.stringify(small));
await send('Emulation.clearDeviceMetricsOverride');

ws.close();



chrome.kill();
process.exit(0);
