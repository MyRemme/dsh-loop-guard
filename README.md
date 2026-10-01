# dsh-loop-guard

多智能体监工。一个独立模型实时审阅另一个正在工作的智能体的推理文本与工具调用，检测死循环、空转与偷懒，并按 **WARN / BLOCK / STOP** 三档落地。

宿主侧是 cordis 插件，浏览器侧是设置页里的一行。单包同时声明 `dsh.bundle` 与 `dsh.client`。

---

## 四层流水线

实现在 `lib/layers.js`（可独立单测），hook 接线在 `lib/index.js`。

```
① 采集 TraceStore    轨迹 / 证据 / 预算
        │
② 检测 Detector      可插拔规则注册表
        │
③ 仲裁 Arbiter       规则信号 + 可选模型判决 → WARN / BLOCK / STOP
        │
④ 干预 Intervener    按档位落地
```

### ① 采集

`TraceStore` 每个会话一份，记录工具轨迹与观测指纹，三张表都带 LRU 封顶。

**观测摘要**是这套东西的地基。只比 `action + input` 的哈希区分不出「有效轮询」和「空转」：同一个命令反复跑，结果在变说明外部状态在推进，结果不变说明卡死了。所以每次工具调用都会算一个结果指纹，并记录它与上一次的关系：

| 判读 | 含义 |
|---|---|
| 结果与上次完全相同 | 重复调用且无新信息 → 高度疑似空转 |
| 结果在 N 种取值间来回振荡 | 看似每次都在变，取值种类却不增长 → 状态未推进 |
| 结果有变化 | 外部状态在推进 → 合理轮询 |
| 结果为空 | 没有任何产出 |

指纹前先剥离显式易变量（ISO 时间戳、`HH:MM:SS`、UUID、十六进制、`12ms`/`3s`）。只匹配明确的易变量，**不做模糊归一**——宁可误报「有变化」，也不能把真实变化压成「相同」，后者会制造假阳性阻断。

### ② 检测

四条规则，声明式注册，单条抛错不影响其它：

| id | 触发 | 档位 |
|---|---|---|
| `stream-loop` | 推理/正文的短语级或字符级周期重复 | STOP |
| `tool-repeat` | 同一工具同一参数被反复调用 | WARN |
| `observation-stall` | 结果逐字节相同 / 振荡 / 为空 | WARN~STOP |
| `step-stall` | 连续多步没有新的可验证结果 | WARN |

字符级周期检测**逐字符比对，不抽样**。抽样步进会跳过模板里唯一变化的那些字符，`第32步…第33步…` 这种正常推理会被判成死循环——这是最贵的一类假阳性。同时强制最少验证 64 个字符，且报告的重复次数是**实际验证跨度内成立的周期数**，不由全文长度推断。

### ③ 仲裁

规则只负责「发现可疑」，不决定惩罚强度。两条原则：

- **结果逐字节相同是确定性证据**，不依赖模型也能定罪，直接 BLOCK；一路到 `toolBlockAt` 还没换路则升 STOP。
- **仅调用次数多但结果一直在变**，只 WARN，并把判决权交给模型。假阻断会毁掉真实工作，漏判只多花 token——默认向漏判倾斜。

模型的角色是**撤回者而不是加重者**：它能否掉规则对合理轮询的误判，但不能凭想象把规则没发现的东西升到 STOP。

屡犯升级：第 2 次至少 BLOCK，第 3 次 STOP。

### ④ 干预

| 档位 | 落地方式 |
|---|---|
| WARN | `additionalContexts` 软提示，不打断 |
| BLOCK | `PostToolDecision.block`，本次工具调用判失败 |
| STOP | 截断输出流 + `agent.steer` 把工人抽回来 |

干预带**回合归属**。监工最长要 `timeoutMs`（默认 60s）才返回，而收工点最多等 `stopWaitMs`（默认 8s），判决晚归是常态；没有回合归属，上一个回合的诊断就会被注入到下一个回合。

到 `maxStrikes` 后插件**放手**，让回合自然收尾，不再强制续跑。

---

## 配置

`cordis.patch.yml`：

```yaml
- id: dsh-loop-guard
  name: dsh-loop-guard
  config:
    enabled: true
    supervisor:
      enabled: true
      provider: commandcode
      model: zai-org/GLM-5.3
      temperature: 0
      timeoutMs: 60000
    detect:
      reasoningLoop: true
      textLoop: true
      minRepeats: 4
      hardAfterHits: 2
      toolRepeatThreshold: 3
      toolBlockAt: 5
      stepStallThreshold: 30
    punish:
      cutStream: true
      blockRepeatTool: true
      steerOnStop: true
      maxStrikes: 3
    budget:
      cooldownMs: 20000
      maxConsultsPerTurn: 3
      maxConsultsPerSession: 40
```

### 顶层扁平别名

以下几个旋钮同时提供**顶层**写法：

```yaml
    toolRepeatThreshold: 3
    toolBlockAt: 5
    stepStallThreshold: 30
    hardAfterHits: 2
    cutStream: true
    blockRepeatTool: true
```

顶层优先于嵌套值。这不是冗余：浏览器的设置表单（`dsh-client-ui-primitives` 的 `SettingsFormModel`）写操作是 `{op:"set", path:[field]}`——**单段路径**，读也是平面取值，嵌套的 `detect.*` / `punish.*` 它既读不出也写不进。UI 改的就是这一层，手改 `cordis.patch.yml` 两种写法都生效。

监工必须走**另一条路由**：换了工人的模型，`supervisor.provider` / `supervisor.model` 也要跟着换。两个模型相同会让监工调用自己触发自己。

---

## 设置界面

设置 → 通用 → 空转监工。可改上面那六个顶层字段，改动即时写回宿主配置。

实现见 `lib/client.js`：

- 入口是 `window.__ModuleLoader__.load({id, factory})`
- 注册进 `settings.general.item` 槽位
- 配置经 `ctx.get("configForms").get("dsh-loop-guard")` 拿到
- **无条件注册**，不用 `whileServed` 门控：非 loopback 页面下设置文档是进程内的，`describe` 镜像永远不加载，门控会让这一行根本不存在——看起来像被删了而不是被禁用

---

## 安装

包自带 `dsh.bundle.patch`，走 bundle 声明挂载。profile 的 `package.json`：

```jsonc
{
  "dependencies": {
    "dsh-loop-guard": "file:./node_modules/dsh-loop-guard"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "dsh-loop-guard"]
    }
  }
}
```

`cordis.patch.yml` 里覆盖 config。改完**需要重启 DSH**才会重新装载。

---

## 测试

仓库外有一组独立探针（不进包），覆盖观测摘要、四层内核、hook 接线、真实加载、真实会话重放：

| 探针 | 覆盖 |
|---|---|
| `lg-obs` | 观测指纹与易变量剥离 |
| `lg-layers` | 四层内核：采集/检测/仲裁/干预 |
| `lg-integration` | 驱动 `apply()` 注册的四个 hook，走完整调用链 |
| `lg-load` | 用真的 schemastery 校验 Config |
| `lg-ui-config` | 顶层别名优先级与向后兼容 |

---

## 已知边界

- **`supervisor` 答非所问与调不通走同一条兜底路径**。模型回散文而非 JSON 时判决无法解析，插件按「监工不可用」处理并沿用兜底判决；按设计兜底会把规则 WARN 升级到 BLOCK。现在这种情形会打一条 warn 日志，不再静默。
- **规则是哨兵，不是法官**。所有阈值都偏保守，宁可漏判。
- **流式检测看的是窗口**。`windowChars` 之外的重复不会被发现。

---

## License

Apache-2.0
