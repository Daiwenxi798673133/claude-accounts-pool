// The read-only dashboard's HTML shell: ONE string, zero dependencies, zero build step, and — the
// property everything else here rests on — ZERO DATA. No account, no utilization number, no key.
//
// WHY THE SHELL IS UNAUTHENTICATED. A browser navigating to a URL cannot send an Authorization
// header, so gating this document behind the pool key would make it unreachable from a browser at
// all; the only way to serve it under Bearer auth would be a key in the query string, which lands in
// shell history, proxy logs and the browser's own history — strictly worse than an inert document.
// Because it discloses nothing beyond "a master lives here" (which /v1/health already answers to an
// unauthenticated caller by design), serving it keyless costs nothing. The KEY is typed into the
// page, kept in sessionStorage — scoped to this origin and gone when the tab closes, unlike
// localStorage — and travels ONLY in the Authorization header of the fetch below.
//
// DATA REACHES THE DOM THROUGH textContent AND style.width ONLY, NEVER innerHTML. `label` is an
// account email that originated in a profile response, and rendering pool-derived text as markup is
// how a dashboard becomes an XSS vector against the one person on the network holding a pool key.
//
// The script is written in ES5-ish `var` / string-concatenation style on purpose: it is embedded in a
// TS template literal, so every backtick and every `${` inside it would need escaping and would be
// one typo away from a page that fails to parse — with no compiler watching.

// `usageRoute` comes from the frozen CLOUD_ROUTES table (a compile-time literal, never user input),
// which is why interpolating it into a JS string literal here needs no escaping. It is a parameter
// rather than a hard-coded "/v1/usage" so the route table stays the single source of truth and a
// renamed route cannot leave a silently broken page behind.
export function dashboardHtml(usageRoute: string): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>账号池用量</title>
<!-- An empty data: icon, so the browser's automatic /favicon.ico probe does not put a 404 in the
     console of the very page an operator opens to find out whether anything is wrong. -->
<link rel="icon" href="data:,">
<style>
  :root { color-scheme: dark light; --ok: #3fb950; --warn: #d29922; --full: #f85149; --dim: #8b949e; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
         background: #0d1117; color: #e6edf3; }
  h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
  #meta { color: var(--dim); font-size: 12px; }
  #meta.stale { color: var(--full); font-weight: 600; }
  #gate { margin: 24px 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  /* An author-level display declaration beats the UA stylesheet's hidden-attribute rule, so without
     this line setting gate.hidden would hide nothing and the key form would stay on screen even after
     a successful load. */
  #gate[hidden] { display: none; }
  #gate input { flex: 0 1 380px; padding: 6px 8px; border-radius: 6px; border: 1px solid #30363d;
                background: #010409; color: inherit; font-family: ui-monospace, monospace; }
  #gate button { padding: 6px 14px; border-radius: 6px; border: 1px solid #30363d; background: #21262d;
                 color: inherit; cursor: pointer; }
  #gate-error { flex: 1 0 100%; margin: 0; color: var(--full); font-size: 12px; }
  #rows { display: grid; gap: 12px; margin: 20px 0 0; }
  .card { border: 1px solid #30363d; border-radius: 8px; padding: 12px 14px; background: #161b22; }
  .card.cooling { border-color: var(--full); }
  .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .label { font-weight: 600; }
  .id { color: var(--dim); font-family: ui-monospace, monospace; font-size: 12px; }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; }
  .badge.cool { color: var(--full); }
  .badge.reauth { color: var(--warn); }
  .badge.muted { color: var(--dim); }
  .token { color: var(--dim); font-size: 12px; margin-top: 4px; }
  .win { display: grid; grid-template-columns: 150px 1fr 56px 130px; gap: 10px; align-items: center;
         margin-top: 8px; font-size: 12px; }
  .win .wl { color: var(--dim); font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; }
  .bar { height: 8px; border-radius: 999px; background: #21262d; overflow: hidden; }
  .fill { height: 100%; background: var(--ok); }
  .fill.warn { background: var(--warn); }
  .fill.full { background: var(--full); }
  .pct { text-align: right; font-family: ui-monospace, monospace; }
  .reset { color: var(--dim); text-align: right; }
  .empty { color: var(--dim); font-size: 12px; margin-top: 6px; }
  footer { margin-top: 24px; color: var(--dim); font-size: 12px; }
  @media (max-width: 640px) { .win { grid-template-columns: 1fr 48px; } .win .bar, .win .reset { grid-column: 1 / -1; } }
</style>
</head>
<body>
<h1>账号池用量</h1>
<div id="meta"></div>
<form id="gate" hidden>
  <input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="pool key">
  <button type="submit">查看</button>
  <p id="gate-error" hidden></p>
</form>
<div id="rows"></div>
<footer>只读视图：不含任何 token，也不提供任何改状态的操作。</footer>
<script>
(function () {
  "use strict";
  var USAGE_URL = "${usageRoute}";
  var KEY_STORE = "claude-accounts-pool.dashboard.key";
  var RELOAD_MS = 60000;
  var TICK_MS = 1000;

  var gate = document.getElementById("gate");
  var gateError = document.getElementById("gate-error");
  var keyInput = document.getElementById("key");
  var rows = document.getElementById("rows");
  var meta = document.getElementById("meta");
  var latest = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fmtSpan(ms) {
    var minutes = Math.floor(ms / 60000);
    var days = Math.floor(minutes / 1440);
    var hours = Math.floor((minutes % 1440) / 60);
    if (days > 0) return days + "天" + hours + "小时";
    if (hours > 0) return hours + "小时" + (minutes % 60) + "分";
    if (minutes > 0) return minutes + "分";
    return "不到 1 分";
  }

  function fmtLeft(ms) {
    if (!isFinite(ms)) return "未知";
    if (ms <= 0) return "已到期";
    return "剩 " + fmtSpan(ms);
  }

  function showGate(message) {
    gate.hidden = false;
    gateError.hidden = !message;
    gateError.textContent = message || "";
    rows.textContent = "";
    meta.textContent = "";
    meta.className = "";
    keyInput.focus();
  }

  // Clearing the error text as well as hiding the form: a rejected key followed by a good one must
  // not leave "pool key 无效" sitting above a page full of valid data.
  function hideGate() {
    gate.hidden = true;
    gateError.hidden = true;
    gateError.textContent = "";
  }

  function renderMeta() {
    if (latest.at === 0) {
      meta.className = "stale";
      meta.textContent = "尚未完成任何一轮轮询——下面没有可展示的用量数据。";
      return;
    }
    var when = new Date(latest.at).toLocaleTimeString();
    var age = fmtSpan(Date.now() - latest.at);
    if (latest.stale) {
      meta.className = "stale";
      meta.textContent = "数据陈旧：快照采集于 " + when + "（" + age + "前），调度器已停止按它排序，下面的数字不代表当前状态。";
      return;
    }
    meta.className = "";
    meta.textContent = "快照采集于 " + when + "（" + age + "前）· " + latest.accounts.length + " 个 anthropic 账号";
  }

  function renderWindow(win) {
    var row = el("div", "win");
    row.appendChild(el("div", "wl", win.label));
    var bar = el("div", "bar");
    var fill = el("div", "fill" + (win.utilization >= 100 ? " full" : win.utilization >= 80 ? " warn" : ""));
    fill.style.width = Math.max(0, Math.min(100, win.utilization)) + "%";
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(el("div", "pct", Math.round(win.utilization) + "%"));
    row.appendChild(el("div", "reset", win.resetsAt ? fmtLeft(Date.parse(win.resetsAt) - Date.now()) : "重置未知"));
    return row;
  }

  function renderAccount(account) {
    var card = el("article", "card" + (account.coolingDown ? " cooling" : ""));
    var head = el("div", "head");
    head.appendChild(el("span", "label", account.label));
    head.appendChild(el("span", "id", account.idPrefix));
    if (account.coolingDown) head.appendChild(el("span", "badge cool", "冷却中"));
    if (account.needsReauth) head.appendChild(el("span", "badge reauth", "需重新登录"));
    if (account.excluded) head.appendChild(el("span", "badge muted", "不自动切"));
    if (!account.hasUsage) head.appendChild(el("span", "badge muted", "本轮无数据"));
    card.appendChild(head);
    card.appendChild(el("div", "token", account.expiresAt ? "token " + fmtLeft(account.expiresAt - Date.now()) : "token 到期时间未知"));
    if (account.windows.length === 0) {
      card.appendChild(el("div", "empty", account.hasUsage ? "该账号本轮未报告任何窗口。" : "本轮轮询未取到该账号的用量（未知，不是 0%）。"));
    } else {
      for (var i = 0; i < account.windows.length; i++) card.appendChild(renderWindow(account.windows[i]));
    }
    return card;
  }

  function render() {
    if (!latest) return;
    renderMeta();
    rows.textContent = "";
    if (latest.accounts.length === 0) {
      rows.appendChild(el("div", "empty", "池内没有 anthropic 账号。"));
      return;
    }
    for (var i = 0; i < latest.accounts.length; i++) rows.appendChild(renderAccount(latest.accounts[i]));
  }

  function load() {
    var presented = sessionStorage.getItem(KEY_STORE);
    if (!presented) { showGate(""); return; }
    fetch(USAGE_URL, { headers: { Authorization: "Bearer " + presented }, cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) {
          // The stored key is wrong or has been revoked. Dropping it here is what keeps the page
          // from re-sending a dead credential once a minute forever.
          sessionStorage.removeItem(KEY_STORE);
          showGate("pool key 无效或已吊销，请重新输入。");
          return null;
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (payload) {
        if (!payload) return;
        latest = payload;
        hideGate();
        render();
      })
      .catch(function (error) {
        meta.className = "stale";
        meta.textContent = "拉取失败：" + error.message;
      });
  }

  gate.addEventListener("submit", function (event) {
    event.preventDefault();
    var value = keyInput.value.trim();
    if (!value) return;
    sessionStorage.setItem(KEY_STORE, value);
    // Cleared immediately so the live credential does not sit in a DOM node for the rest of the session.
    keyInput.value = "";
    hideGate();
    load();
  });

  load();
  // Two clocks: the countdowns tick locally every second, while the snapshot itself is refetched
  // only once a minute — the master polls the upstream usage API on its own multi-minute schedule,
  // so a faster refetch would just re-serve the same numbers.
  setInterval(render, TICK_MS);
  setInterval(load, RELOAD_MS);
})();
</script>
</body>
</html>
`
}
