window.__ModuleLoader__.load({
  id: "dsh-opencode-connect",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    /** Host routes (literal here and in the host half: the two bundles build independently). */
    const STATUS_PATH = "/plugins/dsh-opencode-connect/status";
    const AUTH_PATH = "/plugins/dsh-opencode-connect/auth";
    const MODELS_PATH = "/plugins/dsh-opencode-connect/models";

    const zh = {
      title: "OpenCode",
      subtitle: "接入 OpenCode Zen 模型。",
      credential: "Zen API Key",
      keySourceCard: "已保存",
      keySourceEnv: "环境变量 OPENCODE_API_KEY",
      keySourceAnonymous: "匿名免费池",
      keyHint: "留空则使用匿名免费池（Bearer public）。填写你自己的 Zen key 可获得更高配额。",
      keySave: "保存",
      keyClear: "清除",
      keySaving: "保存中…",
      keyTail: "尾号",
      catalog: "模型目录",
      catalogLive: "实时列表",
      catalogSaved: "上次保存的列表",
      catalogFallback: "内置列表",
      catalogUpdated: "更新于",
      catalogError: "最近刷新失败：",
      refresh: "刷新目录",
      refreshing: "刷新中…",
      models: "模型开关",
      modelsHint: "关闭的模型从 DSH 模型选择器中隐藏。",
      search: "搜索模型 / ID",
      enableAll: "全部开启",
      disableAll: "全部关闭",
      freeTag: "免费",
      ctxTag: "上下文",
      ua: "门闸身份",
      errorLoad: "无法读取连接器状态",
      retry: "重试",
      saved: "已保存",
      failed: "操作失败",
    };
    const en = {
      title: "OpenCode",
      subtitle: "OpenCode Zen models in DSH.",
      credential: "Zen API Key",
      keySourceCard: "Saved",
      keySourceEnv: "env OPENCODE_API_KEY",
      keySourceAnonymous: "anonymous free pool",
      keyHint: "Leave empty for the anonymous free tier (Bearer public). Your own Zen key raises the quota.",
      keySave: "Save",
      keyClear: "Clear",
      keySaving: "Saving…",
      keyTail: "tail",
      catalog: "Model catalog",
      catalogLive: "live list",
      catalogSaved: "saved list",
      catalogFallback: "built-in list",
      catalogUpdated: "updated",
      catalogError: "last refresh failed: ",
      refresh: "Refresh catalog",
      refreshing: "Refreshing…",
      models: "Model toggles",
      modelsHint: "Disabled models are hidden from DSH's model picker.",
      search: "search models / id",
      enableAll: "Enable all",
      disableAll: "Disable all",
      freeTag: "free",
      ctxTag: "ctx",
      ua: "gate identity",
      errorLoad: "Cannot read connector status",
      retry: "Retry",
      saved: "Saved",
      failed: "Action failed",
    };
    const L = typeof navigator !== "undefined" && /^zh/i.test(navigator.language || "") ? zh : en;

    const css = `
      .oc-card{border:.5px solid var(--dsw-alias-border-l2,#dedee3);border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden}
      .oc-head{display:flex;align-items:center;gap:10px;width:100%;padding:14px 16px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
      .oc-head:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f1f3)}
      .oc-title{font-size:14px;font-weight:600}
      .oc-sub{color:var(--dsw-alias-label-secondary,#74747c);font-size:12px;margin-top:2px}
      .oc-chev{margin-left:auto;color:var(--dsw-alias-label-tertiary,#9a9aa3);transition:transform .15s}
      .oc-chev.oc-open{transform:rotate(90deg)}
      .oc-body{padding:2px 16px 16px;display:flex;flex-direction:column;gap:14px}
      .oc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .oc-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#74747c)}
      .oc-badge{font-size:11px;padding:2px 8px;border-radius:99px;border:.5px solid var(--dsw-alias-border-l2,#dedee3);color:var(--dsw-alias-label-secondary,#74747c)}
      .oc-badge.oc-good{color:var(--dsw-alias-state-business-primary,#4176e6);border-color:currentColor}
      .oc-input,.oc-button{height:30px;padding:0 10px;color:var(--dsw-alias-label-primary,#25252a);background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,#d4d6db);border-radius:var(--dsw-radius-md,8px);font:inherit;font-size:13px}
      .oc-input{flex:1;min-width:160px}
      .oc-button{cursor:pointer;white-space:nowrap}
      .oc-button:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f1f3)}
      .oc-button:disabled{opacity:.5;cursor:default}
      .oc-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#9a9aa3)}
      .oc-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#bd4747)}
      .oc-models{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow:auto;border:.5px solid var(--dsw-alias-border-l2,#dedee3);border-radius:var(--dsw-radius-md,8px);padding:6px}
      .oc-model{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;font-size:13px;flex-wrap:nowrap;min-width:0}
      .oc-model:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f1f3)}
      .oc-model input{accent-color:var(--dsw-alias-state-business-primary,#4176e6);flex:none}
      .oc-model-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .oc-model-id{flex:0 1 auto;min-width:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#9a9aa3);font-size:11px}
      .oc-model .oc-badge{flex:none;white-space:nowrap}
      @media(prefers-reduced-motion:reduce){.oc-chev{transition:none}}
    `;

    const timeText = (ms) => {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return ""
      const d = new Date(ms)
      return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    }

    /** 200,000 tokens reads as 200K, 1,048,576 as 1M — never 195K or 1024K. */
    const ctxText = (n) => {
      if (!Number.isFinite(n) || n <= 0) return ""
      if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`
      return `${Math.round(n / 1e3)}K`
    }

    function isStatus(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value) && value.status === "ok"
    }

    /** One collapsible card: key management, catalog state, model toggles. No quota bar. */
    function OpenCodeCard(props) {
      const { defaultOpen } = props
      const [open, setOpen] = React.useState(defaultOpen === true)
      const [status, setStatus] = React.useState(null)
      const [loadError, setLoadError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [keyDraft, setKeyDraft] = React.useState("")
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [query, setQuery] = React.useState("")
      const mounted = React.useRef(true)
      React.useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])

      const load = React.useCallback(async () => {
        setLoading(true)
        try {
          const res = await fetch(STATUS_PATH, { headers: { accept: "application/json" } })
          if (!res.ok) throw new Error(String(res.status))
          const doc = await res.json()
          if (!mounted.current) return
          if (isStatus(doc)) { setStatus(doc); setLoadError(null) }
          else setLoadError(L.errorLoad)
        } catch {
          if (mounted.current) setLoadError(L.errorLoad)
        } finally {
          if (mounted.current) setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        void load()
        const timer = setInterval(() => void load(), 60_000)
        return () => clearInterval(timer)
      }, [open, load])

      const post = React.useCallback(async (path, body, key) => {
        setBusy(true)
        setNotice(null)
        try {
          const res = await fetch(path, {
            method: "POST",
            headers: { "content-type": "application/json", "x-dsh-opencode-connect-key": key ?? "" },
            body: JSON.stringify(body),
          })
          if (!res.ok) throw new Error(String(res.status))
          await load()
          return true
        } catch {
          setNotice(L.failed)
          return false
        } finally {
          setBusy(false)
        }
      }, [load])

      const credential = status?.credential
      const catalog = status?.catalog
      const models = Array.isArray(catalog?.models) ? catalog.models : []
      const shown = query.trim() === "" ? models : models.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(query.trim().toLowerCase()))
      const enabledIds = models.filter((m) => m.enabled !== false).map((m) => m.id)
      const setDisabled = (ids) => post(MODELS_PATH, { action: "set-disabled", models: models.filter((m) => !ids.includes(m.id)).map((m) => m.id) }, status?.modelsKey)

      return h("div", { className: "oc-card" },
        h("style", null, css),
        h("button", { type: "button", className: "oc-head", onClick: () => setOpen((v) => !v), "aria-expanded": open },
          h("span", null,
            h("span", { className: "oc-title" }, L.title),
            h("div", { className: "oc-sub" }, L.subtitle)),
          h("span", { className: `oc-chev${open ? " oc-open" : ""}`, "aria-hidden": "true" }, "›")),
        open ? h("div", { className: "oc-body" },
          loadError && !status ? h("div", { className: "oc-error" }, loadError, " ", h("button", { type: "button", className: "oc-button", onClick: () => void load() }, L.retry)) : null,
          status ? h(React.Fragment, null,
            h("div", null,
              h("div", { className: "oc-row" },
                h("span", { className: "oc-label" }, L.credential),
                h("span", { className: `oc-badge${credential?.source === "card" ? " oc-good" : ""}` },
                  credential?.source === "card" ? `${L.keySourceCard}${credential.tail ? `（${L.keyTail} ${credential.tail}）` : ""}`
                    : credential?.source === "env" ? L.keySourceEnv : L.keySourceAnonymous),
                credential?.source === "card" ? h("button", { type: "button", className: "oc-button", disabled: busy, onClick: () => void post(AUTH_PATH, { action: "clear" }, status.authKey) }, L.keyClear) : null),
              h("div", { className: "oc-row", style: { marginTop: 6 } },
                h("input", { className: "oc-input", type: "password", placeholder: "sk-…", value: keyDraft, onChange: (e) => setKeyDraft(e.target.value), disabled: busy }),
                h("button", { type: "button", className: "oc-button", disabled: busy || keyDraft.trim() === "", onClick: async () => { if (await post(AUTH_PATH, { action: "save", apiKey: keyDraft.trim() }, status.authKey)) setKeyDraft("") } }, busy ? L.keySaving : L.keySave)),
              h("div", { className: "oc-note", style: { marginTop: 4 } }, L.keyHint)),
            h("div", null,
              h("div", { className: "oc-row" },
                h("span", { className: "oc-label" }, L.catalog),
                h("span", { className: `oc-badge${catalog.source === "live" ? " oc-good" : ""}` },
                  catalog.source === "live" ? L.catalogLive : catalog.source === "saved" ? L.catalogSaved : L.catalogFallback,
                  catalog.fetchedAt ? ` · ${L.catalogUpdated} ${timeText(catalog.fetchedAt)}` : ""),
                h("button", { type: "button", className: "oc-button", disabled: busy || loading, onClick: () => void post(MODELS_PATH, { action: "refresh" }, status.modelsKey) }, loading ? L.refreshing : L.refresh)),
              catalog.error ? h("div", { className: "oc-error", style: { marginTop: 4 } }, L.catalogError + catalog.error) : null,
              h("div", { className: "oc-note", style: { marginTop: 4 } }, `${L.ua}: ${status.userAgent ?? "opencode"}`)),
            h("div", null,
              h("div", { className: "oc-row" },
                h("span", { className: "oc-label" }, L.models),
                h("input", { className: "oc-input", style: { maxWidth: 180, marginLeft: "auto" }, placeholder: L.search, value: query, onChange: (e) => setQuery(e.target.value) })),
              h("div", { className: "oc-note", style: { margin: "4px 0 6px" } }, L.modelsHint),
              h("div", { className: "oc-models" },
                shown.length === 0 ? h("div", { className: "oc-note" }, "—") : shown.map((m) => h("label", { key: m.id, className: "oc-model" },
                  h("input", {
                    type: "checkbox",
                    checked: m.enabled !== false,
                    disabled: busy,
                    onChange: (e) => {
                      const next = e.target.checked ? [...enabledIds, m.id] : enabledIds.filter((id) => id !== m.id)
                      void setDisabled(next)
                    },
                  }),
                  h("span", { className: "oc-model-name", title: m.name }, m.name),
                  h("span", { className: "oc-model-id", title: m.id }, m.id),
                  m.free ? h("span", { className: "oc-badge" }, L.freeTag) : null,
                  m.contextWindow ? h("span", { className: "oc-badge" }, `${L.ctxTag} ${ctxText(m.contextWindow)}`) : null))),
              h("div", { className: "oc-row", style: { marginTop: 6 } },
                h("button", { type: "button", className: "oc-button", disabled: busy, onClick: () => void setDisabled(models.map((m) => m.id)) }, L.enableAll),
                h("button", { type: "button", className: "oc-button", disabled: busy, onClick: () => void setDisabled([]) }, L.disableAll))),
            notice ? h("div", { className: "oc-error" }, notice) : null)
          : h("div", { className: "oc-note" }, loading ? "…" : "—")) : null)
    }

    /**
     * Join the shared 《插件设置》 block with the same rendezvous protocol the
     * sibling connect plugins use: wait for the host's `settings.section`,
     * attach to the existing container when one is registered, otherwise
     * register it (falling back to attaching when a sibling wins the race).
     */
    const SHARED_SECTION_SLOT = "settings.section"
    const SHARED_SECTION_ID = "plugin-settings"
    const SHARED_SECTION_ORDER = 900
    const SHARED_ITEM_SLOT = "plugin-settings.item"
    const SHARED_ITEM_ID = "dsh-opencode-connect"
    const SHARED_SECTION_LABEL = "插件设置"

    function PluginSettingsSection(props) {
      return h("ul", {
        style: { display: "flex", flexDirection: "column", gap: 6, padding: 0, listStyle: "none" },
      }, props.renderSlot(SHARED_ITEM_SLOT, {}))
    }

    const inject = ["slots"]

    function apply(ctx) {
      try {
        ctx.slots.inject(SHARED_SECTION_SLOT, () => {
          let disposeContainer
          if (!ctx.slots.entries(SHARED_SECTION_SLOT).some((entry) => entry.options?.id === SHARED_SECTION_ID)) {
            try {
              disposeContainer = ctx.slots.register({
                name: SHARED_SECTION_SLOT,
                id: SHARED_SECTION_ID,
                order: SHARED_SECTION_ORDER,
                label: () => SHARED_SECTION_LABEL,
                children: { [SHARED_ITEM_SLOT]: { kind: "list", scope: "root" } },
              }, PluginSettingsSection)
            } catch (error) {
              console.error("[dsh-opencode-connect] shared plugin-settings block lost the race; attaching to the winner:", error)
            }
          }
          const disposeItem = ctx.slots.inject(SHARED_ITEM_SLOT, () => ctx.slots.register({
            name: SHARED_ITEM_SLOT,
            id: SHARED_ITEM_ID,
            order: 40,
          }, OpenCodeCard))
          return () => {
            disposeItem()
            disposeContainer?.()
          }
        })
      } catch (error) {
        console.error("[dsh-opencode-connect] could not register the settings card:", error)
      }
    }

    return { inject, apply }
  },
})
