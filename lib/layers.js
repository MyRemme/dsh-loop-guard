/**
 * dsh-loop-guard 四层监工内核（独立模块，可单测）
 *
 *   ① 采集 TraceStore   —— 轨迹、证据、预算
 *   ② 检测 Detector     —— 规则 + 可选模型，可插拔注册表
 *   ③ 仲裁 Arbiter      —— 融合多源判定，产出 WARN / BLOCK / STOP
 *   ④ 干预 Intervener   —— 按档位落地
 *
 * 设计前提：规则是廉价哨兵，模型是昂贵法官。
 * 规则只负责「发现可疑」，不直接决定惩罚强度；强度由仲裁层结合证据与累犯次数定。
 * 假阻断会毁掉真实工作，漏判只多花 token —— 默认向漏判倾斜。
 */

import { createHash } from "node:crypto";

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

function preview(value, maxChars) {
  let text;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (typeof text !== "string") text = String(text);
  // 先切出一个有界窗口再跑正则：输入可能是整个工具参数，而每次调用要跑三次，
  // 对完整文本做 /\s+/g 是白烧 CPU。窗口给到 4×上限，归一化后仍够截出 maxChars。
  const head = text.length > maxChars * 4 ? text.slice(0, maxChars * 4) : text;
  const flat = head.replace(/\s+/g, " ").trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`;
}

function clampText(text, maxChars) {
  const s = typeof text === "string" ? text : "";
  return s.length <= maxChars ? s : `${s.slice(0, maxChars)}…`;
}

/* ------------------------------------------------------------------ *
 * 观测摘要：把工具结果压成可比较的指纹
 *
 * 只比 action+input 的哈希区分不出「有效轮询」和「空转」：
 * 同一个命令反复跑，结果在变说明外部状态在推进，结果不变说明卡死了。
 * 监工必须看到这个差异，否则它拿到的「pwsh × 3」不构成任何判据。
 * ------------------------------------------------------------------ */

/** 从 tool result 的 content 块里取纯文本；非 text 块留一个占位标记。 */
export function resultText(result) {
  if (result === null || typeof result !== "object") return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (typeof block.type === "string") parts.push(`<${block.type}>`);
  }
  return parts.join("\n");
}

/**
 * 只剥离显式易变模式，绝不做模糊匹配。
 * 宁可误报「有变化」，也不能把真实变化压成「完全相同」——后者会制造假阳性阻断。
 */
const VOLATILE_PATTERNS = [
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g,
  /\b\d{2}:\d{2}:\d{2}\b/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b0x[0-9a-f]+\b/gi,
  /\b\d+(?:\.\d+)?\s?(?:ms|us|ns)\b/g,
  /\b\d+(?:\.\d+)?\s?s\b/g,
];

export function normalizeObservation(text) {
  let out = typeof text === "string" ? text : "";
  for (const re of VOLATILE_PATTERNS) out = out.replace(re, "«v»");
  return out.replace(/[ \t]+$/gm, "").replace(/\r\n/g, "\n").trim();
}

/** @returns {{hash: string, chars: number, empty: boolean, sample: string}} */
export function observationDigest(result) {
  const text = resultText(result);
  const normalized = normalizeObservation(text);
  const empty = normalized.length === 0;
  return {
    hash: empty ? "empty" : createHash("sha1").update(normalized).digest("hex").slice(0, 12),
    chars: text.length,
    empty,
    sample: preview(normalized, 240),
  };
}

/** 把一次 observation 压成给监工看的一句话。 */
export function observationNote(entry) {
  const digest = entry.digest;
  if (digest === undefined || digest === null) return "";
  if (digest.empty) return "结果为空";
  if (entry.sameAsPrev === true) return `结果与上次完全相同（${digest.chars} 字符）`;
  if (entry.oscillating === true) {
    const kinds = typeof digest.seenKinds === "number" ? digest.seenKinds : 2;
    return `结果在 ${kinds} 种取值间来回振荡（${digest.chars} 字符）`;
  }
  if (entry.sameAsPrev === false) return `结果有变化（${digest.chars} 字符）`;
  return `首次返回（${digest.chars} 字符）`;
}

/* ------------------------------------------------------------------ *
 * 周期检测：短语级 + 字符级
 * ------------------------------------------------------------------ */

/** 短语级相似：完全相同，或都很短且互为子串。 */
function similarPhrase(a, b) {
  if (a === b) return true;
  if (a.length === 0 || b.length === 0) return false;
  const max = 10;
  if (a.length <= max && b.length <= max) {
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    if (longer.includes(shorter) && shorter.length / longer.length >= 0.6) return true;
  }
  return false;
}

export function splitPhrases(text) {
  return String(text)
    .split(/[\n\r。！？!?；;，,、]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * 短语级周期检测：返回最短重复周期（以短语个数计）。
 *
 * repeats 只报**实际比对过**的周期数。早先这里返回 `Math.floor(n / p)`
 * —— n 是整个短语表长度，而比对至多进行 48 次，于是「我看了 48 个短语」
 * 会被写成「它重复了 200 次」。这个数字会进干预文案和监工简报，属于伪造证据。
 */
export function detectPhrasePeriod(phrases, minRepeats, maxPeriod) {
  const n = phrases.length;
  const upper = Math.min(maxPeriod, Math.floor(n / minRepeats));
  for (let p = 1; p <= upper; p++) {
    let compared = 0;
    let ok = true;
    for (let i = n - 1; i >= p; i--) {
      if (!similarPhrase(phrases[i], phrases[i - p])) {
        ok = false;
        break;
      }
      compared += 1;
      if (compared >= PHRASE_COMPARE_MAX) break;
    }
    if (ok && compared >= minRepeats * 2) {
      return { period: p, repeats: Math.floor((compared + 1) / p) };
    }
  }
  return null;
}

/** 一次检测最多比对多少个短语。 */
const PHRASE_COMPARE_MAX = 48;

/**
 * 字符级周期检测最少要验证多少字符。
 *
 * 早先 span 只按 `p * minRepeats` 取，p=2 时只比对 6 个字符 —— 任何以
 * 6 个以上相同字符结尾的正文（等号分隔线、一串句号、代码块边框）都会被
 * 判成整段周期重复，并一路升级到 STOP 切断输出。证据薄到那个程度不能定罪。
 */
const CHAR_VERIFY_MIN = 64;

/**
 * 字符级周期检测。逐字符比，不抽样 —— 抽样步进会跳过模板里唯一变化的
 * 那几个字符，「第32步…第33步…」这种正常推理会被判成死循环。
 *
 * 返回的 repeats 是**实际验证跨度**内成立的周期数，不是由全文长度推断的。
 */
export function detectCharPeriod(text, minRepeats, maxPeriod) {
  const n = text.length;
  if (n < CHAR_VERIFY_MIN) return null;
  const upper = Math.min(maxPeriod, Math.floor(n / minRepeats));
  for (let p = 2; p <= upper; p++) {
    const span = Math.min(n, Math.max(p * minRepeats, CHAR_VERIFY_MIN));
    const start = n - span;
    if (span < p * minRepeats) continue;
    let ok = true;
    for (let i = n - 1; i >= start + p; i--) {
      if (text[i] !== text[i - p]) {
        ok = false;
        break;
      }
    }
    if (ok) return { period: p, repeats: Math.floor(span / p) };
  }
  return null;
}

/** 增量文本窗口，负责节流与命中确认。 */
export class LoopWindow {
  constructor(cfg) {
    this.cfg = cfg;
    this.buf = "";
    this.sinceCheck = 0;
    this.lastKey = "";
    this.hits = 0;
  }

  push(text) {
    if (typeof text !== "string" || text.length === 0) return;
    this.buf += text;
    const limit = this.cfg.windowChars;
    if (this.buf.length > limit * 2) this.buf = this.buf.slice(this.buf.length - limit);
    this.sinceCheck += text.length;
  }

  shouldCheck() {
    if (this.sinceCheck < this.cfg.checkEveryChars) return false;
    this.sinceCheck = 0;
    return true;
  }

  detect() {
    const phrases = splitPhrases(this.buf);
    let hit = null;
    if (phrases.length >= this.cfg.minRepeats * 2) {
      const tail = phrases.slice(-Math.min(phrases.length, 240));
      const p = detectPhrasePeriod(tail, this.cfg.minRepeats, this.cfg.maxPhrasePeriod);
      if (p !== null) {
        hit = { kind: "phrase", period: p.period, repeats: p.repeats, sample: tail.slice(-Math.max(1, p.period)).join(" / ") };
      }
    }
    if (hit === null) {
      const c = detectCharPeriod(this.buf, this.cfg.minRepeats, this.cfg.maxCharPeriod);
      if (c !== null) hit = { kind: "char", period: c.period, repeats: c.repeats, sample: preview(this.buf.slice(-c.period), 120) };
    }
    if (hit === null) {
      this.hits = 0;
      this.lastKey = "";
      return null;
    }
    const key = `${hit.kind}:${hit.period}`;
    this.hits = key === this.lastKey ? this.hits + 1 : 1;
    this.lastKey = key;
    hit.hard = this.hits >= this.cfg.hardAfterHits;
    hit.hits = this.hits;
    return hit;
  }

  reset() {
    this.buf = "";
    this.sinceCheck = 0;
    this.lastKey = "";
    this.hits = 0;
  }
}

/* ------------------------------------------------------------------ *
 * 档位
 * ------------------------------------------------------------------ */

export const LEVEL = { WARN: "WARN", BLOCK: "BLOCK", STOP: "STOP" };
const RANK = { WARN: 1, BLOCK: 2, STOP: 3 };

export function maxLevel(a, b) {
  return (RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b;
}

/* ------------------------------------------------------------------ *
 * ① 采集：TraceStore
 * ------------------------------------------------------------------ */

const OBS_SEEN_MAX = 3;
const OBS_KEYS_MAX = 256;
// 计数表的 key 里带着最长 2000 字符的参数，给得比观测表宽一些但仍然封顶。
const TOOL_KEYS_MAX = 512;

/**
 * 真正的 LRU 写入。
 * Map.set 对**已存在**的 key 不会刷新插入顺序，所以直接 set 得到的是 FIFO：
 * 一个被反复使用的热 key 只要插入得早，照样会被淘汰 —— 它的计数于是从 1 重来，
 * 恰好在最长的会话里削弱重复检测。必须先 delete 再 set 才能移到队尾。
 */
function setBounded(map, key, value, max) {
  const limit = max === undefined ? OBS_KEYS_MAX : max;
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= limit) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

export class TraceStore {
  constructor(sessionId, cfg) {
    this.sessionId = sessionId;
    this.cfg = cfg;
    this.touchedAt = Date.now();

    // 轨迹
    this.recentTools = [];
    this.repeatLog = [];
    this.signals = [];

    // 证据
    this.toolCounts = new Map();
    this.lastObservation = new Map();
    this.observationSeen = new Map();
    this.obsStats = { stuck: 0, moving: 0, empty: 0, oscillating: 0 };

    // 预算
    this.stallSteps = 0;
    this.turnCount = 0;
    this.lastUserText = "";
    this.consultsThisTurn = 0;
    this.consultsTotal = 0;
    this.lastConsultAt = 0;
    this.consultInFlight = null;

    // 干预状态
    this.strikes = 0;
    this.pending = null;

    // 检测器私有状态，按 detector.id 存放
    this.detectorState = new Map();
  }

  touch() {
    this.touchedAt = Date.now();
  }

  noteSignal(id, label) {
    this.signals.push({ id, label, at: Date.now() });
    if (this.signals.length > 12) this.signals.shift();
  }

  resetToolChain() {
    this.toolCounts.clear();
    this.lastObservation.clear();
    this.observationSeen.clear();
    this.recentTools.length = 0;
    this.obsStats = { stuck: 0, moving: 0, empty: 0, oscillating: 0 };
    this.repeatLog.length = 0;
  }

  /**
   * 记录一次工具调用，返回本次观测判定。
   * @returns {{count: number, sameAsPrev: boolean|null, oscillating: boolean, digest: object}}
   */
  recordTool(callName, argsText, result) {
    const key = `${callName}|${argsText}`;
    const count = (this.toolCounts.get(key) ?? 0) + 1;
    // 计数表同样封顶：key 里带着最长 2000 字符的参数，不封顶就是线性泄漏。
    // 淘汰最久未动的 key，代价是它的计数从 1 重来 —— 判定只发生在最近的 key 上。
    setBounded(this.toolCounts, key, count, TOOL_KEYS_MAX);
    if (count === 1) this.stallSteps = 0; // 新动作 = 有进展

    const digest = observationDigest(result);
    const previous = this.lastObservation.get(key);
    const sameAsPrev = previous === undefined ? null : previous.hash === digest.hash;

    let seen = this.observationSeen.get(key);
    if (seen === undefined) {
      seen = new Set();
      setBounded(this.observationSeen, key, seen);
    }
    if (seen.size < OBS_SEEN_MAX) seen.add(digest.hash);
    // 只带出「取值种类数」这个快照数字，不要把活的 Set 挂到 digest 上：
    // digest 会存进 lastObservation，那样同一个 Set 就被两张表共同引用，
    // observationNote 读到的 size 变成「现在」的而不是当时的。
    digest.seenKinds = seen.size;

    const oscillating = sameAsPrev === false && count > 2 && seen.size <= 2 && !digest.empty;
    setBounded(this.lastObservation, key, digest);

    const entry = {
      name: callName,
      args: preview(argsText, 200),
      ok: result === null || typeof result !== "object" ? true : !result.isError,
      count,
      digest,
      sameAsPrev,
      oscillating,
    };
    this.recentTools.push(entry);
    if (this.recentTools.length > 16) this.recentTools.shift();

    // 聚合统计累加在窗口之外：滚动窗口会冲掉重复证据，统计会永远归零。
    if (digest.empty) this.obsStats.empty += 1;
    if (sameAsPrev === true) this.obsStats.stuck += 1;
    else if (oscillating) this.obsStats.oscillating += 1;
    else if (sameAsPrev === false) this.obsStats.moving += 1;

    if (count > 1) {
      this.repeatLog.push({ name: callName, count, empty: digest.empty, sameAsPrev, oscillating, sample: digest.sample });
      if (this.repeatLog.length > 24) this.repeatLog.shift();
    }

    return { key, count, sameAsPrev, oscillating, digest, entry };
  }

  clearPending() {
    const p = this.pending;
    this.pending = null;
    if (p !== null && p.counted) this.strikes = Math.max(0, this.strikes - 1);
    return p;
  }

  takePending() {
    const p = this.pending;
    this.pending = null;
    if (p !== null && !p.counted) {
      p.counted = true;
      this.strikes += 1;
    }
    return p;
  }
}

/* ------------------------------------------------------------------ *
 * ② 检测：规则注册表
 *
 * 每个检测器声明 enabled(cfg) 与 create(cfg)（每会话私有状态），
 * 两类入口：ingest（增量，流式）与 evaluate（一次性，工具/步骤）。
 * 返回值统一为 Signal：{level, confidence, reason, evidence, directive}
 * ------------------------------------------------------------------ */

function streamSignal(which, hit) {
  const who = which === "reasoning" ? "推理" : "正文";
  const mode = hit.kind === "phrase" ? "短语" : "字符";
  return {
    level: LEVEL.STOP,
    confidence: 0.85,
    reason: `${who}${mode}级周期重复：周期 ${hit.period}，重复约 ${hit.repeats} 次`,
    evidence: `样本「${preview(hit.sample, 120)}」`,
    directive: `停止${who}自我复述。用一句话说出已确认的事实，然后执行一个此前没做过的具体动作。`,
  };
}

export const DETECTORS = [
  {
    id: "stream-loop",
    label: "流式自我重复",
    enabled: (cfg) => cfg.detect.reasoningLoop || cfg.detect.textLoop,
    create: (cfg) => ({
      reasoning: cfg.detect.reasoningLoop ? new LoopWindow(cfg.detect) : null,
      text: cfg.detect.textLoop ? new LoopWindow(cfg.detect) : null,
    }),
    reset: (ds) => {
      if (ds.reasoning !== null) ds.reasoning.reset();
      if (ds.text !== null) ds.text.reset();
    },
    ingest(ds, ev) {
      const w = ev.which === "reasoning" ? ds.reasoning : ds.text;
      if (w === null || w === undefined) return null;
      w.push(ev.chunk);
      if (!w.shouldCheck()) return null;
      const hit = w.detect();
      if (hit === null || !hit.hard) return null;
      return streamSignal(ev.which === "reasoning" ? "reasoning" : "text", hit);
    },
  },
  {
    id: "tool-repeat",
    label: "工具调用重复",
    enabled: (cfg) => cfg.detect.toolRepeat,
    create: () => ({}),
    // 只看调用次数不足以定罪：同一个命令反复跑，可能是在等外部状态。
    // 所以这一层只负责「举手」，升不升级交给仲裁层和模型。
    evaluate({ view }) {
      if (view.phase !== "tool") return null;
      if (view.count < view.threshold) return null;
      const who = `${view.name}(${preview(view.args, 160)})`;
      return {
        level: LEVEL.WARN,
        confidence: 0.6,
        reason: `同一个调用 ${who} 已重复 ${view.count} 次`,
        evidence: `本轮观察：${view.note ?? "无"}`,
        directive: "若这是必要的轮询，在下一句话里说明你还在等什么；否则换参数、换工具，或直接给出结论。",
      };
    },
  },
  {
    id: "observation-stall",
    label: "观测无推进",
    enabled: (cfg) => cfg.detect.toolRepeat,
    create: () => ({}),
    evaluate({ view }) {
      if (view.phase !== "tool") return null;
      if (view.count < 2) return null;
      const who = `${view.name}(${preview(view.args, 160)})`;
      if (view.digest !== undefined && view.digest !== null && view.digest.empty) {
        return {
          level: LEVEL.WARN,
          confidence: 0.55,
          reason: `${who} 连续返回空结果`,
          evidence: `已调用 ${view.count} 次，结果均为空`,
          directive: "该调用没有任何产出。换一条能拿到信息的路径。",
        };
      }
      if (view.sameAsPrev === true && view.count >= view.threshold) {
        // 结果逐字节相同是确定性证据：不依赖模型也知道没有新信息。
        // 一路到 blockAt 还没换路，就直接升到 STOP。
        const ceiling = view.count >= view.blockAt;
        return {
          level: ceiling ? LEVEL.STOP : LEVEL.BLOCK,
          confidence: ceiling ? 0.95 : 0.9,
          reason: `${who} 第 ${view.count} 次返回与上次逐字节相同的结果`,
          evidence: `结果 ${view.digest.chars} 字符，规范化后哈希一致 —— 重复且无新信息`,
          directive: "这个调用已经不会再带来任何新信息。立即换路径，或直接给出结论。",
        };
      }
      if (view.oscillating === true && view.count >= view.threshold) {
        // 振荡与「逐字节相同」同级：都表示状态未推进。既然相同分支到 blockAt 会升
        // STOP，振荡也必须能升，否则真正的无限 A/B 循环永远停在 BLOCK。
        const ceiling = view.count >= view.blockAt;
        return {
          level: ceiling ? LEVEL.STOP : LEVEL.BLOCK,
          confidence: ceiling ? 0.9 : 0.8,
          reason: `${who} 的结果在两种取值之间来回振荡`,
          evidence: `已调用 ${view.count} 次，取值种类未增长 —— 看似在变，状态并未推进`,
          directive: "状态没有推进。立即换一条完全不同的路径。",
        };
      }
      return null;
    },
  },
  {
    id: "step-stall",
    label: "步骤停滞",
    enabled: (cfg) => cfg.detect.stepStall,
    create: () => ({}),
    evaluate({ store, cfg }) {
      if (store.stallSteps < cfg.detect.stepStallThreshold) return null;
      return {
        level: LEVEL.WARN,
        confidence: 0.55,
        reason: `连续 ${store.stallSteps} 步没有产生新的可验证结果`,
        evidence: `步数阈值 ${cfg.detect.stepStallThreshold}`,
        directive: "用一句话总结已确认的事实，然后执行一个此前没做过的具体动作；确实走不通就直接给出结论。",
      };
    },
  },
];

/** 跑一遍规则层。任何单个检测器抛错都不影响其它检测器。 */
export function runDetectors(store, cfg, view, onError) {
  const out = [];
  for (const d of DETECTORS) {
    let ok = false;
    try {
      ok = d.enabled(cfg);
    } catch {
      ok = false;
    }
    if (!ok) continue;
    let ds = store.detectorState.get(d.id);
    if (ds === undefined) {
      ds = d.create(cfg);
      store.detectorState.set(d.id, ds);
    }
    let sig = null;
    try {
      sig = typeof d.evaluate === "function" ? d.evaluate({ store, cfg, view, state: ds }) : null;
    } catch (error) {
      if (typeof onError === "function") onError(d.id, error);
      sig = null;
    }
    if (sig !== null && sig !== undefined) out.push({ ...sig, id: d.id, kind: d.id });
  }
  return out;
}

/** 流式增量入口，单独走 ingest。 */
export function ingestDetectors(store, cfg, ev, onError) {
  const out = [];
  for (const d of DETECTORS) {
    if (typeof d.ingest !== "function") continue;
    let ok = false;
    try {
      ok = d.enabled(cfg);
    } catch {
      ok = false;
    }
    if (!ok) continue;
    let ds = store.detectorState.get(d.id);
    if (ds === undefined) {
      ds = d.create(cfg);
      store.detectorState.set(d.id, ds);
    }
    let sig = null;
    try {
      sig = d.ingest(ds, ev, cfg);
    } catch (error) {
      if (typeof onError === "function") onError(d.id, error);
      sig = null;
    }
    if (sig !== null && sig !== undefined) out.push({ ...sig, id: d.id, kind: d.id });
  }
  return out;
}

export function resetDetectors(store) {
  for (const d of DETECTORS) {
    if (typeof d.reset !== "function") continue;
    const ds = store.detectorState.get(d.id);
    if (ds !== undefined) {
      try {
        d.reset(ds);
      } catch {
        /* 单个检测器重置失败不影响其它 */
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * ③ 仲裁：融合规则与模型
 *
 * 模型的价值是「撤回」而不是「加重」：规则容易误判合理轮询，
 * 模型的 working 判决可以推翻非 STOP 的规则命中。反过来模型不能把
 * 规则没发现的东西升到 STOP，避免它凭想象重罚。
 * ------------------------------------------------------------------ */

const MODEL_LEVEL = { slacking: LEVEL.WARN, looping: LEVEL.BLOCK, stuck: LEVEL.BLOCK };

/**
 * @returns {null | {level, verdict, confidence, reason, directive, evidence, signals, model}}
 */
export function arbitrate(signals, modelVerdict, strikes) {
  const rules = (signals ?? []).filter((s) => s !== null && s !== undefined && s.level !== undefined);
  if (rules.length === 0 && (modelVerdict === null || modelVerdict === undefined)) return null;

  const ranked = [...rules].sort((a, b) => (RANK[b.level] ?? 0) - (RANK[a.level] ?? 0));
  const top = ranked.length > 0 ? ranked[0] : null;

  let level = top === null ? LEVEL.WARN : top.level;

  if (modelVerdict !== null && modelVerdict !== undefined) {
    if (modelVerdict.verdict === "working") {
      // 监工说没偷懒：除非规则已经是 STOP 级，否则撤回。
      if (RANK[level] < RANK.STOP) return null;
    } else {
      const mapped = MODEL_LEVEL[modelVerdict.verdict] ?? LEVEL.WARN;
      level = maxLevel(level, mapped);
    }
  }

  // 屡犯升级：第 2 次至少 BLOCK，第 3 次直接 STOP。
  const next = strikes + 1;
  if (next >= 3) level = LEVEL.STOP;
  else if (next === 2) level = maxLevel(level, LEVEL.BLOCK);

  const modelReason = modelVerdict !== null && modelVerdict !== undefined ? modelVerdict.reason : "";
  const modelDirective = modelVerdict !== null && modelVerdict !== undefined ? modelVerdict.directive : "";

  return {
    level,
    verdict: (modelVerdict && modelVerdict.verdict) || (top && top.kind) || "looping",
    confidence: (modelVerdict && typeof modelVerdict.confidence === "number" ? modelVerdict.confidence : null)
      ?? (top ? top.confidence : 0.5),
    reason: modelReason || (top ? top.reason : "检测到空转"),
    directive: modelDirective || (top ? top.directive : "换一条不同的路径，或直接给出结论。"),
    evidence: rules.map((s) => `[${s.id}] ${s.evidence ? s.evidence : s.reason}`).join("；"),
    signals: rules,
    model: modelVerdict ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * ④ 干预：把档位渲染成给被监工模型看的话
 * ------------------------------------------------------------------ */

export function renderIntervention(level, decision, strikes) {
  const head = level === LEVEL.STOP
    ? `【监工干预 · 第 ${strikes} 次 · STOP】`
    : level === LEVEL.BLOCK
      ? `【监工阻断 · 第 ${strikes} 次 · BLOCK】`
      : `【监工提示${strikes > 0 ? ` · 第 ${strikes} 次` : ""} · WARN】`;

  // WARN 档什么都没打断，就不能说「已被打断」——被监工的模型会去找一个
  // 并不存在的断点，反而制造新的困惑。
  const body = level === LEVEL.WARN
    ? "检测到空转迹象。这一档只提醒，不做打断，你可以继续当前动作。"
    : "你在原地打转，已被打断。";

  const lines = [head, "", body, ""];
  if (decision !== null && decision !== undefined && decision.reason) lines.push(`诊断：${decision.reason}`);
  if (decision !== null && decision !== undefined && decision.evidence) lines.push(`证据：${clampText(decision.evidence, 400)}`);
  lines.push("");
  lines.push(`立即执行：${(decision && decision.directive) || "换一条完全不同的路径，或直接给出结论并说明卡在哪里。"}`);
  lines.push("");
  lines.push("不要复述任务，不要宣告计划，不要输出「好」「写」「执行」这类空转短语。直接调用工具，或直接给出结论。");
  if (strikes >= 2 && level !== LEVEL.STOP) {
    lines.push("");
    lines.push("这是重复违规。下一次触发将直接判定本次工具调用失败。");
  }
  return lines.join("\n");
}

export { RANK as LEVEL_RANK };
