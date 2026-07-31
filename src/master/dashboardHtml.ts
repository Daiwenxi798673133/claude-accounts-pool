// The read-only dashboard's HTML page: ONE string, zero dependencies, zero build step. It holds no
// data of its own — it fetches the JSON route below and renders it — so the document is identical
// for every viewer and can be built once at startup.
//
// DATA REACHES THE DOM THROUGH textContent AND style.width ONLY, NEVER innerHTML. `label` is an
// account email that originated in a profile response, and rendering pool-derived text as markup is
// how a monitoring page becomes an XSS vector. This matters MORE now that the page is unauthenticated
// (see the decision recorded on CLOUD_ROUTES.usage): there is no key gate in front of it to slow an
// attacker who found a way to influence a label.
//
// The script is written in ES5-ish `var` / string-concatenation style on purpose: it is embedded in a
// TS template literal, so every backtick and every `${` inside it would need escaping and would be
// one typo away from a page that fails to parse — with no compiler watching. The same rule binds the
// CSS and the markup below: no backtick and no `${` anywhere in the document, not even inside a
// comment, except the single `${usageRoute}` interpolation.
//
// The look is Claude's warm-cream light theme. Its palette lives in `:root` custom properties and is
// applied through classes rather than inline styles, because inline styles cannot express the
// `@media` collapse or the state classes (`.cooling`, `.stale`, the four bar tones) this page needs
// in order to show the states a happy-path mock never has to.

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
  /* NO WEBFONT LINK, ON PURPOSE — do not "restore" one. The design this page copies loads Noto
     Serif SC / Noto Sans SC / IBM Plex Mono from fonts.googleapis.com. This page must not: an
     operator opens it precisely when the network or the pool is broken, and the master may run on a
     host with no internet route at all, so typography that depends on a remote fetch degrades
     exactly when the page is needed. The stacks below ask for those faces locally, then fall back. */
  :root {
    --serif: ui-serif, "Songti SC", "Noto Serif SC", Georgia, serif;
    --sans: ui-sans-serif, -apple-system, "PingFang SC", "Noto Sans SC", "Segoe UI", sans-serif;
    --mono: ui-monospace, "SF Mono", "IBM Plex Mono", Menlo, monospace;
    --page-bg: #F5F4EE;
    --card-bg: #FAF9F5;
    --card-border: #E9E6DC;
    --divider: #E3E0D6;
    --chip-bg: #F0EEE5;
    --text: #1F1E1D;
    --text-2: #6F6B60;
    --text-3: #908B7D;
    --accent: #C15F3C;
    --accent-soft: #D9865E;
    --accent-dark: #A34A2A;
    --bar-track: #EBE8DE;
    --bar-zero: #C8C3B4;
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 56px 48px 80px; background: var(--page-bg); color: var(--text);
         font: 14px/1.5 var(--sans); }
  .wrap { max-width: 1180px; margin: 0 auto; display: flex; flex-direction: column; gap: 32px; }

  header { display: flex; align-items: flex-end; justify-content: space-between; gap: 32px;
           flex-wrap: wrap; padding-bottom: 24px; border-bottom: 1px solid var(--divider); }
  .titles { display: flex; flex-direction: column; gap: 10px; }
  h1 { margin: 0; font-family: var(--serif); font-size: 38px; font-weight: 600;
       letter-spacing: -0.01em; }
  #meta { margin: 0; font-size: 15px; color: var(--text-2); }
  #meta.stale { color: var(--accent); font-weight: 600; }
  .ro { display: flex; align-items: center; gap: 8px; padding: 7px 14px; font-size: 13px;
        border: 1px solid var(--divider); border-radius: 999px; background: var(--card-bg);
        color: var(--text-2); }
  .ro .dot { flex: 0 0 auto; display: block; width: 7px; height: 7px; border-radius: 50%;
             background: var(--accent); }

  #rows { display: flex; flex-direction: column; gap: 20px; }
  .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 14px;
          padding: 26px 30px 22px; box-shadow: 0 1px 2px rgba(31,30,29,0.04); }
  .card.cooling { border-color: var(--accent); }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 20px;
          flex-wrap: wrap; margin-bottom: 22px; }
  .who { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .label { margin: 0; font-size: 19px; font-weight: 700; letter-spacing: -0.005em; }
  .id { font-family: var(--mono); font-size: 12px; color: var(--text-3);
        background: var(--chip-bg); border-radius: 5px; padding: 3px 7px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid currentColor; }
  .badge.cool { color: var(--accent); }
  .badge.reauth { color: var(--accent-soft); }
  .badge.muted { color: var(--text-3); }
  .token { font-size: 14px; color: var(--text-2); }

  .wins { display: flex; flex-direction: column; gap: 14px; }
  .win { display: grid; grid-template-columns: 130px 1fr 56px 110px; align-items: center; gap: 18px; }
  .wl { font-family: var(--mono); font-size: 13px; color: var(--text-2);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { height: 8px; border-radius: 999px; background: var(--bar-track); overflow: hidden; }
  /* Four tones, darkest = most severe: a maxed window must never read as calmer than a busy one. */
  .fill { height: 100%; border-radius: 999px; background: var(--accent-soft); }
  .fill.zero { background: var(--bar-zero); }
  .fill.high { background: var(--accent); }
  .fill.max { background: var(--accent-dark); }
  .pct { font-family: var(--mono); font-size: 14px; font-variant-numeric: tabular-nums;
         text-align: right; color: var(--text); }
  /* LEFT-aligned, hugging the percentage, as the local-mode panel packs it. Pinned to the far right
     it read as a detached fourth column — and on rows whose reset is omitted it left a hole. */
  .reset { font-size: 13px; text-align: left; color: var(--text-2); white-space: nowrap; }
  /* A 0% window is deliberately de-emphasised — it is the row with nothing to look at. */
  .pct.dim, .reset.dim { color: var(--text-3); }

  .empty { font-size: 13px; color: var(--text-3); }
  footer { margin: 4px 0 0; font-size: 13px; color: var(--text-3); line-height: 1.6; }

  @media (max-width: 640px) {
    body { padding: 32px 20px 56px; }
    .card { padding: 20px 18px 18px; }
    .win { grid-template-columns: 1fr 48px; }
    .win .bar, .win .reset { grid-column: 1 / -1; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="titles">
      <h1>账号池用量</h1>
      <p id="meta">加载中…</p>
    </div>
    <div class="ro"><span class="dot"></span><span>只读视图</span></div>
  </header>
  <div id="rows"></div>
  <footer>只读视图：不含任何 token，也不提供任何改状态的操作。</footer>
</div>
<script>
(function () {
  "use strict";
  var USAGE_URL = "${usageRoute}";
  var RELOAD_MS = 60000;
  var TICK_MS = 1000;

  // The fixed windows get a short display form; anything else — a dynamic per-model weekly window
  // such as "Fable" — passes through UNCHANGED. A lookup with a pass-through fallback, never a
  // chain of ifs, so a window label we have never seen is shown rather than silently dropped.
  var SHORT_LABELS = {
    five_hour: "5h",
    seven_day: "7d",
    seven_day_sonnet: "7d sonnet",
    seven_day_opus: "7d opus"
  };
  var owns = Object.prototype.hasOwnProperty;

  var rows = document.getElementById("rows");
  var meta = document.getElementById("meta");
  var latest = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function shortLabel(label) {
    // hasOwnProperty, not a bare lookup: a pool-derived label of "constructor" must not resolve to
    // something off Object.prototype.
    return owns.call(SHORT_LABELS, label) ? SHORT_LABELS[label] : label;
  }

  function fmtSpan(ms) {
    var minutes = Math.floor(ms / 60000);
    var days = Math.floor(minutes / 1440);
    var hours = Math.floor((minutes % 1440) / 60);
    if (days > 0) return days + " 天 " + hours + " 小时";
    if (hours > 0) return hours + " 小时 " + (minutes % 60) + " 分";
    if (minutes > 0) return minutes + " 分";
    return "不到 1 分";
  }

  function fmtLeft(ms) {
    if (!isFinite(ms)) return "未知";
    if (ms <= 0) return "已到期";
    return "剩 " + fmtSpan(ms);
  }

  // The local-mode /usage panel's resetIn(), reproduced deliberately so a window's countdown reads
  // the same in both surfaces: compact units, and "now" for a deadline that has already passed.
  function resetIn(iso) {
    var ms = Date.parse(iso) - Date.now();
    if (!isFinite(ms)) return "";
    if (ms <= 0) return "now";
    var hours = Math.floor(ms / 3600000);
    var minutes = Math.floor((ms % 3600000) / 60000);
    if (hours >= 24) return Math.floor(hours / 24) + "d " + (hours % 24) + "h";
    if (hours > 0) return hours + "h " + minutes + "m";
    return minutes + "m";
  }

  function renderMeta() {
    if (latest.at === 0) {
      meta.className = "stale";
      meta.textContent = "尚未完成任何一轮轮询——master 重启后首轮用量采集要等一个轮询周期(5 分钟)。";
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
    var used = win.utilization;
    var tone = used >= 100 ? " max" : used >= 70 ? " high" : used > 0 ? "" : " zero";
    var quiet = used > 0 ? "" : " dim";

    var row = el("div", "win");
    row.appendChild(el("div", "wl", shortLabel(win.label)));
    var bar = el("div", "bar");
    var fill = el("div", "fill" + tone);
    fill.style.width = Math.max(0, Math.min(100, used)) + "%";
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(el("div", "pct" + quiet, Math.round(used) + "%"));
    // A window with no resetsAt renders NOTHING here — the same conditional the local-mode panel
    // applies (it wraps the reset text in a Show gated on resets_at). A placeholder like "重置未知"
    // was worse than silence: an idle window at 0% legitimately has no reset instant because it never
    // started, so those words announced a data gap where there was none, making a healthy idle
    // account look like one the poller had failed to reach.
    row.appendChild(el("div", "reset" + quiet, win.resetsAt ? "重置 " + resetIn(win.resetsAt) : ""));
    return row;
  }

  function renderAccount(account) {
    var card = el("article", "card" + (account.coolingDown ? " cooling" : ""));
    var head = el("div", "head");
    var who = el("div", "who");
    who.appendChild(el("h2", "label", account.label));
    who.appendChild(el("span", "id", account.idPrefix));
    if (account.coolingDown) who.appendChild(el("span", "badge cool", "冷却中"));
    if (account.needsReauth) who.appendChild(el("span", "badge reauth", "需重新登录"));
    if (account.excluded) who.appendChild(el("span", "badge muted", "不自动切"));
    // Without this badge an account the poller could not reach would look exactly like a healthy
    // one sitting at 0%. That confusion is the whole reason this page exists.
    if (!account.hasUsage) who.appendChild(el("span", "badge muted", "本轮无数据"));
    head.appendChild(who);
    head.appendChild(el("span", "token", account.expiresAt ? "token " + fmtLeft(account.expiresAt - Date.now()) : "token 到期时间未知"));
    card.appendChild(head);
    if (account.windows.length === 0) {
      card.appendChild(el("div", "empty", account.hasUsage ? "该账号本轮未报告任何窗口。" : "本轮轮询未取到该账号的用量（未知，不是 0%）。"));
    } else {
      var wins = el("div", "wins");
      for (var i = 0; i < account.windows.length; i++) wins.appendChild(renderWindow(account.windows[i]));
      card.appendChild(wins);
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
    fetch(USAGE_URL, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (payload) {
        latest = payload;
        render();
      })
      .catch(function (error) {
        meta.className = "stale";
        meta.textContent = "拉取失败：" + error.message;
      });
  }

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
