import { expect, test } from "bun:test"
import { dashboardHtml } from "./dashboardHtml.ts"

// Config values are irrelevant to every assertion below — only the DOCUMENT'S SHAPE is under test
// — but a full DashboardConfig is required to call this pure function once, up front.
const html = dashboardHtml({
  usageRoute: "/v1/usage",
  refreshRoute: "/v1/usage/refresh",
  throttleMs: 30000,
  authorizeRoute: "/v1/accounts/authorize",
  addRoute: "/v1/accounts/add",
  deleteRoute: "/v1/accounts/delete",
})

test("an account id prefix is carried as an opaque handle and never rendered", () => {
  // idPrefix must stay in the /v1/usage payload for the worker's manual-switch UI (see
  // usageView.test.ts) — this asserts on the DOCUMENT dashboardHtml renders instead, never on that
  // payload. It used to be able to say "the document never mentions idPrefix at all", because the
  // 8-hex chip on each card was the only mention and it was deleted. The delete flow needs the
  // prefix as its handle, so the claim is now the narrower one that always mattered: the prefix
  // reaches an <option>'s VALUE and a request body, and NEVER any text on screen.
  expect(html).toContain("option.value = latest.accounts[i].idPrefix;")
  expect(html).toContain("option.textContent = latest.accounts[i].label;")
  expect(html).toContain("JSON.stringify({ idPrefix: idPrefix, label: label })")
  // The exhaustive count is the point: a SIXTH mention means somebody added a use this list has not
  // been checked against, which is precisely the review moment worth forcing.
  expect(html.split("idPrefix").length - 1).toBe(5)
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

test("the toolbar offers 添加账号 and 删除账号 ahead of 刷新", () => {
  expect(html).toContain("<span>添加账号</span>")
  expect(html).toContain("<span>删除账号</span>")
  // The accent-filled 刷新 stays last, so the only filled button on the page is still the one pressed
  // every visit — emphatically NOT the destructive one.
  expect(html.indexOf("id=\"add\"")).toBeLessThan(html.indexOf("id=\"del\""))
  expect(html.indexOf("id=\"del\"")).toBeLessThan(html.indexOf("id=\"refresh\""))
  // Shut until a snapshot exists to build the picker from. Asserted on the ATTRIBUTE because that is
  // the state the document ships in — syncButton only ever relaxes it.
  expect(html).toContain("<button id=\"del\" type=\"button\" disabled>")
})

test("deleting is confirmed by retyping the label, and the label is what gets sent", () => {
  // The three controls the flow cannot exist without: the roster picker, the confirmation field, and
  // a submit that names the destructive act rather than saying 确定.
  expect(html).toContain("id=\"delpick\"")
  expect(html).toContain("id=\"delconfirm\"")
  expect(html).toContain("确认删除")
  // EXACT equality against the selected row is what makes the field a confirmation rather than
  // decoration — a substring or case-folded test could be satisfied by accident.
  expect(html).toContain("delConfirm.value.trim() !== label")
  // And the confirmed label really travels: the master re-checks it, so a request carrying only the
  // prefix would make the whole typing step browser-side ceremony.
  expect(html).toContain("JSON.stringify({ idPrefix: idPrefix, label: label })")
})

test("the delete flow reuses the ONE dialog shell rather than adding a second", () => {
  // Same invariant the add flow is held to: a second #veil means a second Escape handler, a second
  // backdrop handler and a second close path — three pairs that drift.
  expect(html.split("id=\"veil\"").length - 1).toBe(1)
  expect(html).toContain("id=\"d-del\"")
  // done / fatal are SHARED between the two flows, which is exactly why the subtitle table had to
  // become flow-keyed. A single flat table would caption a deletion with 添加成功.
  expect(html).toContain("var subtitles = SUBTITLES[flow];")
})

test("a refusal is rendered from a fixed table, never from the server's own words", () => {
  // The page consults a 409 body for its `refused` code and nothing else. Echoing the body's `error`
  // string would put a server-supplied string into the DOM, which is the habit this page exists
  // without — and the three codes below are the whole taxonomy the master can answer with.
  expect(html).toContain("var DELETE_ERRORS = {")
  expect(html).toContain("unknown:")
  expect(html).toContain("ambiguous:")
  expect(html).toContain("\"label-mismatch\":")
})

test("the pool key is gone from the page, markup and script together", () => {
  // There is no pool key any more — the master's port is guarded by its bind address alone. Every
  // id below anchored a stage, a control or a route of the flow that minted one, so a survivor is
  // either dead markup or a fetch to a route the server no longer answers.
  expect(html).not.toContain("id=\"claim\"")
  expect(html).not.toContain("领取 key")
  expect(html).not.toContain("id=\"d-claim\"")
  expect(html).not.toContain("id=\"d-key\"")
  expect(html).not.toContain("id=\"poolkey\"")
  expect(html).not.toContain("REGISTER_URL")
  expect(html).not.toContain("configure-worker.ts")
})

test("the add-account flow keeps the ONE dialog shell it always had", () => {
  // A second #veil would mean a second Escape handler, a second backdrop handler and a second close
  // path — three pairs that drift. Dropping the claim flow must not leave a stray shell behind.
  expect(html.split("id=\"veil\"").length - 1).toBe(1)
  // The four stages the PKCE flow steps through, and the shared machinery it drives them with.
  expect(html).toContain("id=\"d-loading\"")
  expect(html).toContain("id=\"d-ready\"")
  expect(html).toContain("id=\"d-done\"")
  expect(html).toContain("id=\"d-fatal\"")
  expect(html).toContain("function showStage(name)")
  expect(html).toContain("function copyText(text, target)")
  expect(html).toContain("id=\"derr\"")
})

test("the read-only badge is gone, markup and CSS together", () => {
  // The page adds accounts. Calling itself a read-only view was a false statement, and the two
  // rules that styled the badge have no other user.
  expect(html).not.toContain("只读视图")
  expect(html).not.toContain(".ro {")
  expect(html).not.toContain(".ro .dot {")
})

test("the footer no longer promises the page cannot delete, and says what a deletion costs", () => {
  // The page deletes now. "不会切号或删号" was the previous truth and is now a false statement, which
  // is worse than no statement — so it is REPLACED rather than supplemented, and what replaces it is
  // the one fact an operator needs before pressing: it is irreversible, and where the copy lives.
  expect(html).not.toContain("不会切号或删号")
  expect(html).toContain("本页不展示任何 token 明文。")
  expect(html).toContain("「删除账号」是不可撤销的")
  expect(html).toContain("备份")
})
