/* tools/merge-dialogues.mjs —— 场景对话（data/dialogues.json）合规扩写包：合并 + 校验工具
 *
 * 用法：
 *   node tools/merge-dialogues.mjs <扩写包.json> [目标.json]   # 合并（默认目标 data/dialogues.json）
 *   node tools/merge-dialogues.mjs --check [目标.json]         # 只校验，不写入
 *
 * 本文件把「dialogues 版 AI 合规扩写系统提示词」的硬性规则落成代码：
 *   1. 只输出严格 JSON（无注释、无尾逗号、无多余字段）
 *   2. 结构 scenes -> lines -> keyExpressions
 *   3. scene 必填：id / titleEn / titleZh / descZh / lines / tipsZh
 *   4. line  必填：speaker / en / zh / keyExpressions（keyExpressions 可为 []）
 *   5. 对话 4-8 轮、A/B 交替、单句 3-12 个英文单词（A1-A2）→ 不合规只告警
 *   6. 仅允许中性日常内容（问候/购物/点餐/问路/交通/天气/户外/酒店/公园/家庭/学校…）
 *   7. 违禁内容（成人/暴力/仇恨/政治/宗教/赌博/毒品/武器/自伤/恐怖/隐私/联系方式…）→ 丢弃该 line / scene
 *   8. 同 id 跳过（不覆盖原内容）；同 scene 内 keyExpressions 按 en.trim().toLowerCase() 去重
 *   9. 写入时保持原文件其它字节不变，仅在 scenes 数组末尾追加
 *  10. 校验不过的内容直接丢弃
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_TARGET = 'data/dialogues.json';
const REQUIRED_SCENE_FIELDS = ['id', 'titleEn', 'titleZh', 'descZh', 'lines', 'tipsZh'];
const REQUIRED_LINE_FIELDS = ['speaker', 'en', 'zh', 'keyExpressions'];

/** 规则 7：违禁关键词（ASCII 走词边界匹配，中文直接包含匹配）
    中文关键词尽量带语境，避免误杀（如「成人票 / 成人英语课」不是成人内容） */
const BANNED_WORDS = [
  'porn', 'nude', 'xxx', 'sex', 'hooker', '成人内容', '成人视频', '成人网站', '色情', '裸照',
  'kill', 'gun', 'weapon', 'rifle', 'blood', 'violence', '暴力', '枪', '武器',
  'suicide', 'self harm', '自杀', '自伤',
  'hate', 'racist', 'slur', '歧视', '仇恨',
  'gamble', 'casino', 'betting', '赌博', '赌场', '彩票',
  'drug', 'cocaine', 'marijuana', 'weed', '毒品', '大麻', '吸毒',
  'terror', 'bomb', '恐怖', '炸弹',
  'election', 'president', 'protest', 'politic', '政治', '宗教', '选举',
  'wechat', 'whatsapp', 'phone number', 'id number', 'social security',
  '手机号', '微信号', '身份证', '护照号', '住址',
  'diagnosis', 'prescription', 'antidepressant',
  'investment', 'stock tips', 'loan', '投资建议', '炒股', '贷款'
];
const BANNED_ASCII = BANNED_WORDS.filter((w) => /^[\x20-\x7e]+$/.test(w))
  .map((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
const BANNED_CJK = BANNED_WORDS.filter((w) => !/^[\x20-\x7e]+$/.test(w));

const isFilledString = (v) => typeof v === 'string' && v.trim().length > 0;
const isFilledArray = (v) => Array.isArray(v) && v.length > 0;

/** 单句英文单词数（去掉标点后按空白切分） */
const wordCount = (en) => String(en).replace(/[^A-Za-z'\s-]/g, ' ').split(/\s+/).filter(Boolean).length;

/** 命中违禁词检测（英 / 中） */
function hasBanned(text) {
  const s = String(text || '');
  if (BANNED_ASCII.some((re) => re.test(s))) return true;
  return BANNED_CJK.some((w) => s.includes(w));
}

/* ---------- 规则 3 / 4 / 6 / 7 / 8 / 10：清洗与校验 ---------- */

/** 规则 8：keyExpressions 按 en.trim().toLowerCase() 去重，保留首次出现顺序 */
function cleanKeyExpressions(list) {
  const seen = new Set();
  const out = [];
  (Array.isArray(list) ? list : []).forEach((item) => {
    if (!item || !isFilledString(item.en) || !isFilledString(item.zh)) return;
    const en = item.en.trim();
    const key = en.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ en, zh: item.zh.trim() });
  });
  return out;
}

/** 规则 4 / 5 / 7 / 10：单行清洗；返回 null 表示丢弃该行 */
function cleanLine(raw, sceneId, warnings) {
  if (!raw || typeof raw !== 'object') {
    warnings.push(`[${sceneId}] 存在非对象 line，已丢弃`);
    return null;
  }
  const hasAll = REQUIRED_LINE_FIELDS.every((f) => (f === 'keyExpressions' ? Array.isArray(raw[f]) : isFilledString(raw[f])));
  if (!hasAll) {
    warnings.push(`[${sceneId}] line 缺必填字段（${REQUIRED_LINE_FIELDS.join(' / ')}），已丢弃`);
    return null;
  }
  const speaker = raw.speaker.trim().toUpperCase();
  const en = raw.en.trim();
  const zh = raw.zh.trim();
  if (!['A', 'B'].includes(speaker)) {
    warnings.push(`[${sceneId}] speaker "${speaker}" 不是 A/B，已丢弃`);
    return null;
  }
  if (hasBanned(`${en} ${zh}`)) {
    warnings.push(`[${sceneId}] line 命中违禁内容，已丢弃：${en}`);
    return null;
  }
  const words = wordCount(en);
  if (words < 3 || words > 12) warnings.push(`[${sceneId}] 句子 ${words} 个英文单词（建议 3-12、A1-A2）：${en}`);
  return { speaker, en, zh, keyExpressions: cleanKeyExpressions(raw.keyExpressions) };
}

/** 规则 3 / 6 / 7 / 10：场景清洗；返回 null 表示丢弃该场景 */
function cleanScene(raw, warnings) {
  if (!raw || typeof raw !== 'object') {
    warnings.push('存在非对象 scene，已丢弃');
    return null;
  }
  const id = isFilledString(raw.id) ? raw.id.trim() : '';
  const missing = REQUIRED_SCENE_FIELDS.filter((f) => {
    const v = raw[f];
    return f === 'lines' || f === 'tipsZh' ? !isFilledArray(v) : !isFilledString(v);
  });
  if (missing.length) {
    warnings.push(`scene ${id || '(无 id)'} 缺必填字段 ${missing.join(', ')}，已丢弃`);
    return null;
  }
  const sceneText = [
    raw.titleEn, raw.titleZh, raw.descZh, ...raw.tipsZh,
    ...raw.lines.map((l) => `${(l && l.en) || ''} ${(l && l.zh) || ''}`)
  ].join(' ');
  if (hasBanned(sceneText)) {
    warnings.push(`scene ${id} 命中违禁内容，已丢弃`);
    return null;
  }
  const lines = raw.lines.map((l) => cleanLine(l, id, warnings)).filter(Boolean);
  if (lines.length < 4) {
    warnings.push(`scene ${id} 有效对话不足 4 轮（剩 ${lines.length}），已丢弃`);
    return null;
  }
  if (lines.length > 8) warnings.push(`scene ${id} 有 ${lines.length} 轮对话（建议 4-8 轮）`);
  lines.forEach((l, i) => {
    if (i > 0 && l.speaker === lines[i - 1].speaker) warnings.push(`scene ${id} 第 ${i + 1} 句与上一句同为 ${l.speaker}（建议 A/B 交替）`);
  });
  return {
    id,
    titleEn: raw.titleEn.trim(),
    titleZh: raw.titleZh.trim(),
    descZh: raw.descZh.trim(),
    lines,
    tipsZh: raw.tipsZh.filter(isFilledString).map((t) => t.trim())
  };
}

/* ---------- 规则 1 / 2 / 9：输出严格 JSON（与现有文件排版一致） ---------- */

const J = (v) => JSON.stringify(v);
/** 行尾符：按目标文件现状决定（本仓库 core.autocrlf=true，data/*.json 工作区为 CRLF） */
let NL = '\n';

function renderScene(scene) {
  const out = [];
  out.push('    {');
  out.push(`      "id": ${J(scene.id)},`);
  out.push(`      "titleEn": ${J(scene.titleEn)},`);
  out.push(`      "titleZh": ${J(scene.titleZh)},`);
  out.push(`      "descZh": ${J(scene.descZh)},`);
  out.push('      "lines": [');
  scene.lines.forEach((line, i) => {
    out.push('        {');
    out.push(`          "speaker": ${J(line.speaker)},`);
    out.push(`          "en": ${J(line.en)},`);
    out.push(`          "zh": ${J(line.zh)},`);
    if (line.keyExpressions.length) {
      out.push('          "keyExpressions": [');
      line.keyExpressions.forEach((k, ki) => {
        const tail = ki < line.keyExpressions.length - 1 ? ',' : '';
        out.push(`            { "en": ${J(k.en)}, "zh": ${J(k.zh)} }${tail}`);
      });
      out.push('          ]');
    } else {
      out.push('          "keyExpressions": []');
    }
    out.push(`        }${i < scene.lines.length - 1 ? ',' : ''}`);
  });
  out.push('      ],');
  out.push('      "tipsZh": [');
  scene.tipsZh.forEach((t, i) => out.push(`        ${J(t)}${i < scene.tipsZh.length - 1 ? ',' : ''}`));
  out.push('      ]');
  out.push('    }');
  return out.join(NL);
}

/** 规则 9：只替换末尾的 `]` + `}`，原文件其余字节保持不动（行尾符沿用原文件） */
function appendScenes(fileText, scenesText) {
  const trimmed = fileText.replace(/\s+$/, '');
  const lastBracket = trimmed.lastIndexOf(']');
  if (lastBracket === -1) throw new Error('目标文件末尾找不到 scenes 数组的 "]"');
  const head = trimmed.slice(0, lastBracket).replace(/\s+$/, '');
  const comma = head.endsWith('[') ? '' : ',';
  return `${head}${comma}${NL}${scenesText}${NL}  ]${NL}}${NL}`;
}

function summarize(scenes, label) {
  const lines = scenes.reduce((n, s) => n + s.lines.length, 0);
  const keys = scenes.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.keyExpressions.length, 0), 0);
  const tips = scenes.reduce((n, s) => n + s.tipsZh.length, 0);
  console.log(`${label}：${scenes.length} 场景 / ${lines} 句 / ${keys} 关键表达 / ${tips} 小贴士`);
}

/* ---------- 主流程 ---------- */

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const positional = args.filter((a) => !a.startsWith('--'));
const targetPath = positional[checkOnly ? 0 : 1] || DEFAULT_TARGET;
const warnings = [];

const targetText = readFileSync(targetPath, 'utf8');
const target = JSON.parse(targetText);
const existing = Array.isArray(target.scenes) ? target.scenes : [];
NL = targetText.includes('\r\n') ? '\r\n' : '\n';   // 规则 9：沿用目标文件行尾符，避免 CRLF/LF 混用

if (checkOnly) {
  const kept = existing.map((s) => cleanScene(s, warnings)).filter(Boolean);
  summarize(kept, `校验 ${targetPath}`);
  warnings.forEach((w) => console.log(`  ⚠ ${w}`));
  console.log(warnings.length ? '⚠ 存在需要关注的条目（--check 不写入）' : '✅ 全部合规');
} else {
  const packPath = positional[0];
  if (!packPath) {
    console.error('用法：node tools/merge-dialogues.mjs <扩写包.json> [目标.json]');
    process.exit(1);
  }
  const pack = JSON.parse(readFileSync(packPath, 'utf8'));
  const packScenes = Array.isArray(pack.scenes) ? pack.scenes : [];
  const existingIds = new Set(existing.map((s) => (isFilledString(s && s.id) ? s.id.trim() : '')).filter(Boolean));
  const seenPackIds = new Set();
  const added = [];

  packScenes.forEach((raw) => {
    const scene = cleanScene(raw, warnings);
    if (!scene) return;
    if (seenPackIds.has(scene.id)) {
      warnings.push(`扩写包内重复 id ${scene.id}，已跳过`);
      return;
    }
    seenPackIds.add(scene.id);
    if (existingIds.has(scene.id)) {
      console.log(`  · 跳过已存在场景：${scene.id}（规则 8：不覆盖原内容）`);
      return;
    }
    added.push(scene);
  });

  if (!added.length) {
    console.log('没有需要新增的场景。');
  } else {
    const merged = appendScenes(targetText, added.map(renderScene).join(',' + NL));
    const parsed = JSON.parse(merged);                       // 规则 1：写盘前自检 JSON 合法
    if (!Array.isArray(parsed.scenes) || parsed.scenes.length !== existing.length + added.length) {
      throw new Error('合并结果场景数与预期不一致，已中止写入');
    }
    writeFileSync(targetPath, merged, 'utf8');
    console.log(`已追加 ${added.length} 个场景 → ${targetPath}`);
    summarize(added, '新增');
    summarize(parsed.scenes, '合并后总计');
  }

  warnings.forEach((w) => console.log(`  ⚠ ${w}`));
}


