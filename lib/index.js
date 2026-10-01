/**
 * dsh-loop-guard —— 多智能体监工。
 *
 * 一个**独立模型**扮演工头，实时盯着干活的主模型。三层检测：
 *   1. llm/stream         —— 推理/正文的短语级自我重复（那种「写。/执行。/好。」的死循环）
 *   2. tools/post-execute —— 同一工具同一参数的重复调用
 *   3. agent/pre-step     —— 连续多步没有产生新的可验证结果
 * 任一触发 → 本地立即止损（切断当前流）+ 咨询监工模型 → 拿回强制指令 →
 * 通过 agent.steer / PostToolDecision.block 把工人抽回正轨。
 *
 * 本插件只依赖 @deepseek-ai/schemastery，其余能力全部经 ctx 取得。
 */

import { createHash, randomUUID } from "node:crypto";
import {
  TraceStore,
  runDetectors,
  ingestDetectors,
  resetDetectors,
  arbitrate,
  renderIntervention,
  observationNote,
  LEVEL,
} from "./layers.js";
import Schema from "@deepseek-ai/schemastery";

const name = "dsh-loop-guard";
const inject = ["llm", "systemPrompt", "tools"];

/**
 * 消息源 kind。V4 会话格式只接受 producer 自己的 kind：`"plugin"` 是被退役的包装，
 * 一旦写进 user/message 或 agent/inbox/spliced 的 inserted，admission 直接抛
 * `format v4 message requires a producer-owned source kind`，整轮运行中断。
 * 迁移期产生过的 `plugin:<name>` 只在读取侧出现，产出侧一律用本插件的名字。
 */
const SOURCE_KIND = name;
const LEGACY_SOURCE_KINDS = ["plugin", `plugin:${name}`];

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  // 可编辑旋钮标在**嵌套叶子**上，不再做顶层别名。
  // 走过一次弯路：为迁就客户端 SettingsFormModel 的单段路径而把旋钮平铺到顶层并设
  // schema 默认值 —— 结果 ① 顶层默认值永远压过 cordis.patch.yml 的嵌套配置（配置被
  // 静默忽略）；② 去掉默认值后字段不再算「可编辑设置」，命名空间不再被服务，整行 UI 消失。
  // 嵌套叶子可以直接标 volatile（要求固定路径、不被外层 volatile 包住），
  // 而设置服务的 edit(section, op.path) 本来就按数组走路径。
  supervisorTemperature: Schema.number().default(0),

  supervisor: Schema.object({
    enabled: Schema.boolean().default(true).volatile(),
    provider: Schema.string().default("").volatile(),
    model: Schema.string().default("").volatile(),
    // provider / model 由顶层 volatile 字段决定，空值表示跟随当前模型。
    temperature: Schema.number().default(0),
    maxOutputChars: Schema.natural().default(4000),
    timeoutMs: Schema.natural().default(60000),
    system: Schema.string().default(""),
  }).default({}),

  detect: Schema.object({
    reasoningLoop: Schema.boolean().default(true),
    textLoop: Schema.boolean().default(true),
    windowChars: Schema.natural().default(6000),
    checkEveryChars: Schema.natural().default(120),
    minRepeats: Schema.natural().default(4),
    maxPhrasePeriod: Schema.natural().default(24),
    maxCharPeriod: Schema.natural().default(160),
    hardAfterHits: Schema.natural().default(2).volatile(),

    toolRepeat: Schema.boolean().default(true),
    toolRepeatThreshold: Schema.natural().default(3).volatile(),
    toolBlockAt: Schema.natural().default(5).volatile(),

    stepStall: Schema.boolean().default(true),
    stepStallThreshold: Schema.natural().default(30).volatile(),
  }).default({}),

  punish: Schema.object({
    cutStream: Schema.boolean().default(true).volatile(),
    blockRepeatTool: Schema.boolean().default(true).volatile(),
    steerOnStop: Schema.boolean().default(true),
    maxStrikes: Schema.natural().default(3),
    stopWaitMs: Schema.natural().default(8000),
  }).default({}),

  // 可见通知（第 ② 层：会话消息，用 agent.inject 投递，不唤醒回合）。
  notify: Schema.object({
    control: Schema.boolean().default(true).volatile(),
    working: Schema.boolean().default(false).volatile(),
  }).default({}),

  budget: Schema.object({
    cooldownMs: Schema.natural().default(20000),
    maxConsultsPerTurn: Schema.natural().default(3),
    maxConcurrent: Schema.natural().default(1),
    maxConsultsPerSession: Schema.natural().default(40),
    maxTrackedSessions: Schema.natural().default(128),
  }).default({}),
});

/* ------------------------------------------------------------------ *
 * 固定文案
 * ------------------------------------------------------------------ */

const DISCIPLINE_TEXT = [
  "## 反空转纪律（loop-guard 实时监工）",
  "",
  "一个独立的监工模型正在实时审阅你的推理文本与工具调用。四条触发条件：",
  "- 推理或正文出现短语级 / 字符级周期重复（同一句话反复说）；",
  "- 同一工具、同一参数被反复调用；",
  "- 同一调用的结果逐字节相同、在少数几种取值间振荡，或始终为空；",
  "- 连续多步没有产生新的可验证结果。",
  "",
  "监工分三档：**提示**（WARN，只提醒，不打断）、**阻断**（BLOCK，把这次工具调用判定为失败）、**干预**（STOP，截断输出并把强制指令塞回给你）。触发次数记录在案，屡犯会升级档位。",
  "",
  "因此：",
  "- 推理必须推进。不要复述任务，不要宣告「我现在要执行」然后不动手，不要用「好。」「写。」「执行。」「让我再想想」这类无信息量的短语填充上下文。",
  "- 同一工具、同一参数不要重复调用。确实需要重调时，先用一句话说明上一次的结果为什么不够。",
  "- 连续两次尝试没有带来新信息时，换一条完全不同的路径；如果确实走不通，直接给出结论并说明卡在哪里。",
  "- 禁止用空转话术延长输出。宁可输出一句「无法推进，原因是 X」，也不要输出二十行自我重复。",
].join("\n");

const DEFAULT_SUPERVISOR_SYSTEM = [
  "你是 dsh-loop-guard 的监工模型。唯一职责：判断一个正在工作的智能体是否陷入低效循环、偷懒或空转，并给出可执行的强制指令。",
  "",
  "你会收到该智能体最近的行为摘要：触发信号、推理文本尾部、最近的工具调用记录（含每次调用的结果摘要）、步骤计数。",
  "",
  "只输出一个 JSON 对象。不要解释，不要代码块围栏，不要多余文字。",
  '字段：{"verdict":"working|slacking|looping|stuck","confidence":0.0,"reason":"一句话中文诊断","directive":"给该智能体的强制指令"}',
  "",
  "verdict 判定：",
  "- working：有实质进展。重复只是必要的轮询或验证（例如等待构建完成）。",
  "- slacking：反复输出无信息量的短语、复述任务、宣称即将执行却不动手。",
  "- looping：同一推理片段或同一工具调用以近乎相同的形式重复出现。",
  "- stuck：连续多步没有产生任何新的文件改动、命令输出或结论。",
  "",
  "工具调用记录里每条都带结果判读，这是最关键的证据，务必据此区分几种表面相同的重复：",
  "- 标注「结果与上次完全相同」→ 重复调用且没有任何新信息，几乎确定是空转。",
  "- 标注「结果在 N 种取值间来回振荡」→ 看似每次都在变，但取值种类不增长，状态并未推进，同样按空转处理。",
  "- 标注「结果有变化」→ 外部状态确实在推进，属于有意轮询，不要判 looping。",
  "- 标注「结果为空」→ 该调用没有任何产出，无论调用几次都不构成进展。",
  "「重复调用记录」一节列出所有 count > 1 的调用及其结果判读；「判据提示」一节给出全局统计：相同结果次数多、变化次数为零，是 stuck 或 looping 的强证据；反之若变化次数可观，倾向 working。",
  "",
  "directive 必须能打破当前循环：要么指定一个完全不同的具体动作，要么要求立即停止当前路径并给出结论。禁止写「继续努力」「注意效率」这类空话。",
].join("\n");

const VERDICTS = new Set(["working", "slacking", "looping", "stuck"]);

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

/**
 * 取出 volatile 字段的真实值。
 *
 * 标了 `.volatile()` 的字段，cordis 交给插件的是带 `.get()` 的包装值
 * （schemastery 的 `isVolatile(value) → value.get()`），而手写在
 * cordis.patch.yml 补丁行里的则是普通 JSON —— 两种都要接受。
 *
 * 不拆包的后果是静默的：`typeof wrapper === "object"`，下面每个类型判定
 * 全部落空，配置一声不响地退回默认值。
 */
function unwrap(v) {
  if (v !== null && typeof v === "object" && typeof v.get === "function") {
    const inner = v.get();
    return inner === undefined ? undefined : inner;
  }
  return v;
}

function str(v, d) {
  const x = unwrap(v);
  return typeof x === "string" && x.length > 0 ? x : d;
}
function num(v, d) {
  const x = unwrap(v);
  return typeof x === "number" && Number.isFinite(x) ? x : d;
}
function nat(v, d) {
  const n = num(v, d);
  return n >= 0 ? Math.floor(n) : d;
}
function bool(v, d) {
  const x = unwrap(v);
  return typeof x === "boolean" ? x : d;
}

function notifyUser(agent, tag, body) {
  if (!agent || typeof agent.inject !== "function") return false;
  try {
    agent.inject(pluginMessage(body, tag));
    return true;
  } catch {
    return false;
  }
}

function normalizeConfig(raw) {
  const c = raw ?? {};
  const s = c.supervisor ?? {};
  const d = c.detect ?? {};
  const p = c.punish ?? {};
  const b = c.budget ?? {};

  const n = c.notify ?? {};
  // ------------------------------------------------------------------
  // volatile 字段现读，不能快照。
  //
  // cordis 处理设置写入时，只在 volatile 路径上跑 _commitVolatile()，对包装
  // 对象做 `target[Symbol(cosmokit.volatile.write)](nextValue)` —— 原地改写，
  // 并且**不会重新执行 apply**（`dsh-util-values` 的 updateVolatile 就是这个
  // 实现，config-editor 的注释也写明「serialized with Loader hot reload」）。
  //
  // 所以插件必须持有包装对象、在用的时候调 .get()。早先这里把值拷进普通快照，
  // UI 改完写进了包装对象而插件再也不看它 —— 于是每次调参都要重启才生效。
  // 下面这几个旋钮改成取值器，其余字段（改它们本来就需要重启重载模块）保持快照。
  // ------------------------------------------------------------------
  const liveThreshold = () => nat(d.toolRepeatThreshold, 3);
  const LIVE_FIELDS = {
    supervisor: {
      // 空字符串表示「不覆盖」——用户在 UI 里清空 provider/model 时回落到嵌套值/默认值。
      enabled: () => {
        const flat = unwrap(s.enabled);
        return flat === undefined ? bool(s.enabled, true) : flat === true;
      },
      provider: () => str(s.provider, ""),
      model: () => str(s.model, ""),
      temperature: () => num(s.temperature, 0),
    },
    detect: {
      toolRepeatThreshold: liveThreshold,
      // 提示阈值不得高于阻断阈值，否则 BLOCK 档被整段跳过：
      // 检测器的升级判据是 count >= threshold → BLOCK、count >= blockAt → STOP，
      // 若 threshold > blockAt，第一次命中就直接是 STOP。两者都是 Live 的，钳制也要现算。
      toolBlockAt: () => Math.max(liveThreshold(), nat(d.toolBlockAt, 5)),
      stepStallThreshold: () => nat(d.stepStallThreshold, 30),
      hardAfterHits: () => nat(d.hardAfterHits, 2),
    },
    punish: {
      cutStream: () => bool(p.cutStream, true),
      blockRepeatTool: () => bool(p.blockRepeatTool, true),
    },
    notify: {
      control: () => bool(n.control, true),
      working: () => bool(n.working, false),
    },
  };

  const cfg = {
    enabled: bool(c.enabled, true),
    supervisor: {
      // enabled / provider / model / temperature 由 LIVE_FIELDS 挂成取值器，
      // 以支持从设置界面即时开关模型监工、换模型。system 与预算类字段改它们
      // 本来就要重启，保持快照。
      maxOutputChars: nat(s.maxOutputChars, 4000),
      timeoutMs: nat(s.timeoutMs, 60000),
      system: str(s.system, ""),
    },
    detect: {
      reasoningLoop: bool(d.reasoningLoop, true),
      textLoop: bool(d.textLoop, true),
      windowChars: nat(d.windowChars, 6000),
      checkEveryChars: nat(d.checkEveryChars, 120),
      minRepeats: nat(d.minRepeats, 4),
      maxPhrasePeriod: nat(d.maxPhrasePeriod, 24),
      maxCharPeriod: nat(d.maxCharPeriod, 160),
      toolRepeat: bool(d.toolRepeat, true),
      stepStall: bool(d.stepStall, true),
    },
    punish: {
      steerOnStop: bool(p.steerOnStop, true),
      maxStrikes: nat(p.maxStrikes, 3),
      stopWaitMs: nat(p.stopWaitMs, 8000),
    },
    notify: { control: true, working: false },
    budget: {
      cooldownMs: nat(b.cooldownMs, 20000),
      maxConsultsPerTurn: nat(b.maxConsultsPerTurn, 3),
      maxConcurrent: nat(b.maxConcurrent, 1),
      maxConsultsPerSession: nat(b.maxConsultsPerSession, 40),
      maxTrackedSessions: nat(b.maxTrackedSessions, 128),
    },
  };

  // 把 volatile 旋钮挂成取值器。设置界面改完立即生效，不必重启。
  for (const group of Object.keys(LIVE_FIELDS)) {
    for (const key of Object.keys(LIVE_FIELDS[group])) {
      Object.defineProperty(cfg[group], key, {
        enumerable: true,
        configurable: true,
        get: LIVE_FIELDS[group][key],
      });
    }
  }

  return cfg;
}

function log(ctx, level, message) {
  try {
    const logger = ctx && ctx.logger;
    if (!logger) return;
    const fn = typeof logger[level] === "function" ? logger[level] : null;
    if (fn) fn.call(logger, `[loop-guard] ${message}`);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/**
 * 与 @deepseek-ai/dsh-util-values 的 deepFreeze 同语义：显式栈遍历 + WeakSet 去重。
 * AbortSignal / AbortController 必须跳过 —— 冻结它们会让 ctrl.abort() 抛
 * "Cannot assign to read only property 'Symbol(kAborted)'"，正是 llm/stream
 * options 里带 signal 时最致命的那种崩。
 */
function deepFreeze(value) {
  const seen = new WeakSet();
  const pending = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== "object") continue;
    if (node instanceof AbortSignal || node instanceof AbortController) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    Object.freeze(node);
    for (const key of Object.keys(node)) pending.push(node[key]);
  }
  return value;
}

function anySignal(signals) {
  const list = signals.filter((s) => s !== undefined && s !== null);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  const ctrl = new AbortController();
  for (const s of list) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

/** 手搓 user 消息：本地插件 import 不到 createUserMessage。 */
function pluginMessage(text, summary) {
  const raw = summary === undefined ? "loop-guard" : String(summary);
  return {
    id: `loop-guard-${randomUUID()}`,
    role: "user",
    content: [{ type: "text", text }],
    source: {
      kind: SOURCE_KIND,
      plugin: name,
      form: "notice",
      // 摘要会写进持久日志，按 CONTEXT_SUMMARY_MAX_CHARS 截断。
      summary: raw.length <= 120 ? raw : `${raw.slice(0, 119)}…`,
    },
  };
}

/** 本插件自己产生的消息（含历史会话里 kind: "plugin" 的旧消息）。 */
function isOwnMessage(source) {
  if (source === null || typeof source !== "object") return false;
  if (source.plugin === name) return true;
  return LEGACY_SOURCE_KINDS.includes(source.kind);
}

function isHumanMessage(message) {
  if (message === null || typeof message !== "object") return false;
  if (message.role !== "user") return false;
  const source = message.source;
  if (source === null || typeof source !== "object") return true;
  return !isOwnMessage(source);
}

function messageText(message) {
  if (message === null || typeof message !== "object") return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b !== null && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function preview(value, maxChars) {
  let text;
  try {
    text = typeof value === "string" ? value : canonicalJson(value);
  } catch {
    text = String(value);
  }
  if (typeof text !== "string") return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** 保留换行的截断。 */
function clampLines(text, maxChars) {
  const s = String(text ?? "").trim();
  return s.length <= maxChars ? s : `${s.slice(0, maxChars)}…`;
}

function clampText(text, maxChars) {
  const s = String(text ?? "");
  if (s.length <= maxChars) return s;
  const head = s.slice(0, Math.floor(maxChars * 0.35));
  const tail = s.slice(s.length - Math.ceil(maxChars * 0.65));
  return `${head}\n…（中间省略 ${s.length - maxChars} 字符）…\n${tail}`;
}

/* ------------------------------------------------------------------ *
 * observation 摘要
 *
 * 只比 action+input 的哈希，区分不出「有效轮询」和「空转」：同一个命令
 * 反复跑，结果在变说明外部状态在推进，结果不变说明卡死了。监工必须看到
 * 这个差异，否则它拿到的「pwsh × 3」不构成任何判据。
 * ------------------------------------------------------------------ */

// 观测摘要（resultText / VOLATILE_PATTERNS / normalizeObservation / observationDigest）
// 与振荡跟踪都住在 ./layers.js 的 TraceStore 里。这里不再保留副本：
// 这两份已经漂移过 —— index.js 的 VOLATILE_PATTERNS 是 [正则, 替换串] 对，
// layers.js 的是纯正则数组，同一份输入会算出不同哈希。

// observationNote 由 ./layers.js 提供，见顶部 import。

// 周期检测（短语级 / 字符级）已整体迁到 ./layers.js。
// 那边的实现是调优过的原版，不要在这里再留一份：两份实现必然漂移，
// 而漂移的表现是「某一类循环悄悄不再被抓到」，从日志上看不出来。


/* ------------------------------------------------------------------ *
 * 会话状态
 * ------------------------------------------------------------------ */

/**
 * 会话状态：四层内核的轨迹、证据、预算全部收在 TraceStore 里。
 * 这里只把旧调用点用到的名字接回去，避免逐个 hook 重写调用签名。
 */
const STREAM_DETECTOR_ID = "stream-loop";

class GuardState extends TraceStore {
  /**
   * 推理/正文窗口不能用字段持有。
   *
   * 窗口状态住在检测器的私有 state 里（detectorState），而检测器是懒创建的 ——
   * 构造时那份还不存在。早先这里各建了一个 LoopWindow，结果是流式检测往检测器
   * 的窗口写、简报却去读这个孤儿窗口，buildBrief 的「最近推理/正文尾部」永远是
   * 「（无）」—— 恰好把监工最依赖的判据（模型在想什么）整段丢掉了。
   * 用取值器直接指向检测器那一份，创建时机就无关了。
   */
  get reasoning() {
    const ds = this.detectorState.get(STREAM_DETECTOR_ID);
    return ds === undefined ? null : ds.reasoning ?? null;
  }

  get text() {
    const ds = this.detectorState.get(STREAM_DETECTOR_ID);
    return ds === undefined ? null : ds.text ?? null;
  }

  resetLoops() {
    resetDetectors(this);
  }

  /**
   * 立即上膛：不等监工返回，保证 turn-stopping 一定拿得到干预文本。
   *
   * `turn` 记录这条干预属于哪个回合。监工最长要 60s 才返回，而收工点只等
   * stopWaitMs（默认 8s），所以判决晚归是常态 —— 没有回合归属，上一個回合的
   * 诊断就会被注入到下一个回合。
   */
  armStrike(label, verdict, turn) {
    if (this.pending !== null) return;
    // 统一走 renderIntervention，兜底文案与仲裁文案必须同格式，
    // 否则同一档位会出现两种抬头，被监工的主模型读到会当成两次不同干预。
    const decision = {
      level: LEVEL.WARN,
      verdict: (verdict && verdict.verdict) || "looping",
      confidence: verdict && typeof verdict.confidence === "number" ? verdict.confidence : 0.6,
      reason: (verdict && verdict.reason) || label,
      directive: (verdict && verdict.directive) || "",
      evidence: label,
    };
    this.pending = {
      level: decision.level,
      decision,
      text: renderIntervention(decision.level, decision, this.strikes + 1),
      verdict: decision,
      label,
      counted: false,
      turn: turn === undefined ? this.turnCount : turn,
    };
  }

  clearStrike() {
    return this.clearPending();
  }

  takeStrike() {
    return this.takePending();
  }

  get strike() {
    return this.pending;
  }

  set strike(value) {
    this.pending = value;
  }
}

/* ------------------------------------------------------------------ *
 * 监工调用
 * ------------------------------------------------------------------ */

const REVIEWER_CALLS = new WeakSet();
const REVIEWER = Symbol("loop-guard.reviewer");

async function collectText(stream, maxChars) {
  let text = "";
  let reasoning = "";
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== "object") continue;
    if (chunk.type === "text-delta") text += chunk.text;
    else if (chunk.type === "reasoning-delta") reasoning += chunk.text;
    else if (chunk.type === "block-end") {
      const block = chunk.block;
      if (block && block.type === "text" && text.length === 0) text = block.text;
      else if (block && block.type === "reasoning" && reasoning.length === 0) reasoning = block.text;
    }
    if (text.length + reasoning.length > maxChars * 8) break;
  }
  return { text, reasoning };
}

function parseVerdict(raw) {
  const cleaned = String(raw ?? "").trim();
  if (cleaned.length === 0) return null;
  const candidates = [];
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  const braced = cleaned.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);
  candidates.push(cleaned);
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate.trim());
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const verdict = String(parsed.verdict ?? "").toLowerCase().trim();
    if (!VERDICTS.has(verdict)) continue;
    const confidence = num(parsed.confidence, verdict === "working" ? 0.5 : 0.7);
    return {
      verdict,
      confidence: Math.min(1, Math.max(0, confidence)),
      // 用 clampLines 而不是 preview：preview 会把换行压成空格，而 directive
      // 常常是多步指令，压平之后监工写的有序步骤就变成一坨。
      reason: clampLines(parsed.reason ?? "", 400),
      directive: clampLines(parsed.directive ?? "", 800),
    };
  }
  return null;
}

function buildBrief(state, trigger) {
  const lines = [];
  lines.push("## 触发信号");
  if (state.signals.length === 0) lines.push("- （无历史信号）");
  else for (const s of state.signals.slice(-6)) lines.push(`- ${s.label}`);
  lines.push("");
  lines.push("## 本次触发");
  lines.push(`- ${trigger}`);
  lines.push("");
  lines.push("## 最近用户指令");
  lines.push(clampText(state.lastUserText || "（无）", 600));
  lines.push("");
  lines.push("## 最近推理/正文尾部");
  const tails = [];
  if (state.reasoning !== null && state.reasoning.buf.length > 0) tails.push(state.reasoning.buf);
  if (state.text !== null && state.text.buf.length > 0) tails.push(state.text.buf);
  lines.push(clampText(tails.join("\n---\n"), 1800) || "（无）");
  lines.push("");
  lines.push("## 最近工具调用");
  if (state.recentTools.length === 0) lines.push("（无）");
  else {
    for (const t of state.recentTools.slice(-12)) {
      const note = observationNote(t);
      lines.push(`- ${t.name}(${t.args}) → ${t.ok ? "ok" : "error"}（同一调用累计 ${t.count} 次）${note.length > 0 ? `｜${note}` : ""}`);
    }
  }
  lines.push("");
  lines.push("## 重复调用记录（判定核心证据）");
  if (state.repeatLog.length === 0) lines.push("（无重复调用）");
  else {
    for (const r of state.repeatLog.slice(-10)) {
      const verdict = r.empty
        ? "结果为空 → 无产出"
        : r.sameAsPrev === true
          ? "结果与上次完全相同 → 重复且无新信息"
          : r.oscillating === true
            ? "结果在两种取值间振荡 → 状态未推进"
            : r.sameAsPrev === false
              ? "结果有变化 → 外部状态在推进"
              : "（首次）";
      lines.push(`- ${r.name} × ${r.count}｜${verdict}`);
      if (!r.empty && typeof r.sample === "string" && r.sample.length > 0) {
        lines.push(`    结果片段：${clampText(r.sample, 200)}`);
      }
    }
  }
  lines.push("");
  lines.push("## 判据提示");
  const s = state.obsStats;
  lines.push(`- 结果与上次完全相同的调用：${s.stuck} 次${s.stuck > 0 ? "（重复且无新信息 → 高度疑似空转）" : ""}`);
  lines.push(`- 结果在少数几种取值间来回振荡的调用：${s.oscillating} 次${s.oscillating > 0 ? "（看似有变化，实则状态未推进）" : ""}`);
  lines.push(`- 结果发生变化的调用：${s.moving} 次${s.moving > 0 ? "（外部状态在推进 → 可能是有意轮询）" : ""}`);
  lines.push(`- 返回空结果的调用：${s.empty} 次${s.empty > 0 ? "（无任何产出）" : ""}`);
  lines.push("");
  lines.push("## 计数");
  lines.push(`- turn ${state.turnCount} / 距上次新动作 ${state.stallSteps} 步`);
  lines.push(`- 本回合已咨询监工 ${state.consultsThisTurn} 次`);
  lines.push(`- 累计强制干预 ${state.strikes} 次`);
  lines.push("");
  lines.push("现在输出你的 JSON 判决。");
  return lines.join("\n");
}

/**
 * 监工走哪条路由。
 *
 * 显式配置优先；留空则**解析**宿主的当前模型，而不是干脆不传。实测不传
 * provider/model 时 ctx.llm.stream 一个字符都不产出，监工永远判成「不可用」——
 * 模型层等于不存在，而且每触发一次就发一条失败通知。
 *
 * 宿主暴露的是 agentDefaultModel 服务的 currentSelection()。软取（不写进 inject）：
 * 这个包不在时插件仍要能以纯规则模式工作。
 */
function resolveRoute(ctx, cfg) {
  if (cfg.supervisor.provider.length > 0 && cfg.supervisor.model.length > 0) {
    return { provider: cfg.supervisor.provider, model: cfg.supervisor.model };
  }
  try {
    const svc = ctx.get("agentDefaultModel");
    if (svc !== undefined && svc !== null && typeof svc.currentSelection === "function") {
      const sel = svc.currentSelection();
      if (sel !== null && typeof sel === "object"
        && typeof sel.provider === "string" && sel.provider.length > 0
        && typeof sel.model === "string" && sel.model.length > 0) {
        return { provider: sel.provider, model: sel.model };
      }
    }
  } catch {
    /* 解析不到就交回宿主默认，不因可选增强而失败 */
  }
  return {};
}

async function consultSupervisor(ctx, cfg, state, trigger, signal) {
  // provider/model 留空 = 跟随当前模型：此时**不传**这两个键，让宿主用它当前
  // 选定的模型。传空字符串会被当成一个真的 provider 名，比不传更糟。
  // 这样用户换主模型时监工自动跟着换，不需要谁去改配置里的模型名。
  const route = resolveRoute(ctx, cfg);
  const options = deepFreeze({
    ...route,
    [REVIEWER]: true,
    system: cfg.supervisor.system.length > 0 ? cfg.supervisor.system : DEFAULT_SUPERVISOR_SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text: buildBrief(state, trigger) }] }],
    temperature: cfg.supervisor.temperature,
    signal,
  });
  REVIEWER_CALLS.add(options);
  try {
    const collected = await collectText(ctx.llm.stream(options), cfg.supervisor.maxOutputChars);
    const raw = collected.text.length > 0 ? collected.text : collected.reasoning;
    const verdict = parseVerdict(raw);
    if (verdict === null) {
      // 答非所问必须和「调不通」区分开。原先这里静默返回 null，调用方沿用兜底判决，
      // 而按设计兜底会把规则 WARN 升级到 BLOCK —— 于是「监工话多、不守 JSON 格式」
      // 会表现为「行为莫名变凶」，日志里却一片安静，查不到原因。
      throw new Error(
        `监工返回无法解析的判决（${raw.length} 字符，已按不可用处理）：${preview(raw, 160)}`,
      );
    }
    return verdict;
  } finally {
    REVIEWER_CALLS.delete(options);
  }
}

/* ------------------------------------------------------------------ *
 * 兜底判决：监工不可用（超时 / 报错 / 未配置）时的规则侧结论
 * 渲染统一交给 ./layers.js 的 renderIntervention
 * ------------------------------------------------------------------ */

function fallbackVerdict(kind) {
  if (kind === "tool-repeat") {
    return {
      verdict: "looping",
      confidence: 0.6,
      reason: "同一工具、同一参数被反复调用",
      directive: "停止重复调用该工具。说明上一次结果为什么不够，然后改用不同的参数、不同的工具，或直接给出结论。",
    };
  }
  if (kind === "step-stall") {
    return {
      verdict: "stuck",
      confidence: 0.6,
      reason: "连续多步没有产生新的可验证结果",
      directive: "停止当前路径。用一句话总结已经确认的事实，然后执行一个此前没做过的具体动作；如果确实走不通，直接给出结论并说明卡在哪里。",
    };
  }
  return {
    verdict: "looping",
    confidence: 0.6,
    reason: "推理文本出现周期性自我重复",
    directive: "立即停止当前的自我复述。用一句话说出你已经确认的事实，然后执行一个此前没做过的具体动作。",
  };
}

/* ------------------------------------------------------------------ *
 * apply
 * ------------------------------------------------------------------ */

function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig);
  if (!cfg.enabled) return;

  /** @type {Map<string, GuardState>} */
  const guards = new Map();
  const runtime = { inflight: 0 };
  const lifecycle = new AbortController();

  function pruneGuards() {
    if (guards.size <= cfg.budget.maxTrackedSessions) return;
    const entries = [...guards.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    const drop = guards.size - cfg.budget.maxTrackedSessions;
    for (let i = 0; i < drop; i++) guards.delete(entries[i][0]);
  }

  function guardFor(sessionId) {
    const id = String(sessionId ?? "");
    if (id.length === 0) return null;
    let state = guards.get(id);
    if (state === undefined) {
      state = new GuardState(id, cfg);
      guards.set(id, state);
      pruneGuards();
    }
    state.touch();
    return state;
  }

  function budgetAllows(state) {
    if (!cfg.supervisor.enabled) return false;
    if (runtime.inflight >= cfg.budget.maxConcurrent) return false;
    if (state.consultsTotal >= cfg.budget.maxConsultsPerSession) return false;
    if (state.consultsThisTurn >= cfg.budget.maxConsultsPerTurn) return false;
    if (Date.now() - state.lastConsultAt < cfg.budget.cooldownMs) return false;
    return true;
  }

  /**
   * 咨询监工。先立即上膛兜底干预，监工返回后按判决替换或撤销。
   *
   * `signals` 必须由调用方在触发当场传进来，不能回头去读共享状态：
   * 这个函数要 await 模型（最长 timeoutMs），期间别的路径早已把共享变量覆盖掉，
   * 结果就是「推理死循环触发的干预，文案却在说某个 grep 调用」，档位也会被改。
   *
   * @returns {Promise<object|null>|null} 预算不足时返回 null
   */
  function triggerConsult(state, kind, label, signal, signals) {
    if (state.consultInFlight !== null) return state.consultInFlight;
    if (!budgetAllows(state)) {
      // 监工被显式关掉 ≠ 预算耗尽：前者是用户自己选的纯规则模式，报成「跳过咨询」
      // 等于把用户的配置说成插件出了故障。
      if (cfg.supervisor.enabled && cfg.notify.control && state.budgetNotifiedTurn !== state.turnCount) {
        state.budgetNotifiedTurn = state.turnCount;
        const lines = [
          "[监工跳过咨询]",
          "",
          `本轮检测到异常（${label}），但监工预算已用尽，这一回合不再调用监工模型。`,
          "",
          "只走了规则检测：档位由规则自行判定，没有被模型撤回或加重。",
        ];
        notifyUser(state.agent, "监工跳过", lines.join("\n"));
      }
      return null;
    }

    state.lastConsultAt = Date.now();
    state.consultsThisTurn += 1;
    state.consultsTotal += 1;
    runtime.inflight += 1;

    const own = Array.isArray(signals) ? signals : [];
    const fallback = fallbackVerdict(kind);
    // 回合号必须在触发当场取：函数体后半段 await 完模型时，turnCount 已经翻页了。
    const turnAtTrigger = state.turnCount;
    state.armStrike(label, fallback, turnAtTrigger);

    let tracked = null;
    tracked = (async () => {
      let verdict = fallback;
      try {
        const timeoutCtrl = new AbortController();
        const timer = setTimeout(
          () => timeoutCtrl.abort(new Error("loop-guard: supervisor timeout")),
          cfg.supervisor.timeoutMs,
        );
        if (typeof timer.unref === "function") timer.unref();
        try {
          const combined = anySignal([lifecycle.signal, timeoutCtrl.signal, signal]);
          const result = await consultSupervisor(ctx, cfg, state, label, combined);
          if (result !== null) verdict = result;
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        log(ctx, "warn", `监工调用失败，保留本地兜底判决：${error && error.message ? error.message : String(error)}`);
        if (cfg.notify.control) {
          const why = error && error.message ? error.message : String(error);
          notifyUser(state.agent, "监工异常", ["[监工调用失败]", "", `监工模型没有返回判决（${why}），已保留本地兜底判决。`, "", "这一次的档位完全由规则决定，模型的撤回/加重没有生效。"].join("\n"));
        }
      }

      state.lastConsultAt = Date.now();

      // ③ 仲裁：本次触发自己的规则信号 + 模型判决 → 最终档位。
      // 模型是「撤回者」而不是「加重者」：它可以把规则误判的合理轮询压下去，
      // 但不能凭想象把规则没发现的东西升到 STOP。
      const decision = arbitrate(own, verdict, state.strikes);

      if (decision === null) {
        const dropped = state.clearStrike();
        // 软重置：只清命中计数，保留窗口里的推理原文 —— 简报的
        // 「最近推理/正文尾部」正是读它，清掉就等于把监工最依赖的判据抹了。
        softResetDetectors(state);
        log(
          ctx,
          "info",
          `监工判定 working（置信 ${verdict.confidence}）：${verdict.reason}${dropped ? "（撤销兜底干预）" : ""}`
            + `${own.length > 0 ? `；撤回 ${own.length} 条规则信号` : ""}`,
        );
        if (cfg.notify.working) {
          const why = own.length > 0 ? `已撤回 ${own.length} 条规则信号。` : "本次没有规则信号需要撤回。";
          const lines = [
            "[监工判定 working]",
            "",
            `监工看过本轮证据，认为这是在推进而非空转（置信 ${verdict.confidence}）。`,
            "",
            `理由：${verdict.reason}`,
            "",
            why,
            dropped ? "并撤销了先前上膛的兜底干预。" : "",
          ].filter((x) => x !== "");
          notifyUser(state.agent, "监工判定", lines.join("\n"));
        }
        return verdict;
      }

      // ④ 干预：按档位渲染。WARN 只提示，BLOCK 判失败，STOP 强制打断。
      state.pending = {
        level: decision.level,
        decision,
        text: renderIntervention(decision.level, decision, state.strikes + 1),
        verdict: decision,
        label,
        counted: false,
        turn: turnAtTrigger,
      };
      softResetDetectors(state);
      log(
        ctx,
        "info",
        `仲裁 ${decision.level}（${decision.verdict}，置信 ${decision.confidence}）：${decision.reason}`
          + `｜规则信号 ${own.length} 条`,
      );
      return verdict;
    })()
      .catch(() => null)
      .finally(() => {
        runtime.inflight = Math.max(0, runtime.inflight - 1);
        if (state.consultInFlight === tracked) state.consultInFlight = null;
      });

    state.consultInFlight = tracked;
    return tracked;
  }

  function waitForConsult(state, ms) {
    const inflight = state.consultInFlight;
    if (inflight === null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === "function") timer.unref();
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      inflight.then(done, done);
    });
  }

  /* ---------------- 1. 流式自我重复 ---------------- */

  function guardStream(state, downstream) {
    return (async function* guarded() {
      for await (const chunk of downstream) {
        if (chunk !== null && typeof chunk === "object") {
          try {
            let which = null;
            let text = null;
            if (chunk.type === "reasoning-delta") {
              which = "reasoning";
              text = chunk.text;
            } else if (chunk.type === "text-delta") {
              which = "text";
              text = chunk.text;
            } else if (chunk.type === "block-end" && chunk.block && typeof chunk.block.text === "string") {
              which = chunk.block.type === "reasoning" ? "reasoning" : "text";
              text = chunk.block.text;
            }
            if (which !== null) {
              // ② 检测（增量入口）：节流与命中确认都由检测器自己管。
              const signals = ingestDetectors(
                state,
                cfg,
                { which, chunk: text },
                (id, error) => log(ctx, "warn", `检测器 ${id} 异常（已忽略）：${error && error.message ? error.message : String(error)}`),
              );
              if (signals.length > 0) {
                for (const s of signals) state.noteSignal(s.kind, s.reason);

                // ③ 仲裁（规则侧）：流式命中的规则信号本身已经是 STOP 级。
                const ruleDecision = arbitrate(signals, null, state.strikes);
                const label = ruleDecision !== null ? ruleDecision.reason : signals[0].reason;

                // 自己先上膛，再咨询。这样切流只看**本次**判决，
                // 不再依赖全局 pending 槽 —— 那个槽可能正装着别的路径的判决。
                if (ruleDecision !== null && ruleDecision.level === LEVEL.STOP && state.pending === null) {
                  state.pending = {
                    level: ruleDecision.level,
                    decision: ruleDecision,
                    text: renderIntervention(ruleDecision.level, ruleDecision, state.strikes + 1),
                    verdict: ruleDecision,
                    label,
                    counted: false,
                    turn: state.turnCount,
                  };
                }

                triggerConsult(state, "stream-loop", label, undefined, signals);

                if (cfg.punish.cutStream && ruleDecision !== null && ruleDecision.level === LEVEL.STOP) {
                  log(ctx, "info", `切断 ${state.sessionId} 的输出流（${ruleDecision.level}）：${label}`);
                  return;
                }
              }
            }
          } catch (error) {
            log(ctx, "warn", `流内检测异常（已忽略）：${error && error.message ? error.message : String(error)}`);
          }
        }
        yield chunk;
      }
    })();
  }

  ctx.on("llm/stream", (options, next) => {
    const downstream = next();
    if (!cfg.detect.reasoningLoop && !cfg.detect.textLoop) return downstream;
    if (options === null || typeof options !== "object") return downstream;
    if (REVIEWER_CALLS.has(options) || options[REVIEWER] === true) return downstream;
    if (cfg.supervisor.provider.length > 0 && cfg.supervisor.model.length > 0
      && options.provider === cfg.supervisor.provider && options.model === cfg.supervisor.model) return downstream;
    const sessionId = options.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) return downstream;
    const state = guardFor(sessionId);
    if (state === null) return downstream;
    return guardStream(state, downstream);
  });

  /* ---------------- 2. 工具重复 ---------------- */

  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (decision.kind === "block") return decision;
    const agent = exec.agent;
    if (!agent || !agent.session) return decision;
    const state = guardFor(agent.session.id);
    if (state === null) return decision;
    state.agent = agent;

    // ① 采集：轨迹 + 证据 + 预算一次落库，返回本次观测判定。
    const rec = state.recordTool(exec.name, preview(exec.arguments, 2000), result);
    const { count, sameAsPrev, oscillating, digest, entry } = rec;

    // ② 检测：规则层跑一遍，拿到全部信号。规则只负责「发现可疑」，不决定惩罚强度。
    const signals = runDetectors(
      state,
      cfg,
      {
        phase: "tool",
        name: exec.name,
        args: preview(exec.arguments, 160),
        count,
        threshold: cfg.detect.toolRepeatThreshold,
        blockAt: cfg.detect.toolBlockAt,
        sameAsPrev,
        oscillating,
        digest,
        note: observationNote(entry),
      },
      (id, error) => log(ctx, "warn", `检测器 ${id} 异常（已忽略）：${error && error.message ? error.message : String(error)}`),
    );
    if (signals.length === 0) return decision;

    for (const s of signals) state.noteSignal(s.kind, s.reason);

    // ③ 仲裁（规则侧）：不等模型先出结果，保证 turn-stopping 拿得到干预文本。
    const ruleDecision = arbitrate(signals, null, state.strikes);
    if (ruleDecision === null) return decision;

    // 先把规则判决上膛。triggerConsult 内部的 armStrike 见到已上膛会直接跳过，
    // 于是兜底文案与真正生效的档位一致 —— 否则 BLOCK 会被通用兜底盖成 WARN。
    if (ruleDecision.level !== LEVEL.WARN && state.pending === null) {
      state.pending = {
        level: ruleDecision.level,
        decision: ruleDecision,
        text: renderIntervention(ruleDecision.level, ruleDecision, state.strikes + 1),
        verdict: ruleDecision,
        label: ruleDecision.reason,
        counted: false,
        turn: state.turnCount,
      };
    }

    // 模型作为可选第二信源：预算允许时咨询，返回后由仲裁层融合并可能撤回。
    triggerConsult(state, "tool-repeat", ruleDecision.reason, exec.signal, signals);

    if (ruleDecision.level === LEVEL.WARN) {
      const firstTime = count === cfg.detect.toolRepeatThreshold || (digest.empty && count === 2);
      if (!firstTime) return decision;
      const note = observationNote(entry);
      // 与其余四处一致传 strikes + 1：这条提示如果被采信就是下一次干预，
      // 传 state.strikes 会让同一时刻的 WARN 和 BLOCK 抬头差一位。
      const body = renderIntervention(LEVEL.WARN, ruleDecision, state.strikes + 1);
      // 证据行里通常已经带着同一句观察结论（tool-repeat 的 evidence 就是它），
      // 再追加一遍会让被监工的模型把同一件事读成两条独立证据。
      const notice = pluginMessage(
        note.length > 0 && !body.includes(note) ? `${body}\n\n本次结果：${note}。` : body,
        `${exec.name} × ${count}`,
      );
      return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), notice] };
    }

    // ④ 干预（BLOCK / STOP）：本次工具调用直接判定失败。
    if (cfg.punish.blockRepeatTool) {
      const strike = state.takeStrike();
      const text = strike !== null
        ? strike.text
        : renderIntervention(ruleDecision.level, ruleDecision, state.strikes + 1);
      log(ctx, "info", `阻断重复工具调用：${exec.name} × ${count}（${ruleDecision.level}）`);
      return {
        kind: "block",
        feedback: [{ type: "text", text }],
        additionalContexts: [pluginMessage(text, `${exec.name} × ${count} 已阻断`)],
      };
    }

    return decision;
  });

  /* ---------------- 3. 步骤停滞 / 链条重置 ---------------- */

  ctx.on("agent/pre-step", async ({ agent, messages, turn, signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject") return decision;
    if (!agent || !agent.session) return decision;
    const state = guardFor(agent.session.id);
    if (state === null) return decision;
    state.agent = agent;

    if (turn !== state.turnCount) {
      state.turnCount = turn;
      state.consultsThisTurn = 0;
    }
    state.resetLoops();

    const claimed = Array.isArray(messages) ? messages : [];
    const human = claimed.filter(isHumanMessage);
    if (human.length > 0) {
      state.resetToolChain();
      state.clearStrike();
      state.strikes = 0;
      state.surrenderNotified = false;
      state.stallSteps = 0;
      const text = messageText(human[human.length - 1]);
      if (text.length > 0) state.lastUserText = preview(text, 800);
    }

    state.stallSteps += 1;

    // ② 检测：步骤停滞走同一张注册表，档位与文案都由检测器给出。
    const stallSignals = runDetectors(
      state,
      cfg,
      { phase: "step", stallSteps: state.stallSteps },
      (id, error) => log(ctx, "warn", `检测器 ${id} 异常（已忽略）：${error && error.message ? error.message : String(error)}`),
    );
    if (stallSignals.length > 0) {
      for (const s of stallSignals) state.noteSignal(s.kind, s.reason);
      state.stallSteps = 0;
      // ③ 仲裁（规则侧）+ 可选模型层
      const stallDecision = arbitrate(stallSignals, null, state.strikes);
      triggerConsult(
        state,
        "step-stall",
        stallDecision !== null ? stallDecision.reason : stallSignals[0].reason,
        signal,
        stallSignals,
      );
    }

    return decision;
  });

  /* ---------------- 4. 收工拦截：把工人抽回来 ---------------- */

  ctx.on("agent/turn-stopping", async ({ agent, signal }) => {
    if (!agent || !agent.session) return;
    const state = guards.get(agent.session.id);
    if (state === undefined) return;

    await waitForConsult(state, cfg.punish.stopWaitMs);
    if (signal !== undefined && signal.aborted) return;

    if (state.strike === null) return;

    // 回合归属校验。监工最长 60s 才返回，这里最多等 stopWaitMs（默认 8s），
    // 所以判决晚归是常态 —— 晚归的那条属于上一个回合，投递到当前回合就是
    // 拿旧诊断指挥新回合。不是当前回合的，直接丢弃。
    if (state.strike.turn !== undefined && state.strike.turn !== state.turnCount) {
      log(
        ctx,
        "info",
        `${state.sessionId} 丢弃过期干预（属于第 ${state.strike.turn} 回合，当前第 ${state.turnCount} 回合）`,
      );
      if (cfg.notify.control) {
        const late = state.strike;
        const lines = [
          "[监工判决晚归]",
          "",
          `监工的判决属于第 ${late.turn} 回合，本回合已是第 ${state.turnCount} 回合，已丢弃。`,
          "",
          "拿旧回合的诊断指挥新回合会把因果搞错，所以宁可不用。",
        ];
        notifyUser(state.agent, "监工晚归", lines.join("\n"));
      }
      state.strike = null;
      return;
    }

    if (state.strikes >= cfg.punish.maxStrikes) {
      // 已经抽了这么多次还在打转：放手，让回合正常结束，避免无限 steer。
      // 但停手本身必须说出来 —— 否则用户只看到监工突然不再动手，分不清是
      // 判定了 working、预算耗尽、还是插件崩了。
      //
      // 走 agent.inject 而不是 steer：inject 只把消息 splice 进 inbox，
      // 不调用 wakeDriver（send 的第三个参数是 false），而 session.append
      // 在 splice 当场就写会话 —— 所以这条通知立刻可见，又不会把已经结束的
      // 回合重新拉起来，那正是「停手」二字要避免的。
      const notice = state.strike;
      state.strike = null;
      if (state.surrenderNotified) {
        log(ctx, "warn", `${state.sessionId} 已达最大干预次数 ${cfg.punish.maxStrikes}，停止强制续跑`);
        return;
      }
      state.surrenderNotified = true;
      const lines = [
        "[监工停手]",
        "",
        `本回合累计干预 ${state.strikes} 次，已达上限 ${cfg.punish.maxStrikes} 次，监工不再强制续跑，回合正常结束。`,
        "",
        `停下时的判据：${notice !== null && notice.label ? notice.label : "未记录"}`,
        "",
        "规则检测与提示仍然生效，但这一回合不会再截断输出或把回合拉回来。",
      ];
      try {
        if (cfg.notify.control) notifyUser(agent, "监工停手", lines.join("\n"));
        log(ctx, "warn", `已通知停手（累计 ${state.strikes} 次干预，上限 ${cfg.punish.maxStrikes}）`);
      } catch (error) {
        log(ctx, "warn", `停手通知失败：${error && error.message ? error.message : String(error)}`);
      }
      return;
    }
    if (!cfg.punish.steerOnStop) return;

    const strike = state.takeStrike();
    if (strike === null) return;

    try {
      agent.steer(pluginMessage(strike.text, "监工干预"));
      log(ctx, "info", `已强制 ${state.sessionId} 继续工作（第 ${state.strikes} 次）`);
    } catch (error) {
      log(ctx, "warn", `steer 失败：${error && error.message ? error.message : String(error)}`);
    }
  });

  /* ---------------- 5. 系统提示纪律 + 生命周期 ---------------- */

  try {
    ctx.systemPrompt.section({
      name: "loop-guard:discipline",
      order: 2750,
      text: DISCIPLINE_TEXT,
    });
  } catch (error) {
    log(ctx, "warn", `注入纪律段失败：${error && error.message ? error.message : String(error)}`);
  }

  ctx.effect(() => () => {
    lifecycle.abort(new Error("loop-guard: disposed"));
    guards.clear();
  });

  log(
    ctx,
    "info",
    `已装载：监工 ${cfg.supervisor.provider}/${cfg.supervisor.model}；`
      + `流式重复 ${cfg.detect.hardAfterHits} 次确认即切断；`
      + `工具重复 ${cfg.detect.toolRepeatThreshold} 次提示 / ${cfg.detect.toolBlockAt} 次阻断；`
      + `冷却 ${cfg.budget.cooldownMs}ms`,
  );
}

export { Config, apply, inject, name };
