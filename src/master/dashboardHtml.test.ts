import { expect, test } from "bun:test"
import { dashboardHtml } from "./dashboardHtml.ts"

// A SENTINEL, not the production route. Every other field below may be realistic because nothing
// asserts on it, but a registerRoute equal to the real "/v1/worker/register" would pass even if the
// page hardcoded that string instead of interpolating the config it was handed — the one thing the
// interpolation test exists to rule out.
const REGISTER_ROUTE = "/probe/worker/register"

// Config values are irrelevant to every assertion below — only the DOCUMENT'S SHAPE is under test
// — but a full DashboardConfig is required to call this pure function once, up front.
const html = dashboardHtml({
  usageRoute: "/v1/usage",
  refreshRoute: "/v1/usage/refresh",
  throttleMs: 30000,
  authorizeRoute: "/v1/accounts/authorize",
  addRoute: "/v1/accounts/add",
  registerRoute: REGISTER_ROUTE,
})

test("dashboard renders no account id prefix", () => {
  // idPrefix must stay in the /v1/usage payload for the worker's manual-switch UI (see
  // usageView.test.ts) — this asserts on the DOCUMENT dashboardHtml renders instead, never on that
  // payload: the 8-hex chip was the ONLY place the document itself mentioned idPrefix.
  expect(html).not.toContain("idPrefix")
})

test("the expiry line names the access token, in both branches", () => {
  // Both string literals the inline script concatenates, asserted WITH their surrounding quotes so
  // a partial rename (only one branch renamed) cannot pass.
  expect(html).toContain("\"access token \"")
  expect(html).toContain("\"access token 到期时间未知\"")
  // The old wording must be fully gone, not merely supplemented by the new one.
  expect(html).not.toContain("\"token \"")
  expect(html).not.toContain("\"token 到期时间未知\"")
})

test("account cards are laid out in a multi-column grid", () => {
  // #rows was a single flex column — one full-width card per row. The redesign packs cards into an
  // auto-filling grid instead, so both the new track and the old flex declaration are asserted.
  expect(html).toContain("repeat(auto-fill, minmax(320px, 1fr))")
  expect(html).not.toContain("#rows { display: flex; flex-direction: column; gap: 20px; }")
})

test("the document carries no template-literal residue", () => {
  // The whole document lives inside a TS template literal, so a stray backtick or ${ would be a
  // build-breaking edit with no compiler watching it. A standing invariant, not a feature under test.
  expect(html.includes("\u0060")).toBe(false)
  expect(html).not.toContain("${")
})

test("orphans of the card redesign are gone and the footer claim is precise", () => {
  // Once a card shows "access token …" in plain text, "本页不展示任何 token" alone stops being
  // true — it needs "明文" to keep meaning what it always meant.
  expect(html).toContain("本页不展示任何 token 明文。")
  // .id was the removed id-chip's only rule; the 1fr-48px track was the mobile fallback for a
  // 4-column .win row that the narrower card grid no longer needs.
  expect(html).not.toContain(".id {")
  expect(html).not.toContain("grid-template-columns: 1fr 48px")
})

test("the toolbar offers 领取 key, ahead of the two buttons that were there first", () => {
  expect(html).toContain("<button id=\"claim\" type=\"button\">")
  expect(html).toContain("<span>领取 key</span>")
  // Order is the design's, and it is not arbitrary: onboarding a MACHINE precedes onboarding an
  // account, and the accent-filled 刷新 stays last so the only filled button is still the one
  // pressed every visit.
  expect(html.indexOf("id=\"claim\"")).toBeLessThan(html.indexOf("id=\"add\""))
  expect(html.indexOf("id=\"add\"")).toBeLessThan(html.indexOf("id=\"refresh\""))
})

test("the claim flow extends the ONE dialog shell rather than adding a second one", () => {
  expect(html).toContain("id=\"d-claim\"")
  expect(html).toContain("id=\"d-key\"")
  // A second #veil would mean a second Escape handler, a second backdrop handler and a second close
  // path — three pairs that drift. Both flows launch from the same toolbar, so they can never both
  // be open, which is what makes one shell correct rather than merely cheaper.
  expect(html.split("id=\"veil\"").length - 1).toBe(1)
})

test("the register route is interpolated from the config, not hardcoded", () => {
  expect(html).toContain("var REGISTER_URL = \"" + REGISTER_ROUTE + "\";")
})

test("the issued-key stage carries the three warnings verbatim, emphasis included", () => {
  // Asserted WITH their <b> markup: the emphasis is the whole reason this panel is scannable, so a
  // silent un-bolding must fail the same way a reworded warning does.
  expect(html).toContain("改完配置要<b>完全退出并重新打开 OpenCode</b>，热重载不生效。")
  expect(html).toContain("<b>不要在这台机器上登录 Claude</b>（别执行 <code>opencode auth login</code> 选 Anthropic）。worker 永不持有 refresh token，装 ex-machina 只为请求注入。池外多一个刷新者会当场击毙所有在外租约。")
  expect(html).toContain("<b>key 明文只出现这一次</b>，库里只存 SHA-256。关掉弹窗就找不回来了，找不回来就重新领一把。")
})

test("the one-click command is addressed to the URL the browser actually reached", () => {
  // location.origin, never a configured hostname: the master's bind address is routinely 127.0.0.1
  // while the operator got here over a tailnet address, so a plumbed-through value would hand out a
  // command that cannot work. The mockup's placeholder IP must not survive into the page.
  expect(html).toContain("location.origin")
  expect(html).not.toContain("100.98.12.34")
  // The bash line-continuation has to reach the browser as an ESCAPED backslash: the document is one
  // TS template literal, so a dropped escape silently turns a pasteable one-liner into six commands.
  expect(html).toContain("bun install && bun run build \\\\")
})

test("the read-only badge is gone, markup and CSS together", () => {
  // The page adds accounts and now mints credentials. Calling itself a read-only view was a false
  // statement, and the two rules that styled the badge have no other user.
  expect(html).not.toContain("只读视图")
  expect(html).not.toContain(".ro {")
  expect(html).not.toContain(".ro .dot {")
})

test("the footer names both write operations and what neither of them does", () => {
  expect(html).toContain("本页不展示任何 token 明文。「领取 key」只向 registry 新签发一把 worker key（库里只存 SHA-256 摘要），「添加账号」只向池中新增账号，都不会切号或删号。")
})
