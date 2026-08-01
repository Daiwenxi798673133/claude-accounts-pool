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
  registerRoute: string
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
  .actions { display: flex; align-items: center; gap: 12px; }
  /* The two quiet siblings of #refresh, sharing ONE rule because they are the same statement of
     rank: onboarding a machine and onboarding an account are both rare and both
     destructive-adjacent, so neither may compete with the button an operator presses every visit.
     #refresh stays the only accent-filled button on the page. */
  #claim, #add { display: flex; align-items: center; gap: 7px; padding: 7px 14px; font: 500 13px/normal var(--sans);
         border: 1px solid var(--divider); border-radius: 999px; background: var(--card-bg);
         color: #3D3929; cursor: pointer; transition: background 120ms ease, border-color 120ms ease; }
  #claim:hover, #add:hover { background: #F0EEE6; border-color: #D3CFC3; }
  /* The design tints the key glyph accent while leaving the label at text colour. A CSS declaration
     rather than a stroke attribute, so the palette stays in the custom properties above. */
  #claim svg { stroke: var(--accent); }
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

  /* auto-fill, NOT auto-fit: auto-fit collapses the empty tracks, so a single-account pool would get
     one card stretched across the whole 1180px .wrap — the full-width row this layout exists to end.
     Inside that .wrap the 320px minimum yields exactly 3 columns, degrading to 2 then 1 on its own,
     which is why the narrower card needs no media query of its own. */
  #rows { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px;
          align-items: start; }
  .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 18px;
          padding: 22px 22px 20px; box-shadow: 0 1px 2px rgba(31,30,29,0.04);
          display: flex; flex-direction: column; gap: 18px; }
  .card.cooling { border-color: var(--accent); }
  /* Column, not a baseline-aligned row: in a ~350px card the label and the expiry line have no room
     to sit side by side. The card's own gap now owns the space this rule's margin-bottom used to. */
  .head { display: flex; flex-direction: column; gap: 10px; }
  .who { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .label { margin: 0; font-size: 19px; font-weight: 700; letter-spacing: -0.005em;
           word-break: break-all; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid currentColor; }
  .badge.cool { color: var(--accent); }
  .badge.reauth { color: var(--accent-soft); }
  .badge.muted { color: var(--text-3); }
  .token { font-size: 14px; color: var(--text-2); }

  .wins { display: flex; flex-direction: column; gap: 14px; }
  .win { display: flex; flex-direction: column; gap: 7px; }
  .win-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .win-right { display: flex; align-items: baseline; gap: 10px; }
  .wl { font-family: var(--mono); font-size: 13px; color: var(--text-2); min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { height: 8px; border-radius: 999px; background: var(--bar-track); overflow: hidden; }
  /* Four tones, darkest = most severe: a maxed window must never read as calmer than a busy one. */
  .fill { height: 100%; border-radius: 999px; background: var(--accent-soft); }
  .fill.zero { background: var(--bar-zero); }
  .fill.high { background: var(--accent); }
  .fill.max { background: var(--accent-dark); }
  .pct { font-family: var(--mono); font-size: 15px; font-variant-numeric: tabular-nums;
         font-weight: 700; color: var(--text); }
  /* The reset now hugs the percentage on the window's OWN header line, above a full-width bar, as the
     local-mode panel packs it. Neither needs a text-align any more: there is no fixed column left to
     align inside. Pinned to the far right of one it read as a detached fourth column — and on rows
     whose reset is omitted it left a hole. */
  .reset { font-size: 13px; color: var(--text-2); white-space: nowrap; }
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
  #code, #wlabel { width: 100%; padding: 10px 13px; font-family: var(--mono); font-size: 13px;
          color: var(--text); background: #FFFFFF; border: 1px solid var(--divider);
          border-radius: 10px; outline: none;
          transition: border-color 120ms ease, box-shadow 120ms ease; }
  #code:focus, #wlabel:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(193,95,60,0.12); }
  /* The machine's name is the one thing typed in this flow, so it gets more room than a pasted
     code does — and it is the string the operator will read back off a terminal. */
  #wlabel { padding: 12px 14px; font-size: 15px; }
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

  /* ── 领取 key stages, sharing the dialog above ────────────────────────────────────────────────
     Every colour below resolves to a :root custom property already declared at the top of this
     sheet, or to an rgba() of the accent — the same idiom #code:focus already uses. The design this
     copies ships its own near-identical hex palette; a second set of literals would be two sources
     of truth for one theme. */
  /* The 480px shell fits a pasted code. It does NOT fit a 95-column bash command, and wrapping that
     command mid-flag is what makes a copy-paste block unreadable. Applied per FLOW, not globally,
     so the 添加账号 dialog keeps the width it was designed at. */
  #dialog.wide { max-width: 680px; }
  #d-key { gap: 22px; }
  .row.end { justify-content: flex-end; }
  .mono { font-family: var(--mono); }
  .keyrow { display: flex; align-items: stretch; gap: 10px; }
  /* nowrap + overflow-x, never wrapping: a 43-character secret broken across two lines invites a
     partial selection, and a partial pool key fails with an indistinguishable 401. */
  #poolkey { flex: 1; min-width: 0; display: flex; align-items: center; padding: 0 14px;
             height: 42px; border: 1px solid var(--divider); border-radius: 10px;
             background: #FFFFFF; font-family: var(--mono); font-size: 14px; color: var(--text);
             overflow-x: auto; white-space: nowrap; }
  #copykey { flex: 0 0 auto; align-self: stretch; border-radius: 10px; }
  .cmdblock { display: flex; flex-direction: column; gap: 10px; }
  .cmdcap { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
  .linkish { padding: 0; border: none; background: none; font: 13px/normal var(--sans);
             color: var(--accent); cursor: pointer; }
  .linkish:hover { text-decoration: underline; }
  .codebox { border: 1px solid var(--card-border); border-radius: 12px; background: #FFFFFF;
             overflow: hidden; }
  .codehead { display: flex; align-items: center; justify-content: space-between; gap: 12px;
              padding: 8px 10px 8px 16px; border-bottom: 1px solid var(--card-border);
              background: var(--page-bg); }
  .codehead .mono { font-size: 12px; color: var(--text-3); }
  .pill.tiny { align-self: auto; padding: 5px 14px; font-size: 12.5px; border-radius: 8px; }
  /* pre-wrap, not pre: the block must stay copyable as ONE command, so its newlines are real and
     its overlong first line has to fold rather than scroll out of sight. */
  .codebox pre { margin: 0; padding: 16px 18px; font-family: var(--mono); font-size: 12.5px;
                 line-height: 1.8; color: #3D3929; white-space: pre-wrap; overflow-wrap: anywhere; }
  .detail { display: flex; flex-direction: column; gap: 16px; padding: 20px;
            border: 1px solid var(--card-border); border-radius: 12px; background: var(--chip-bg); }
  /* Needed for the same reason .stage[hidden] is: the display above outranks the UA's [hidden]. */
  .detail[hidden] { display: none; }
  .dfile { display: flex; flex-direction: column; gap: 8px; }
  .dfile code { font-family: var(--mono); font-size: 12.5px; color: #3D3929; }
  .dfile pre { margin: 0; padding: 14px 16px; border: 1px solid var(--card-border);
               border-radius: 10px; background: #FFFFFF; font-family: var(--mono); font-size: 12px;
               line-height: 1.75; color: #3D3929; white-space: pre-wrap; overflow-wrap: anywhere; }
  .warns { display: flex; flex-direction: column; gap: 12px; padding: 18px 20px;
           border: 1px solid rgba(193,95,60,0.28); border-radius: 12px;
           background: rgba(193,95,60,0.05); }
  .warn { display: flex; gap: 12px; font-size: 13.5px; line-height: 1.6; color: #3D3929; }
  .warn .wn { flex: 0 0 auto; font-family: var(--mono); color: var(--accent); }
  .warn code { font-family: var(--mono); }
  /* Same rule as #derr, and the same reason: filled ONLY from a status-code lookup. */
  #cerr { font-size: 13px; color: var(--accent); font-weight: 600; line-height: 1.5; }
  #cerr[hidden] { display: none; }

  @media (max-width: 640px) {
    body { padding: 32px 20px 56px; }
    .card { padding: 20px 18px 18px; }
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
      <button id="claim" type="button">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8.5" cy="15.5" r="4"></circle><path d="M11.4 12.6 20.5 3.5"></path><path d="M16.8 7.2l2.6 2.6"></path></svg>
        <span>领取 key</span>
      </button>
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
  <footer>本页不展示任何 token 明文。「领取 key」只向 registry 新签发一把 worker key（库里只存 SHA-256 摘要），「添加账号」只向池中新增账号，都不会切号或删号。</footer>
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
    <div id="d-claim" class="stage" hidden>
      <div class="field">
        <label class="cap" for="wlabel">WORKER 标签</label>
        <input id="wlabel" type="text" spellcheck="false" autocomplete="off" placeholder="vince-laptop">
        <span class="hint mono">a-z 0-9 - · 建议用主机名</span>
      </div>
      <p id="cerr" hidden></p>
      <div class="row end">
        <button id="ccancel" class="pill" type="button">取消</button>
        <button id="issue" class="pill primary" type="button" disabled>
          <span class="spin" aria-hidden="true"></span>
          <span id="issuelabel">签发 key</span>
        </button>
      </div>
    </div>
    <div id="d-key" class="stage" hidden>
      <div class="urlbox">
        <span class="cap">pool key · 43 字符</span>
        <div class="keyrow">
          <code id="poolkey"></code>
          <button id="copykey" class="pill" type="button"><span id="copykeylabel">复制 key</span></button>
        </div>
      </div>
      <div class="cmdblock">
        <div class="cmdcap">
          <span class="cap">一键配置命令</span>
          <button id="expand" class="linkish" type="button">展开查看命令改了什么</button>
        </div>
        <div class="codebox">
          <div class="codehead">
            <span class="mono">bash</span>
            <button id="copycmd" class="pill primary tiny" type="button"><span id="copycmdlabel">复制命令</span></button>
          </div>
          <pre id="cmd"></pre>
        </div>
        <span class="hint">需要 bun。dist/ 不入库，所以要本机 clone + build。脚本幂等，重复执行会替换旧条目而不是追加。</span>
      </div>
      <div id="detail" class="detail" hidden>
        <span class="hint">脚本只做幂等 merge，改动这两个文件：</span>
        <div class="dfile">
          <code>~/.config/opencode/opencode.json</code>
          <pre id="occonf"></pre>
        </div>
        <div class="dfile">
          <code>~/.config/opencode/tui.json</code>
          <pre id="tuiconf"></pre>
        </div>
        <div class="row end"><button id="collapse" class="linkish" type="button">收起</button></div>
      </div>
      <div class="warns">
        <div class="warn"><span class="wn">1</span><span>改完配置要<b>完全退出并重新打开 OpenCode</b>，热重载不生效。</span></div>
        <div class="warn"><span class="wn">2</span><span><b>不要在这台机器上登录 Claude</b>（别执行 <code>opencode auth login</code> 选 Anthropic）。worker 永不持有 refresh token，装 ex-machina 只为请求注入。池外多一个刷新者会当场击毙所有在外租约。</span></div>
        <div class="warn"><span class="wn">3</span><span><b>key 明文只出现这一次</b>，库里只存 SHA-256。关掉弹窗就找不回来了，找不回来就重新领一把。</span></div>
      </div>
      <div class="row end">
        <button id="keydone" class="pill primary" type="button">我已复制，关闭</button>
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
  var REGISTER_URL = "${config.registerRoute}";
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
    // The bar gets the card's full width, below the text rather than beside it: sharing one line with
    // three text columns left it, in a ~350px card, too narrow to read as a bar at all.
    var top = el("div", "win-top");
    top.appendChild(el("div", "wl", shortLabel(win.label)));
    var right = el("div", "win-right");
    right.appendChild(el("div", "pct" + quiet, Math.round(used) + "%"));
    // A window with no resetsAt renders NOTHING here — the same conditional the local-mode panel
    // applies (it wraps the reset text in a Show gated on resets_at). A placeholder like "重置未知"
    // was worse than silence: an idle window at 0% legitimately has no reset instant because it never
    // started, so those words announced a data gap where there was none, making a healthy idle
    // account look like one the poller had failed to reach.
    right.appendChild(el("div", "reset" + quiet, win.resetsAt ? "重置 " + resetIn(win.resetsAt) : ""));
    top.appendChild(right);
    row.appendChild(top);
    var bar = el("div", "bar");
    var fill = el("div", "fill" + tone);
    fill.style.width = Math.max(0, Math.min(100, used)) + "%";
    bar.appendChild(fill);
    row.appendChild(bar);
    return row;
  }

  function renderAccount(account) {
    var card = el("article", "card" + (account.coolingDown ? " cooling" : ""));
    var head = el("div", "head");
    var who = el("div", "who");
    who.appendChild(el("h2", "label", account.label));
    if (account.coolingDown) who.appendChild(el("span", "badge cool", "冷却中"));
    if (account.needsReauth) who.appendChild(el("span", "badge reauth", "需重新登录"));
    if (account.excluded) who.appendChild(el("span", "badge muted", "不自动切"));
    // Without this badge an account the poller could not reach would look exactly like a healthy
    // one sitting at 0%. That confusion is the whole reason this page exists.
    if (!account.hasUsage) who.appendChild(el("span", "badge muted", "本轮无数据"));
    head.appendChild(who);
    head.appendChild(el("span", "token", account.expiresAt ? "access token " + fmtLeft(account.expiresAt - Date.now()) : "access token 到期时间未知"));
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
  var dialog = document.getElementById("dialog");
  var dtitle = document.getElementById("dtitle");
  var dsub = document.getElementById("dsub");
  // ONE map, two flows. Both are launched from the same toolbar so they can never be open at once,
  // which is what lets them share this shell — and with it a single Escape handler, a single
  // backdrop handler and a single close path, instead of two of each that drift apart.
  var stages = {
    loading: document.getElementById("d-loading"),
    ready: document.getElementById("d-ready"),
    done: document.getElementById("d-done"),
    fatal: document.getElementById("d-fatal"),
    claim: document.getElementById("d-claim"),
    key: document.getElementById("d-key")
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
  var labelInput = document.getElementById("wlabel");
  var issueButton = document.getElementById("issue");
  var issueLabel = document.getElementById("issuelabel");
  var claimError = document.getElementById("cerr");
  var keyText = document.getElementById("poolkey");
  var cmdBlock = document.getElementById("cmd");
  var detailPanel = document.getElementById("detail");
  var expandLink = document.getElementById("expand");
  var ocConfig = document.getElementById("occonf");
  var tuiConfig = document.getElementById("tuiconf");

  var SUBTITLES = {
    loading: "正在准备 OAuth 授权，请稍候。",
    ready: "打开链接完成登录授权，然后把返回的 code 粘贴回来。",
    done: "添加成功。",
    fatal: "本次授权没有完成。",
    claim: "给这台机器起一个标签。它同时是 registry 里的 label 和 tui.json 里的 workerId，只填一次。",
    // The only DYNAMIC subtitle — it names the label the server accepted — so showStage cannot own
    // it. Blank here rather than absent so the lookup below still finds a value, and overwritten by
    // showKey() immediately after the stage is shown.
    key: ""
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
  // Keyed by STATUS for the same reason ADD_ERRORS is, and each string says what to DO next, which
  // is the one thing the three statuses genuinely differ on: 400 means fix the label, 429 means
  // wait, and 409 means waiting will not help — a key has to be retired or expire first.
  var CLAIM_ERRORS = {
    400: "这个标签没有被接受：只能用 a-z、0-9、- 和 _，最多 32 个字符。",
    409: "registry 已满（32 把在用的 key）。等下去没有用——要先让一把旧 key 过期或被清掉，才能再签发。",
    429: "签发太频繁，请稍候再试。"
  };

  var addStage = "loading";
  var pendingId = "";
  var submitting = false;
  var closeTimer = 0;
  var issuing = false;

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
    issuing = false;
    // The plaintext pool key does not outlive the dialog that showed it. It is unrecoverable by
    // design — the registry keeps only a SHA-256 digest — so leaving it parked in the DOM of a tab
    // the operator believes they have closed is the one way this page could keep a live credential
    // sitting around for whoever opens devtools next.
    keyText.textContent = "";
    cmdBlock.textContent = "";
    ocConfig.textContent = "";
    tuiConfig.textContent = "";
  }

  // Asks for a fresh PKCE session every time the dialog opens. Deliberately NOT cached across opens:
  // a session the operator abandoned is one the server may already have evicted, and reusing a dead
  // pendingId would fail at the worst moment — after they had gone and authorized in the browser.
  function beginAdd() {
    clearTimeout(closeTimer);
    veil.hidden = false;
    // Both written on entry rather than left to the markup, because the shell is shared now: the
    // other flow retitles the dialog and widens it, and whichever opens second has to undo that.
    dialog.className = "";
    dtitle.textContent = "添加 anthropic 账号";
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

  // One descriptor per copy button: which label to flash, the word to put back, which node to
  // select when the copy could not be performed, and its OWN restore timer. The timer has to be
  // per-button rather than one shared variable, because the issued-key stage shows two of these at
  // once — pressing the second would otherwise cancel the first's restore and strand it on 已复制.
  var URL_COPY = { label: copyLabel, idle: "复制链接", select: authAnchor, timer: 0 };
  var KEY_COPY = { label: document.getElementById("copykeylabel"), idle: "复制 key", select: keyText, timer: 0 };
  var CMD_COPY = { label: document.getElementById("copycmdlabel"), idle: "复制命令", select: cmdBlock, timer: 0 };

  function flashCopied(target, ok) {
    // On failure the source node is selected instead, so the operator always has a way out: the
    // text is right there and now highlighted for a manual copy.
    target.label.textContent = ok ? "已复制" : "复制失败，请手动选择";
    if (!ok) {
      var range = document.createRange();
      range.selectNodeContents(target.select);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    clearTimeout(target.timer);
    target.timer = setTimeout(function () { target.label.textContent = target.idle; }, 1800);
  }

  function copyText(text, target) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { flashCopied(target, true); }, function () {
        flashCopied(target, legacyCopy(text));
      });
      return;
    }
    flashCopied(target, legacyCopy(text));
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

  // ── 领取 key ──────────────────────────────────────────────────────────────────────────────────
  // Two stages over the one register route: name the machine, then read the credential back once.
  // There is no third stage on purpose — the route either mints a key or refuses with a status, and
  // every refusal leaves the operator on the form with something they can act on.

  // The client-side half of the server's /^[a-z0-9_-]{1,32}$/, run on INPUT rather than on submit.
  // That placement is the whole design: the server stamps its 10-second window BEFORE it parses the
  // body, so a rejected label still burns the window — type a bad name, press again, and the second
  // press earns a 429 rather than a second chance. Making an invalid label unsubmittable is what
  // keeps that from being reachable. The dash sits LAST in the class so it is a literal character
  // and not the 9-through-underscore RANGE it would be in the middle.
  function sanitizeLabel(raw) {
    return raw.replace(/[^A-Za-z0-9_-]/g, "").toLowerCase().slice(0, 32);
  }

  function buildCommand(key, label) {
    // --master comes from location.origin, NEVER from a configured hostname. The master's bind
    // address is routinely 127.0.0.1 while the operator reached this box by its tailnet name, so a
    // plumbed-through value would print a command that cannot work; the origin is by construction
    // the URL that just answered. Each line but the last ends in a bash line-continuation so the
    // block pastes as ONE command — in this document's source that backslash is written twice
    // because the page is emitted from a TS template literal, and the emitted string holds one.
    return [
      "git clone --depth 1 https://github.com/Daiwenxi798673133/claude-accounts-pool.git ~/.claude-accounts-pool \\\\",
      "  && cd ~/.claude-accounts-pool && bun install && bun run build \\\\",
      "  && bun run scripts/configure-worker.ts \\\\",
      "       --master " + location.origin + " \\\\",
      "       --key " + key + " \\\\",
      "       --worker " + label
    ].join("\\n");
  }

  // JSON.stringify rather than a hand-assembled block: this panel's entire claim is "here is what
  // the file will look like", and a stringify cannot emit the invalid JSON that concatenating a key
  // and a label into a literal can.
  function writeConfigs(key, label) {
    ocConfig.textContent = JSON.stringify({
      "$schema": "https://opencode.ai/config.json",
      plugin: ["@ex-machina/opencode-anthropic-auth"]
    }, null, 2);
    tuiConfig.textContent = JSON.stringify({
      "$schema": "https://opencode.ai/tui.json",
      plugin: [["~/.claude-accounts-pool/dist/tui.js", {
        mode: "cloud-worker",
        masterUrl: location.origin,
        poolKey: key,
        workerId: label
      }]]
    }, null, 2);
  }

  function setDetail(open) {
    detailPanel.hidden = !open;
    // The link and the panel are one control in two states, so the link leaves while the panel is
    // up — the way back is 收起 at the bottom of the panel itself.
    expandLink.hidden = open;
  }

  function setClaimError(text) {
    claimError.textContent = text;
    claimError.hidden = !text;
  }

  function syncIssue() {
    issueButton.disabled = issuing || labelInput.value.length === 0;
    issueButton.className = issuing ? "pill primary busy" : "pill primary";
    issueLabel.textContent = issuing ? "签发中…" : "签发 key";
  }

  function beginClaim() {
    clearTimeout(closeTimer);
    veil.hidden = false;
    dialog.className = "wide";
    dtitle.textContent = "领取 worker key";
    issuing = false;
    labelInput.value = "";
    setClaimError("");
    showStage("claim");
    syncIssue();
    labelInput.focus();
  }

  // textContent throughout, including for the label — which arrived from an input field and is the
  // one value on this stage that did not originate in this codebase.
  function showKey(payload) {
    dtitle.textContent = "key 已签发";
    keyText.textContent = payload.poolKey;
    cmdBlock.textContent = buildCommand(payload.poolKey, payload.label);
    writeConfigs(payload.poolKey, payload.label);
    KEY_COPY.label.textContent = KEY_COPY.idle;
    CMD_COPY.label.textContent = CMD_COPY.idle;
    setDetail(false);
    showStage("key");
    // Written after showStage, which blanks it: this is the one subtitle SUBTITLES cannot hold.
    dsub.textContent = "worker " + payload.label + " · 明文只出现这一次";
  }

  function issueKey() {
    if (issuing) return;
    var label = labelInput.value;
    if (!label) return;
    issuing = true;
    setClaimError("");
    syncIssue();
    fetch(REGISTER_URL, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: label })
    })
      .then(function (res) {
        if (res.ok) return res.json();
        // The 429 body is the only one read, and only for its number, exactly as the add flow does
        // it. The fallback matches the server's own window, so erring here still names a real wait.
        if (res.status === 429) {
          return res.json().catch(function () { return null; }).then(function (body) {
            var wait = body && typeof body.retryAfterMs === "number" && body.retryAfterMs > 0 ? body.retryAfterMs : 10000;
            throw { status: 429, waitMs: wait };
          });
        }
        throw { status: res.status };
      })
      .then(showKey)
      .catch(function (failure) {
        var status = failure && failure.status;
        if (status === 429) {
          setClaimError(CLAIM_ERRORS[429] + "（约 " + Math.ceil(failure.waitMs / 1000) + " 秒）");
          return;
        }
        setClaimError(status && owns.call(CLAIM_ERRORS, status) ? CLAIM_ERRORS[status] : "签发失败：" + (failure && failure.message ? failure.message : "网络错误"));
      })
      .then(function () {
        issuing = false;
        syncIssue();
      });
  }

  document.getElementById("add").addEventListener("click", beginAdd);
  document.getElementById("cancel").addEventListener("click", closeDialog);
  document.getElementById("close2").addEventListener("click", closeDialog);
  document.getElementById("retry").addEventListener("click", beginAdd);
  document.getElementById("claim").addEventListener("click", beginClaim);
  document.getElementById("ccancel").addEventListener("click", closeDialog);
  document.getElementById("keydone").addEventListener("click", closeDialog);
  document.getElementById("collapse").addEventListener("click", function () { setDetail(false); });
  document.getElementById("copykey").addEventListener("click", function () { copyText(keyText.textContent, KEY_COPY); });
  document.getElementById("copycmd").addEventListener("click", function () { copyText(cmdBlock.textContent, CMD_COPY); });
  expandLink.addEventListener("click", function () { setDetail(true); });
  issueButton.addEventListener("click", issueKey);
  labelInput.addEventListener("input", function () {
    labelInput.value = sanitizeLabel(labelInput.value);
    setClaimError("");
    syncIssue();
  });
  labelInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") issueKey();
  });
  copyButton.addEventListener("click", function () { copyText(authAnchor.textContent, URL_COPY); });
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
