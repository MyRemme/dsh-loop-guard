/**
 * dsh-loop-guard 浏览器端：设置页里的一行。
 *
 * 契约来自同 profile 的 dsh-computer-use-guard（单包同时声明 dsh.bundle 与
 * dsh.client 的现成范例）：
 *   · 入口是 window.__ModuleLoader__.load({id, factory})，factory 里 require 依赖
 *   · apply(ctx) 用 ctx.slots.inject("<槽位>", () => ctx.slots.register({...}, 组件))
 *   · 配置表单走 ctx.get("configForms").get("<插件 id>")，它就是这个插件的
 *     settings namespace
 *   · 后台配置经 form.store 暴露成 hook，写经 form.mutate(ops)
 *
 * 字段用路径数组读写（path: ["detect","toolRepeatThreshold"]）：宿主把可编辑旋钮标在
 * 嵌套叶子上，设置服务的 edit(section, op.path) 本来就按数组走路径。别再为「单段路径」
 * 去改宿主 schema —— 那样会同时踩到配置遮蔽和 UI 消失两个坑。
 */
window.__ModuleLoader__.load({
  id: "dsh-loop-guard",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    /** 设置命名空间 = 插件 id（bundle 插件的 id 同时是它的 settings namespace）。 */
    var NS = "dsh-loop-guard";
    /** 本页字典的命名空间。 */
    var LOCALE = "settings.loopGuard";
    /** 样式类前缀。 */
    var P = "lgd";

    /* ---------------- 文案 ---------------- */
    var zh = {
      title: "空转监工",
      description: "另一个模型盯着干活的模型：检测推理死循环、重复调用与观测无推进。",
      groupDetect: "检测阈值",
      groupPunish: "干预开关",
      groupSupervisor: "模型监工（可选）",
      groupNotify: "可见通知",
      notifyControl: "控制面事件通知",
      notifyControlHint: "监工调用失败、预算用尽跳过咨询、判决晚归被丢弃、达到上限停手——这些原来只写宿主日志，界面上看不见。",
      notifyWorking: "监工判定 working 时也通知",
      notifyWorkingHint: "每次监工看过证据后认为在正常推进都提醒一次。排障用，平时会吵。",
      supEnabled: "启用模型监工",
      supEnabledHint: "关掉后只做规则检测，不再调用监工模型裁决；检测与提示照常。",
      supProvider: "监工 provider",
      supProviderHint: "留空表示跟随当前模型，不覆盖。",
      supModel: "监工模型",
      supModelHint: "留空即跟随当前模型——换主模型时监工自动跟着换。",
      chooseModel: "选择模型",
      searchModel: "搜索模型…",
      inheritOption: "跟随当前模型（不覆盖）",
      noCatalog: "模型目录不可用（宿主未提供），可留空沿用配置。",
      threshold: "重复调用提示阈值",
      thresholdHint: "同一工具同一参数累计到这个次数时给出提示。",
      blockAt: "重复调用阻断阈值",
      blockAtHint: "到这个次数时把本次工具调用判定为失败；不得低于提示阈值。",
      stall: "步骤停滞阈值",
      stallHint: "连续多少步没有新动作就判定停滞。",
      hits: "流式重复确认次数",
      hitsHint: "同一周期连续命中几次才切断输出。",
      cutStream: "切断重复输出",
      cutStreamHint: "命中流式死循环时截断本次生成。",
      blockTool: "阻断重复工具调用",
      blockToolHint: "到达阻断阈值时把该次调用判失败。",
      on: "已开启",
      off: "已关闭",
      inherit: "留空沿用宿主配置",
      loading: "读取中…",
      unavailable: "当前部署没有提供该插件的设置，无法在此修改。",
      error: "本部署没有接受这次修改，已保留原值。",
      hint: "这些是插件 Config 的顶层字段；嵌套写法（detect.* / punish.*）仍然有效，手改 cordis.patch.yml 时不受影响。",
    };
    var en = {
      title: "Loop guard",
      description: "A second model watches the working one: reasoning loops, repeated calls, and stalled observation.",
      groupDetect: "Detection thresholds",
      groupPunish: "Intervention switches",
      groupSupervisor: "Model supervisor (optional)",
      groupNotify: "Visible notices",
      notifyControl: "Control-plane notices",
      notifyControlHint: "Supervisor failures, budget-skipped consults, discarded late verdicts, giving up at the strike cap - previously host-log only.",
      notifyWorking: "Also notify on a working verdict",
      notifyWorkingHint: "Post a notice whenever the supervisor finds normal progress. Useful for debugging, noisy otherwise.",
      supEnabled: "Enable the model supervisor",
      supEnabledHint: "When off, only the rule layer runs; detection and notices still apply.",
      supProvider: "Supervisor provider",
      supProviderHint: "Leave blank to follow the current model.",
      supModel: "Supervisor model",
      supModelHint: "Blank follows the current model, so switching the main model switches the supervisor too.",
      chooseModel: "Choose a model",
      searchModel: "Search models...",
      inheritOption: "Follow the current model (no override)",
      noCatalog: "Model catalog unavailable (Host does not provide it). Leave blank to inherit.",
      threshold: "Repeat-call notice threshold",
      thresholdHint: "Notice after the same call with the same arguments runs this many times.",
      blockAt: "Repeat-call block threshold",
      blockAtHint: "Fail the tool call at this count; must not be below the notice threshold.",
      stall: "Step-stall threshold",
      stallHint: "Declare a stall after this many steps without a new action.",
      hits: "Stream-loop confirmations",
      hitsHint: "Cut the output after the same period is confirmed this many times in a row.",
      cutStream: "Cut repeated output",
      cutStreamHint: "Truncate generation when a streaming loop is detected.",
      blockTool: "Block repeated tool calls",
      blockToolHint: "Fail the call once it reaches the block threshold.",
      on: "On",
      off: "Off",
      inherit: "Blank keeps cordis.patch.yml",
      loading: "Loading…",
      unavailable: "This deployment does not serve this plugin's settings, so they cannot be changed here.",
      error: "The deployment did not accept the change; the previous value is kept.",
      hint: "These are top-level Config fields. The nested form (detect.* / punish.*) still works when editing cordis.patch.yml by hand.",
    };

    /* ---------------- 样式 ---------------- */
    var css =
      "." + P + "_row{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:16px 0}" +
      "." + P + "_head{display:flex;justify-content:space-between;align-items:center;gap:24px}" +
      "." + P + "_title{font-size:14px;line-height:20px}" +
      "." + P + "_desc{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}" +
      "." + P + "_group{margin-top:14px}" +
      "." + P + "_groupTitle{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px;letter-spacing:.04em}" +
      "." + P + "_item{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:8px 0}" +
      "." + P + "_itemText{flex:1;min-width:0}" +
      "." + P + "_itemLabel{font-size:13px;line-height:18px}" +
      "." + P + "_itemHint{color:var(--dsw-alias-label-secondary);margin-top:2px;font-size:11px;line-height:16px}" +
      "." + P + "_num{width:72px;padding:4px 8px;font-size:13px;border-radius:6px;" +
      "border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit}" +
      "." + P + "_text{width:220px;padding:4px 8px;font-size:13px;border-radius:6px;" +
      "border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit}" +
      "." + P + "_pickWrap{position:relative;display:flex;align-items:center;justify-content:flex-end}" +
    "." + P + "_pick{display:flex;align-items:center;gap:6px;max-width:260px;padding:4px 10px;font-size:13px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
    "border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit}" +
    "." + P + "_caret{opacity:.6;font-size:11px}" +
    "." + P + "_panel{position:absolute;top:calc(100% + 6px);right:0;z-index:40;width:320px;max-height:320px;display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:10px;" +
    "border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,#1f1f1f);box-shadow:0 8px 28px rgba(0,0,0,.35)}" +
    "." + P + "_search{width:100%;padding:5px 8px;font-size:13px;border-radius:6px;box-sizing:border-box;" +
    "border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit}" +
    "." + P + "_list{overflow-y:auto;max-height:250px;display:flex;flex-direction:column;gap:1px}" +
    "." + P + "_grp{padding:6px 8px 2px;font-size:11px;opacity:.55;letter-spacing:.02em}" +
    "." + P + "_opt{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 8px;font-size:13px;border-radius:6px;cursor:pointer;text-align:left;" +
    "border:1px solid transparent;background:transparent;color:inherit}" +
    "." + P + "_opt:hover{background:rgba(127,127,127,.14)}" +
    "." + P + "_optOn{background:rgba(127,127,127,.18);font-weight:600}" +
    "." + P + "_tick{opacity:.8;font-size:12px}" +
    "." + P + "_empty{padding:6px 8px;font-size:12px;opacity:.6;line-height:1.5}" +
    "." + P + "_btn{min-width:64px;padding:4px 10px;font-size:12px;border-radius:999px;cursor:pointer;" +
      "border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit}" +
      "." + P + "_btnOn{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe)}" +
      "." + P + "_btn:disabled,." + P + "_num:disabled{opacity:.5;cursor:not-allowed}" +
      "." + P + "_err{color:var(--dsw-alias-label-error,#e5484d)}" +
      "." + P + "_foot{margin-top:12px;font-size:11px;color:var(--dsw-alias-label-secondary);line-height:16px}";

    var tagId = "dsh-loop-guard/LoopGuardRow.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-loop-guard";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /* ---------------- 字段表 ---------------- */
    //
    // 每个可编辑字段都同时给出嵌套出处。宿主侧顶层优先，但用户的
    // cordis.patch.yml 里写的是嵌套值、顶层字段压根没被设过 —— 只读顶层的话
    // 这一行会显示 schema 默认值，而插件实际用的是嵌套值。所以读要顺着回退，
    // 写一律写到顶层（volatile 那一层）。
    var NUMBERS = [
      { field: ["detect", "toolRepeatThreshold"], fallback: 3, label: "threshold", hint: "thresholdHint", min: 1 },
      { field: ["detect", "toolBlockAt"], fallback: 5, label: "blockAt", hint: "blockAtHint", min: 1 },
      { field: ["detect", "stepStallThreshold"], fallback: 30, label: "stall", hint: "stallHint", min: 1 },
      { field: ["detect", "hardAfterHits"], fallback: 2, label: "hits", hint: "hitsHint", min: 1 },
    ];
    var BOOLEANS = [
      { field: ["punish", "cutStream"], fallback: true, label: "cutStream", hint: "cutStreamHint" },
      { field: ["punish", "blockRepeatTool"], fallback: true, label: "blockTool", hint: "blockToolHint" },
    ];
    // 监工的 provider/model 用空串表示「不覆盖」，所以回退链是 顶层 → 嵌套 → ""，
    // 而不是给一个具体默认值 —— 显示一个猜出来的模型名比留空更误导。
    var TEXTS = [
      { field: ["supervisor", "provider"], fallback: "", label: "supProvider", hint: "supProviderHint" },
      { field: ["supervisor", "model"], fallback: "", label: "supModel", hint: "supModelHint" },
    ];
    var SUPERVISOR_BOOLEAN = {
      field: ["supervisor", "enabled"], fallback: true, label: "supEnabled", hint: "supEnabledHint",
    };
    var NOTIFY_BOOLEANS = [
      { field: ["notify", "control"], fallback: true, label: "notifyControl", hint: "notifyControlHint" },
      { field: ["notify", "working"], fallback: false, label: "notifyWorking", hint: "notifyWorkingHint" },
    ];

    /** 取出 volatile 包装值里的真实值；普通值原样返回。 */
    function unwrap(value) {
      if (value !== null && typeof value === "object" && typeof value.get === "function") {
        var inner = value.get();
        return inner === undefined ? undefined : inner;
      }
      return value;
    }

    /** 沿路径取值并拆包。 */
    function pick(root, path) {
      var node = root;
      for (var i = 0; i < path.length; i += 1) {
        node = unwrap(node);
        if (node === null || node === undefined || typeof node !== "object") return undefined;
        node = node[path[i]];
      }
      return unwrap(node);
    }

    /** 该字段当前生效的值：顶层 → 嵌套 → 默认。 */
    function effective(spec, value) {
      var got = pick(value, spec.field);
      return got === undefined ? spec.fallback : got;
      return nested === undefined ? spec.fallback : nested;
    }


    /**
     * 注入共享设置页的组件绝不能把整页带走：渲染期抛错时，没有错误边界的 React
     * 会卸载整棵树，症状是「整个界面都没了」，而不是「这一行没了」。
     * 所以这里兜一层，失败时只留下一行说明，顺便把原因显示出来。
     */
    function LoopGuardRow(props) {
      try {
        return renderLoopGuardRow(props);
      } catch (error) {
        return React.createElement(
          "div",
          { className: P + "_row" },
          React.createElement("div", { className: P + "_title" }, "空转监工：渲染失败"),
          React.createElement("div", { className: P + "_hint" }, String(error && error.message ? error.message : error)),
        );
      }
    }

    function num(value, fallback) {
      return typeof value === "number" && Number.isFinite(value) ? value : fallback;
    }

    /* ---------------- 组件 ---------------- */
    /**
     * @param props - 由 slots 注入：useLoopGuard（配置快照）、load、write、t。
     */
    var clientCtx = null;

function renderLoopGuardRow(props) {
      var state = props.useLoopGuard(function (s) { return s; });
      var t = props.t;
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var failedState = React.useState(false);
      var failed = failedState[0];
      var setFailed = failedState[1];
      var catalogState = React.useState([]);
      var catalog = catalogState[0];
      var setCatalog = catalogState[1];
      var openState = React.useState(false);
      var pickerOpen = openState[0];
      var setPickerOpen = openState[1];
      var queryState = React.useState("");
      var query = queryState[0];
      var setQuery = queryState[1];

      React.useEffect(function () { props.load(); }, [props.load]);

      React.useEffect(function () {
        try {
        var dir = clientCtx && typeof clientCtx.get === "function" ? clientCtx.get("modelDirectories", false) : null;
        if (!dir || !dir.catalog || !dir.catalog.store) { setCatalog(null); return undefined; }
        var store = dir.catalog.store;
        var sync = function () {
          var snap = typeof store.getSnapshot === "function" ? store.getSnapshot() : null;
          var value = snap && snap.value ? snap.value : null;
          setCatalog(value && Array.isArray(value.groups) ? value.groups : []);
        };
        sync();
        Promise.resolve(dir.catalog.load()).then(sync, function () { setCatalog(null); });
        var unsubscribe = typeof store.subscribe === "function" ? store.subscribe(sync) : null;
        return function () { if (typeof unsubscribe === "function") unsubscribe(); };
        } catch {
          setCatalog(null);
          return undefined;
        }
      }, []);

      if (state.status === "unavailable") {
        return React.createElement(
          "div",
          { className: P + "_row" },
          React.createElement(
            "div",
            null,
            React.createElement("div", { className: P + "_title" }, t("title")),
            React.createElement("div", { className: P + "_desc" }, t("unavailable")),
          ),
        );
      }

      var value = state.value ?? {};
      var loading = state.status === "loading";
      var disabled = busy || loading || !state.writable;

      var commitMany = function (entries) {
        setFailed(false);
        setBusy(true);
        var ops = entries.map(function (e) {
          return e[1] === null ? { op: "unset", path: e[0] } : { op: "set", path: e[0], value: e[1] };
        });
        Promise.resolve(props.write(ops))
          .then(function (ok) { if (ok === false) setFailed(true); })
          .catch(function () { setFailed(true); })
          .then(function () { setBusy(false); });
      };

      /** 提交一次 Config 写操作。`null` 表示清除覆盖、回到默认值。 */
      var commit = function (field, next) {
        setFailed(false);
        setBusy(true);
        var ops = next === null
          ? [{ op: "unset", path: field }]
          : [{ op: "set", path: field, value: next }];
        Promise.resolve(props.write(ops))
          .then(function (ok) { if (ok === false) setFailed(true); })
          .catch(function () { setFailed(true); })
          .then(function () { setBusy(false); });
      };

      var summary = loading
        ? t("loading")
        : t("threshold") + " " + num(effective(NUMBERS[0], value), 3)
          + " · " + t("blockAt") + " " + num(effective(NUMBERS[1], value), 5)
          + " · " + t("stall") + " " + num(effective(NUMBERS[2], value), 30);

      var numberRow = function (spec) {
        var current = effective(spec, value);
        return React.createElement(
          "div",
          { className: P + "_item", key: spec.field },
          React.createElement(
            "div",
            { className: P + "_itemText" },
            React.createElement("div", { className: P + "_itemLabel" }, t(spec.label)),
            React.createElement("div", { className: P + "_itemHint" }, t(spec.hint)),
          ),
          React.createElement("input", {
            className: P + "_num",
            type: "text",
            inputMode: "numeric",
            disabled: disabled,
            value: typeof current === "number" ? String(current) : "",
            onChange: function (event) {
              var raw = event.target.value.trim();
              if (raw === "") { commit(spec.field, null); return; }
              var parsed = Number(raw);
              if (!Number.isFinite(parsed) || parsed < spec.min) return;
              if (parsed === current) return;
              commit(spec.field, Math.floor(parsed));
            },
            onBlur: function (event) {
              var raw = event.target.value.trim();
              if (raw !== "" && !Number.isFinite(Number(raw))) event.target.value = String(current ?? "");
            },
          }),
        );
      };

      var booleanRow = function (spec) {
        var on = effective(spec, value) === true;
        return React.createElement(
          "div",
          { className: P + "_item", key: spec.field },
          React.createElement(
            "div",
            { className: P + "_itemText" },
            React.createElement("div", { className: P + "_itemLabel" }, t(spec.label)),
            React.createElement("div", { className: P + "_itemHint" }, t(spec.hint)),
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: on ? P + "_btn " + P + "_btnOn" : P + "_btn",
              disabled: disabled,
              "aria-pressed": on,
              onClick: function () { commit(spec.field, !on); },
            },
            on ? t("on") : t("off"),
          ),
        );
      };

      var modelPickerRow = function () {
        var cur = { provider: effective(TEXTS[0], value), model: effective(TEXTS[1], value) };
        var has = typeof cur.provider === "string" && cur.provider.length > 0 && typeof cur.model === "string" && cur.model.length > 0;
        var q = query.trim().toLowerCase();
        var match = function (x) { return q === "" || String(x === undefined ? "" : x).toLowerCase().indexOf(q) >= 0; };
        var close = function () { setPickerOpen(false); setQuery(""); };
        var choose = function (provider, model) { close(); commitMany([[TEXTS[0].field, provider], [TEXTS[1].field, model]]); };
        var rows = [];
        rows.push(React.createElement(
          "button",
          { type: "button", key: "__inherit",
            className: P + "_opt" + (has ? "" : " " + P + "_optOn"),
            disabled: disabled,
            onClick: function () { close(); commitMany([[TEXTS[0].field, null], [TEXTS[1].field, null]]); } },
          t("inheritOption"),
        ));
        if (catalog === null) {
          rows.push(React.createElement("div", { className: P + "_empty", key: "__nocat" }, t("noCatalog")));
        } else {
          for (var gi = 0; gi < catalog.length; gi += 1) {
            var g = catalog[gi];
            var all = g && Array.isArray(g.models) ? g.models : [];
            var keep = all.filter(function (m) { return match(m && m.id) || match(m && m.name) || match(g && g.name); });
            if (keep.length === 0) continue;
            rows.push(React.createElement("div", { className: P + "_grp", key: "g" + gi }, String((g && (g.name || g.id)) || "")));
            for (var mi = 0; mi < keep.length; mi += 1) {
              var m = keep[mi];
              var on = has && cur.provider === g.id && cur.model === m.id;
              rows.push(React.createElement(
                "button",
                { type: "button", key: "g" + gi + "m" + mi,
                  className: P + "_opt" + (on ? " " + P + "_optOn" : ""),
                  disabled: disabled,
                  onClick: (function (gid, mid) { return function () { choose(gid, mid); }; })(g.id, m.id) },
                String((m && (m.name || m.id)) || ""),
                on ? React.createElement("span", { className: P + "_tick" }, "\u2713") : null,
              ));
            }
          }
        }
        return React.createElement(
          "div",
          { className: P + "_item" },
          React.createElement("div", { className: P + "_itemText" },
            React.createElement("div", { className: P + "_itemLabel" }, t("supModel")),
            React.createElement("div", { className: P + "_itemHint" }, t("supModelHint")),
          ),
          React.createElement("div", { className: P + "_pickWrap" },
            React.createElement(
              "button",
              { type: "button", className: P + "_pick", disabled: disabled, "aria-expanded": pickerOpen,
                onClick: function () { setPickerOpen(!pickerOpen); } },
              has ? cur.provider + " / " + cur.model : t("inheritOption"),
              React.createElement("span", { className: P + "_caret" }, "\u25BE"),
            ),
            pickerOpen ? React.createElement("div", { className: P + "_panel" },
              React.createElement("input", {
                className: P + "_search", type: "text", placeholder: t("searchModel"),
                value: query, onChange: function (e) { setQuery(e.target.value); },
              }),
              React.createElement("div", { className: P + "_list" }, rows),
            ) : null,
          ),
        );
      };
      var textRow = function (spec) {
        var current = effective(spec, value);
        var text = typeof current === "string" ? current : "";
        return React.createElement(
          "div",
          { className: P + "_item", key: spec.field },
          React.createElement(
            "div",
            { className: P + "_itemText" },
            React.createElement("div", { className: P + "_itemLabel" }, t(spec.label)),
            React.createElement("div", { className: P + "_itemHint" }, t(spec.hint)),
          ),
          React.createElement("input", {
            className: P + "_text",
            type: "text",
            disabled: disabled,
            value: text,
            placeholder: t("inherit"),
            onChange: function (event) {
              var next = event.target.value;
              // 清空 = 清除覆盖，回落到 cordis.patch.yml 的值
              commit(spec.field, next.trim() === "" ? null : next);
            },
          }),
        );
      };

      return React.createElement(
        "div",
        { className: P + "_row" },
        React.createElement(
          "div",
          { className: P + "_head" },
          React.createElement(
            "div",
            null,
            React.createElement("div", { className: P + "_title" }, t("title")),
            React.createElement(
              "div",
              { className: failed ? P + "_desc " + P + "_err" : P + "_desc", role: failed ? "alert" : undefined },
              failed ? t("error") : summary,
            ),
          ),
        ),
        React.createElement("div", { className: P + "_desc" }, t("description")),
        React.createElement(
          "div",
          { className: P + "_group" },
          React.createElement("div", { className: P + "_groupTitle" }, t("groupSupervisor")),
          booleanRow(SUPERVISOR_BOOLEAN),
          modelPickerRow(),
        ),
        React.createElement(
          "div",
          { className: P + "_group" },
          React.createElement("div", { className: P + "_groupTitle" }, t("groupNotify")),
          NOTIFY_BOOLEANS.map(booleanRow),
        ),
        React.createElement(
          "div",
          { className: P + "_group" },
          React.createElement("div", { className: P + "_groupTitle" }, t("groupDetect")),
          NUMBERS.map(numberRow),
        ),
        React.createElement(
          "div",
          { className: P + "_group" },
          React.createElement("div", { className: P + "_groupTitle" }, t("groupPunish")),
          BOOLEANS.map(booleanRow),
        ),
        React.createElement("div", { className: P + "_foot" }, t("hint")),
      );
    }

    /* ---------------- 挂载 ---------------- */
    /** 需要的浏览器侧服务。configForms 用 ctx.get 取，不作硬依赖。 */
    var inject = ["slots", "locale"];

    function apply(ctx) {
  clientCtx = ctx;
      ctx.effect(function () {
        return ctx.locale.register(LOCALE, { zh: zh, en: en });
      }, "dsh-loop-guard: dictionaries");

      var forms = ctx.get("configForms");
      if (forms === undefined || typeof forms.get !== "function") return;
      var form = forms.get(NS);
      if (form === undefined || form === null) return;

      var load = function () {
        var mirror = forms.describe();
        if (mirror !== undefined && typeof mirror.ensure === "function") return mirror.ensure();
        return Promise.resolve();
      };

      // 控制器归 provider 所有（由它的 teardown effect 释放）。这里绝不能 dispose：
      // 释放会在这个 map 里留下一具尸体，客户端插件热重载后拿到的就是它，
      // 此后每次写入都永远返回 false。
      var write = function (ops) {
        if (typeof form.mutate === "function") return form.mutate(ops);
        var chain = Promise.resolve(true);
        for (var i = 0; i < ops.length; i += 1) {
          (function (op) {
            chain = chain.then(function (ok) {
              if (ok === false || op.op !== "set") return ok;
              return form.set(op.path[0], op.value);
            });
          })(ops[i]);
        }
        return chain;
      };

      // 无条件注册，不用 whileServed 门控：非 loopback 页面下设置文档是进程内的
      // （persistence = memory），describe 镜像永远不加载，namespace 也就不算被
      // 服务，门控会让这一行根本不存在 —— 看起来像被删了而不是被禁用。
      ctx.effect(function () {
        return ctx.slots.inject("settings.general.item", function () {
          return ctx.slots.register({
            name: "settings.general.item",
            id: "loop-guard",
            order: 6,
            locale: LOCALE,
            inject: function () {
              return {
                hooks: { loopGuard: form.store },
                load: load,
                write: write,
              };
            },
          }, LoopGuardRow);
        });
      }, "dsh-loop-guard: settings row");
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = NS;

    return module.exports;
  },
});
