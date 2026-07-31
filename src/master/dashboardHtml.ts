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

// Every value below is a compile-time constant owned by this codebase (two frozen CLOUD_ROUTES
// entries and the server's own throttle window), never user input — which is why interpolating them
// into the script needs no escaping. They are parameters rather than literals so the route table and
// the throttle each stay a SINGLE source of truth: a renamed route cannot leave a silently broken
// page behind, and the countdown the page shows cannot drift from the window the server enforces.
export type DashboardConfig = {
  usageRoute: string
  refreshRoute: string
  throttleMs: number
  authorizeRoute: string
  addRoute: string
}

export function dashboardHtml(config: DashboardConfig): string {
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
  .actions { display: flex; align-items: center; gap: 12px; }
  /* The quiet sibling of #refresh: onboarding is rare and destructive-adjacent, so it must not
     compete with the button an operator presses every visit. */
  #add { display: flex; align-items: center; gap: 7px; padding: 7px 14px; font: 500 13px/normal var(--sans);
         border: 1px solid var(--divider); border-radius: 999px; background: var(--card-bg);
         color: #3D3929; cursor: pointer; transition: background 120ms ease, border-color 120ms ease; }
  #add:hover { background: #F0EEE6; border-color: #D3CFC3; }
  #refresh { display: flex; align-items: center; gap: 8px; padding: 7px 14px; font: 500 13px/normal var(--sans);
             border: 1px solid var(--accent); border-radius: 999px; background: var(--accent);
             color: var(--card-bg); cursor: pointer; transition: background 120ms ease; }
  #refresh:hover { background: var(--accent-dark); border-color: var(--accent-dark); }
  #refresh:active { background: #93401F; border-color: #93401F; }
  #refresh:disabled { opacity: 0.75; cursor: default; }
  #refresh .spin { display: flex; align-items: center; }
  /* Animated ONLY while a sweep is in flight, so the spinner is a statement of fact rather than
     decoration: if it is turning, the master is really talking to Anthropic right now. */
  #refresh.busy .spin { animation: spin 800ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

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

  /* ── 添加账号 dialog ───────────────────────────────────────────────────────────────────────────
     Kept in the document from the start and toggled with [hidden] rather than built on demand: the
     markup is fixed, so creating it per open would be the one place this page needed to assemble
     elements under time pressure — which is how a textContent-only rule gets broken. */
  #veil[hidden] { display: none; }
  #veil { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center;
          justify-content: center; padding: 32px; background: rgba(31,30,29,0.28);
          backdrop-filter: blur(2px); animation: fade 160ms ease both; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes pop { from { opacity: 0; transform: translateY(10px) scale(0.97); } to { opacity: 1; transform: none; } }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  #dialog { width: 100%; max-width: 480px; max-height: 100%; overflow-y: auto; padding: 28px 30px 26px;
            display: flex; flex-direction: column; gap: 18px; background: var(--card-bg);
            border: 1px solid var(--divider); border-radius: 16px;
            box-shadow: 0 18px 48px rgba(31,30,29,0.18);
            animation: pop 200ms cubic-bezier(0.2,0.8,0.2,1) both; }
  #dialog h2 { margin: 0; font-family: var(--serif); font-size: 22px; font-weight: 600; }
  .dhead { display: flex; flex-direction: column; gap: 6px; }
  #dsub { margin: 0; font-size: 14px; color: var(--text-2); line-height: 1.5; }
  .stage[hidden] { display: none; }
  .stage { display: flex; flex-direction: column; gap: 14px;
           animation: rise 240ms cubic-bezier(0.2,0.8,0.2,1) both; }

  #d-loading { flex-direction: row; align-items: center; gap: 12px; padding: 26px 20px;
               border: 1px dashed #DEDACE; border-radius: 12px; background: var(--page-bg); }
  .dot-spin { flex: 0 0 auto; display: block; width: 15px; height: 15px; border-radius: 50%;
              border: 2px solid #E0DCCE; border-top-color: var(--accent);
              animation: spin 700ms linear infinite; }
  #d-loading span:last-child { font-size: 14px; color: var(--text-2); }

  .urlbox { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px;
            border: 1px solid var(--card-border); border-radius: 12px; background: var(--chip-bg); }
  .cap { font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-3); }
  /* An anchor, not the design's static span: the issue asks for a link the operator CLICKS. It
     carries noopener noreferrer because the target is a real login page — a tab that can reach back
     into this one via window.opener is not something to hand an authorization flow. */
  #authurl { font-family: var(--mono); font-size: 12.5px; line-height: 1.55; color: #3D3929;
             word-break: break-all; }
  .pill { align-self: flex-start; display: flex; align-items: center; gap: 7px; padding: 8px 16px;
          font: 500 13px/normal var(--sans); border: 1px solid var(--divider); border-radius: 999px;
          background: var(--card-bg); color: #3D3929; cursor: pointer; }
  .pill:hover { background: #F0EEE6; border-color: #D3CFC3; }
  .pill.primary { border-color: var(--accent); background: var(--accent); color: var(--card-bg);
                  transition: background 120ms ease; }
  .pill.primary:hover { background: var(--accent-dark); border-color: var(--accent-dark); }
  .pill:disabled { opacity: 0.75; cursor: default; }
  .pill.primary .spin { display: none; }
  .pill.primary.busy .spin { display: block; width: 12px; height: 12px; border-radius: 50%;
                             border: 2px solid rgba(250,249,245,0.35); border-top-color: var(--card-bg);
                             animation: spin 700ms linear infinite; }
  .rule { height: 1px; background: var(--card-border); }
  .field { display: flex; flex-direction: column; gap: 8px; }
  .field label { font-size: 13px; font-weight: 500; color: #3D3929; }
  #code { width: 100%; padding: 10px 13px; font-family: var(--mono); font-size: 13px;
          color: var(--text); background: #FFFFFF; border: 1px solid var(--divider);
          border-radius: 10px; outline: none;
          transition: border-color 120ms ease, box-shadow 120ms ease; }
  #code:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(193,95,60,0.12); }
  .hint { font-size: 12.5px; color: var(--text-3); line-height: 1.5; }
  .row { display: flex; align-items: center; gap: 10px; }
  /* Only ever filled from a status-code lookup, never from a response body, so a hostile upstream
     string cannot reach the operator's screen through it. */
  #derr { font-size: 13px; color: var(--accent); font-weight: 600; line-height: 1.5; }
  #derr[hidden] { display: none; }

  #d-done { flex-direction: row; align-items: center; gap: 12px; padding: 22px 20px;
            border: 1px solid var(--card-border); border-radius: 12px; background: var(--chip-bg); }
  .tick { flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
          width: 26px; height: 26px; border-radius: 50%; background: var(--accent);
          color: var(--card-bg); }
  #donetext { font-size: 14px; color: #3D3929; }

  @media (max-width: 640px) {
    body { padding: 32px 20px 56px; }
    .card { padding: 20px 18px 18px; }
    .win { grid-template-columns: 1fr 48px; }
    .win .bar, .win .reset { grid-column: 1 / -1; }
    #veil { padding: 16px; }
    #dialog { padding: 22px 18px 20px; }
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
    <div class="actions">
      <div class="ro"><span class="dot"></span><span>只读视图</span></div>
      <button id="add" type="button">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6"></path><path d="M3.2 8h9.6"></path></svg>
        <span>添加账号</span>
      </button>
      <button id="refresh" type="button">
        <span class="spin" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.7 6.6A6 6 0 0 0 3.1 4.6"></path><path d="M2.3 9.4A6 6 0 0 0 12.9 11.4"></path><path d="M13.9 2.6v4h-4"></path><path d="M2.1 13.4v-4h4"></path></svg></span>
        <span id="refresh-label">刷新</span>
      </button>
    </div>
  </header>
  <div id="rows"></div>
  <footer>本页不展示任何 token。除「添加账号」外不提供任何改状态的操作，且该操作只会向池中新增账号，不会切号或删号。</footer>
</div>
<div id="veil" hidden>
  <div id="dialog" role="dialog" aria-modal="true" aria-labelledby="dtitle">
    <div class="dhead">
      <h2 id="dtitle">添加 anthropic 账号</h2>
      <p id="dsub">正在准备 OAuth 授权，请稍候。</p>
    </div>
    <div id="d-loading" class="stage">
      <span class="dot-spin" aria-hidden="true"></span>
      <span>正在生成 Anthropic 授权链接…</span>
    </div>
    <div id="d-ready" class="stage" hidden>
      <div class="urlbox">
        <span class="cap">授权链接</span>
        <a id="authurl" href="#" target="_blank" rel="noopener noreferrer"></a>
      </div>
      <button id="copy" class="pill" type="button"><span id="copylabel">复制链接</span></button>
      <div class="rule"></div>
      <div class="field">
        <label for="code">粘贴授权页返回的 code</label>
        <input id="code" type="text" spellcheck="false" autocomplete="off" placeholder="例如 ac_xxx#state 或整条回调地址">
        <span class="hint">在上面的链接里登录并点「Authorize」后，页面会给出一串 code。整段复制粘贴即可，带不带 state、是不是完整回调网址都能识别。</span>
      </div>
      <p id="derr" hidden></p>
      <div class="row">
        <button id="submit" class="pill primary" type="button" disabled>
          <span class="spin" aria-hidden="true"></span>
          <span id="submitlabel">验证并添加</span>
        </button>
        <button id="cancel" class="pill" type="button">取消</button>
      </div>
    </div>
    <div id="d-done" class="stage" hidden>
      <span class="tick" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-6"></path></svg></span>
      <span id="donetext"></span>
    </div>
    <div id="d-fatal" class="stage" hidden>
      <p id="fatalmsg" class="hint"></p>
      <div class="row">
        <button id="retry" class="pill primary" type="button"><span>重新获取链接</span></button>
        <button id="close2" class="pill" type="button">关闭</button>
      </div>
    </div>
  </div>
</div>
<script>
(function () {
  "use strict";
  var USAGE_URL = "${config.usageRoute}";
  var REFRESH_URL = "${config.refreshRoute}";
  var AUTHORIZE_URL = "${config.authorizeRoute}";
  var ADD_URL = "${config.addRoute}";
  var THROTTLE_MS = ${String(config.throttleMs)};
  var RELOAD_MS = 5000;
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
  var button = document.getElementById("refresh");
  var buttonLabel = document.getElementById("refresh-label");
  var latest = null;
  var sweeping = false;
  // Set when the server refuses a press; while it is in the future the meta line says how long is
  // left instead of the snapshot age, so a disabled-looking button always has a reason next to it.
  var throttledUntil = 0;
  var errorText = "";
  // In-flight marker for load(). Four things now ask for a snapshot — the interval and the three
  // wake-up listeners below — and a single switch back to this window can fire two listeners at once,
  // so overlapping GETs are ordinary here rather than rare.
  var loading = false;

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

  function snapshotText() {
    if (!latest) return "加载中…";
    if (latest.at === 0) return "尚未完成任何一轮轮询——按「刷新」立即采集一次，否则要等下一个轮询周期(5 分钟)。";
    var when = new Date(latest.at).toLocaleTimeString();
    // CLAMPED, because the snapshot instant is stamped by the MASTER's clock while this age is
    // measured against the BROWSER's: a few seconds of skew between two hosts is ordinary and must
    // read as "0 秒", never as a negative age.
    var ageMs = Math.max(0, Date.now() - latest.at);
    // SECONDS below a minute, and that is the half of this fix an operator actually SEES. Every sweep
    // that arrives from outside this tab — a worker pressing r, another operator's tab, the
    // scheduled poll — lands inside that first minute, and fmtSpan's flat "不到 1 分" renders
    // identically on both sides of it, so the one line being watched would sit still at the exact
    // moment it had just updated. With seconds, the existing 1s tick makes the new snapshot land
    // visibly. fmtSpan is deliberately NOT widened: fmtLeft's per-account token countdown shares it,
    // and that is a different surface with no such requirement.
    var age = ageMs < 60000 ? Math.floor(ageMs / 1000) + " 秒" : fmtSpan(ageMs);
    if (latest.stale) {
      return "数据陈旧：快照采集于 " + when + "（" + age + "前），调度器已停止按它排序，下面的数字不代表当前状态。";
    }
    return "快照采集于 " + when + "（" + age + "前）· " + latest.accounts.length + " 个 anthropic 账号";
  }

  // Precedence is deliberate: what is happening RIGHT NOW beats a failure, which beats the snapshot's
  // own age. Rebuilt from state on every tick rather than written at the point of each event — the
  // one-second re-render used to erase a fetch error a moment after it appeared, because whoever set
  // the text was racing the timer that rewrote it.
  function renderMeta() {
    if (sweeping) {
      meta.className = "";
      meta.textContent = "正在采集全池用量…";
      return;
    }
    if (errorText) {
      meta.className = "stale";
      meta.textContent = errorText;
      return;
    }
    var wait = throttledUntil - Date.now();
    var suffix = wait > 0 ? "（刚刚已采集，" + Math.ceil(wait / 1000) + " 秒后可再刷新）" : "";
    meta.className = latest && (latest.stale || latest.at === 0) ? "stale" : "";
    meta.textContent = snapshotText() + suffix;
  }

  function syncButton() {
    var waiting = throttledUntil - Date.now() > 0;
    button.disabled = sweeping || waiting;
    button.className = sweeping ? "busy" : "";
    buttonLabel.textContent = sweeping ? "刷新中…" : "刷新";
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
    renderMeta();
    syncButton();
    if (!latest) return;
    rows.textContent = "";
    if (latest.accounts.length === 0) {
      rows.appendChild(el("div", "empty", "池内没有 anthropic 账号。"));
      return;
    }
    for (var i = 0; i < latest.accounts.length; i++) rows.appendChild(renderAccount(latest.accounts[i]));
  }

  function load() {
    // Dropped rather than queued: every caller wants the SAME thing — the current snapshot — so a
    // second concurrent GET could only answer with what the first one is already about to deliver.
    // This is also what keeps a slow FAILED response from painting 拉取失败 over data that is fine,
    // which the monotonic guard below cannot do because it only governs the snapshot.
    if (loading) return;
    loading = true;
    fetch(USAGE_URL, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (payload) {
        // NEVER GO BACKWARDS. The 刷新 button's POST is a second in-flight channel single-flight cannot
        // see, so a GET issued before that sweep can land after it, carrying the OLDER instant, and
        // undo the very update this page exists to show. An instant of 0 is exempt because that is how a
        // RESTARTED master reports "not swept yet" — refusing it would hide that honest notice behind
        // whatever snapshot this tab happened to still be holding, forever.
        if (payload.at === 0 || !latest || payload.at >= latest.at) latest = payload;
        // Cleared OUTSIDE the guard: a 200 proves the master answered, so a previous fetch error is
        // stale news even when this particular body lost the race described above.
        errorText = "";
        render();
      })
      .catch(function (error) {
        errorText = "拉取失败：" + error.message;
        render();
      })
      .then(function () {
        loading = false;
      });
  }

  // Asks the master to sweep NOW rather than re-reading the snapshot it already has: pressing 刷新 and
  // landing on the same timestamp would be a button that lies about having done something.
  function refresh() {
    if (sweeping || throttledUntil - Date.now() > 0) return;
    sweeping = true;
    errorText = "";
    render();
    fetch(REFRESH_URL, { method: "POST", cache: "no-store" })
      .then(function (res) {
        if (res.status === 429) {
          // The server owns the window, so its figure is the one to trust; the fallback only covers a
          // body we could not read, and erring long is right — erring short re-presses into a refusal.
          return res.json().catch(function () { return null; }).then(function (body) {
            var wait = body && typeof body.retryAfterMs === "number" && body.retryAfterMs > 0 ? body.retryAfterMs : 30000;
            throttledUntil = Date.now() + wait;
            return null;
          });
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (payload) {
        if (payload) latest = payload;
        // Every accepted sweep starts the server's window, so mirror it locally instead of waiting to
        // be refused: the button goes quiet for the same period the master would have refused anyway.
        if (payload) throttledUntil = Date.now() + THROTTLE_MS;
      })
      .catch(function (error) {
        errorText = "刷新失败：" + error.message;
      })
      .then(function () {
        sweeping = false;
        render();
      });
  }

  button.addEventListener("click", refresh);

  // ── 添加账号 ──────────────────────────────────────────────────────────────────────────────────
  // A four-stage dialog (loading / ready / done / fatal) over the two onboarding routes. The split
  // that drives it is the server's: a 400 is recoverable and keeps the pasted value on screen, while
  // 410 and 502 mean this PKCE session is spent and only a new link can help.
  var veil = document.getElementById("veil");
  var dsub = document.getElementById("dsub");
  var stages = {
    loading: document.getElementById("d-loading"),
    ready: document.getElementById("d-ready"),
    done: document.getElementById("d-done"),
    fatal: document.getElementById("d-fatal")
  };
  var authAnchor = document.getElementById("authurl");
  var codeInput = document.getElementById("code");
  var submitButton = document.getElementById("submit");
  var submitLabel = document.getElementById("submitlabel");
  var copyButton = document.getElementById("copy");
  var copyLabel = document.getElementById("copylabel");
  var errorLine = document.getElementById("derr");
  var doneText = document.getElementById("donetext");
  var fatalMessage = document.getElementById("fatalmsg");

  var SUBTITLES = {
    loading: "正在准备 OAuth 授权，请稍候。",
    ready: "打开链接完成登录授权，然后把返回的 code 粘贴回来。",
    done: "添加成功。",
    fatal: "本次授权没有完成。"
  };
  // Keyed by STATUS, never by the response body: the body's error field is a machine-readable reason
  // for the log, and echoing a server string into the DOM is the habit this page exists without.
  var ADD_ERRORS = {
    400: "这段 code 没有被接受。常见原因是复制不完整、已经用过一次，或者跟本次链接不是同一份授权——回到授权页重新取一段再试。",
    410: "本次授权会话已失效：可能超过了 10 分钟，或者尝试次数已用尽。请重新获取链接。",
    429: "操作太频繁，请稍候再试。",
    502: "授权本身成功了，但读取账号信息失败，账号没有入池。请重新获取链接再走一遍。"
  };
  // 410 and 502 are terminal for the session; everything else leaves the operator on the form.
  var FATAL_STATUS = { 410: true, 502: true };

  var addStage = "loading";
  var pendingId = "";
  var submitting = false;
  var closeTimer = 0;
  var copyTimer = 0;

  function showStage(name) {
    addStage = name;
    for (var key in stages) {
      if (owns.call(stages, key)) stages[key].hidden = key !== name;
    }
    dsub.textContent = owns.call(SUBTITLES, name) ? SUBTITLES[name] : "";
  }

  function setError(text) {
    errorLine.textContent = text;
    errorLine.hidden = !text;
  }

  function syncSubmit() {
    submitButton.disabled = submitting || codeInput.value.trim().length === 0;
    submitButton.className = submitting ? "pill primary busy" : "pill primary";
    submitLabel.textContent = submitting ? "验证中…" : "验证并添加";
  }

  function closeDialog() {
    clearTimeout(closeTimer);
    veil.hidden = true;
    pendingId = "";
    submitting = false;
  }

  // Asks for a fresh PKCE session every time the dialog opens. Deliberately NOT cached across opens:
  // a session the operator abandoned is one the server may already have evicted, and reusing a dead
  // pendingId would fail at the worst moment — after they had gone and authorized in the browser.
  function beginAdd() {
    clearTimeout(closeTimer);
    veil.hidden = false;
    pendingId = "";
    submitting = false;
    codeInput.value = "";
    setError("");
    copyLabel.textContent = "复制链接";
    showStage("loading");
    syncSubmit();
    fetch(AUTHORIZE_URL, { method: "POST", cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (payload) {
        pendingId = payload.pendingId;
        // href AND textContent from the same value: the anchor is what the issue asks the operator to
        // click, and showing a different string than the one it navigates to is how a link becomes a
        // thing nobody can verify.
        authAnchor.href = payload.url;
        authAnchor.textContent = payload.url;
        showStage("ready");
        syncSubmit();
        codeInput.focus();
      })
      .catch(function (error) {
        fatalMessage.textContent = "获取授权链接失败：" + error.message;
        showStage("fatal");
      });
  }

  // execCommand, not the Clipboard API, as the FALLBACK — and it is the path that actually runs here
  // most of the time. navigator.clipboard is gated on a SECURE CONTEXT, and this master is routinely
  // reached over plain HTTP on a tailnet address, where that object does not exist at all.
  function legacyCopy(text) {
    var scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.position = "fixed";
    scratch.style.top = "-1000px";
    document.body.appendChild(scratch);
    scratch.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (error) {
      ok = false;
    }
    document.body.removeChild(scratch);
    return ok;
  }

  function flashCopied(ok) {
    // On failure the anchor is selected instead, so the operator always has a way out: the link is
    // right there and now highlighted for a manual copy.
    copyLabel.textContent = ok ? "已复制" : "复制失败，请手动选择";
    if (!ok) {
      var range = document.createRange();
      range.selectNodeContents(authAnchor);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(function () { copyLabel.textContent = "复制链接"; }, 1800);
  }

  function copyUrl() {
    var text = authAnchor.textContent;
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { flashCopied(true); }, function () {
        flashCopied(legacyCopy(text));
      });
      return;
    }
    flashCopied(legacyCopy(text));
  }

  function submitCode() {
    if (submitting || !pendingId) return;
    var code = codeInput.value.trim();
    if (!code) return;
    submitting = true;
    setError("");
    syncSubmit();
    fetch(ADD_URL, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pendingId: pendingId, code: code })
    })
      .then(function (res) {
        if (res.ok) return res.json();
        // Read as a STATUS, not as text to display. The 429 body is the only one consulted, and only
        // for its number, so the page can name the wait instead of showing a dead button.
        if (res.status === 429) {
          return res.json().catch(function () { return null; }).then(function (body) {
            var wait = body && typeof body.retryAfterMs === "number" && body.retryAfterMs > 0 ? body.retryAfterMs : 3000;
            throw { status: 429, waitMs: wait };
          });
        }
        throw { status: res.status };
      })
      .then(function (payload) {
        // The pool grew only when the uuid was new. Saying so plainly beats a uniform "成功", which
        // would let an operator re-authorising an existing account believe they had added a second one.
        doneText.textContent = payload.existing
          ? "该账号已在池中（" + payload.label + "），凭据已更新。"
          : "账号 " + payload.label + " 已加入池中，将在下一轮采集用量。";
        showStage("done");
        // The roster on the page behind the dialog is now out of date by exactly one account.
        load();
        closeTimer = setTimeout(closeDialog, 2600);
      })
      .catch(function (failure) {
        var status = failure && failure.status;
        if (status === 429) {
          setError(ADD_ERRORS[429] + "（约 " + Math.ceil(failure.waitMs / 1000) + " 秒）");
          return;
        }
        if (status && FATAL_STATUS[status]) {
          fatalMessage.textContent = ADD_ERRORS[status];
          showStage("fatal");
          return;
        }
        setError(status && owns.call(ADD_ERRORS, status) ? ADD_ERRORS[status] : "提交失败：" + (failure && failure.message ? failure.message : "网络错误"));
      })
      .then(function () {
        submitting = false;
        syncSubmit();
      });
  }

  document.getElementById("add").addEventListener("click", beginAdd);
  document.getElementById("cancel").addEventListener("click", closeDialog);
  document.getElementById("close2").addEventListener("click", closeDialog);
  document.getElementById("retry").addEventListener("click", beginAdd);
  copyButton.addEventListener("click", copyUrl);
  submitButton.addEventListener("click", submitCode);
  codeInput.addEventListener("input", function () {
    setError("");
    syncSubmit();
  });
  codeInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") submitCode();
  });
  // Backdrop click closes, but only when the backdrop ITSELF was hit: without the target check a drag
  // that started inside the dialog and ended on the veil would discard a half-typed code.
  veil.addEventListener("mousedown", function (event) {
    if (event.target === veil) closeDialog();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !veil.hidden) closeDialog();
  });

  // ── WAKING UP ─────────────────────────────────────────────────────────────────────────────────
  // The interval below CANNOT carry this on its own, and that is the whole point of these three.
  // Sweeps now arrive that this tab never sees coming — a worker pressing r and another operator's
  // tab both drive POST /v1/usage/refresh — and the operator watching for the result is, by
  // definition, somewhere else at the time. A browser throttles a HIDDEN page's timers hard (Chrome
  // clamps them to roughly one a minute once it has been hidden a few minutes, and Page Lifecycle may
  // freeze them outright), so the tab that most needs to catch up is exactly the one whose interval
  // has stopped running. Each listener below covers a return path the other two cannot see; none is
  // redundant, so do not "simplify" this to one.
  document.addEventListener("visibilitychange", function () {
    // Switching back to this tab in the same window. Also the only one of the three that fires when a
    // window becomes un-occluded without being clicked, where the platform reports occlusion at all.
    if (!document.hidden) load();
  });
  window.addEventListener("focus", function () {
    // THE CASE THIS FIX IS ACTUALLY ABOUT. While the browser window sits behind the terminal the
    // operator is typing in, visibilityState stays "visible" on macOS — so visibilitychange never
    // fires, and Cmd-Tabbing back is reported ONLY here.
    load();
  });
  window.addEventListener("pageshow", function (event) {
    // Restored from the back/forward cache, where the page resumes with everything frozen mid-flight.
    // Guarded on the persisted flag so a normal navigation does not double the load() below.
    if (event.persisted) load();
  });

  load();
  // Two clocks. The countdowns (and the throttle's own countdown) tick locally every second, while the
  // snapshot is refetched every few seconds — deliberately far below the 30s window the server
  // enforces on forced sweeps, so a sweep triggered anywhere in the pool shows up here promptly
  // instead of aging silently. This is NOT the page trying to outrun the master's own multi-minute
  // poll: it is what covers the tab that stayed visible while somebody else pressed 刷新.
  setInterval(render, TICK_MS);
  setInterval(load, RELOAD_MS);
})();
</script>
</body>
</html>
`
}
