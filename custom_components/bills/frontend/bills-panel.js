const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

const todayIso = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD, local time
// The ISO date `n` days from `iso` (negative for earlier).
const addDays = (iso, n) => {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("sv-SE");
};

// Amount fields fill like a cash register: digits come in from the right with
// the cents already placed (2 -> 0.02, 120 -> 1.20, 1200 -> 12.00).
// Backspace takes the last digit off (1.25 -> 0.12); backspacing past the
// last digit leaves the field empty (so a bill can go back to "Varies").
const MONEY_DIGITS = 9;
const typedMoney = (raw, deleting = false) => {
  const neg = raw.trim().startsWith("-");
  let digits = raw.replace(/\D/g, "");
  if (deleting && /^0*$/.test(digits)) digits = "";
  digits = digits.replace(/^0+(?=\d)/, "").slice(0, MONEY_DIGITS);
  if (!digits) return neg ? "-" : "";
  const d = digits.padStart(3, "0");
  return `${neg ? "-" : ""}${d.slice(0, -2)}.${d.slice(-2)}`;
};
// A saved amount shown in a money field (85 -> "85.00"); empty stays empty.
const moneyValue = (n) => (n === null || n === undefined || n === "" ? "" : Number(n).toFixed(2));
// Attributes for a money field: a text box with the digits keypad.
const MONEY_INPUT = 'type="text" inputmode="numeric" autocomplete="off" data-money';

const FREQUENCIES = [
  ["once", "Doesn't repeat"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
  ["yearly", "Yearly"],
];
const UNITS = { weekly: "week", monthly: "month", yearly: "year" };

const NEW_BILL = {
  name: "", amount: null, next_due: null, frequency: "monthly", interval: 1,
  end_date: null, remind_days_before: 3, autopay: false, biller_url: null, notes: null,
  category_id: null, in_budget: true,
};

const UPCOMING_LIMIT = 3;
const RECENT_PAYMENTS = 5;      // Recent payments shows this many until expanded
const RECENT_PAYMENTS_MAX = 25; // and at most this many when expanded
const RECENT_TX = 3;            // Today's transactions shows this many until expanded
const NOTE_SUGGESTIONS = 5;     // + Add form: earlier notes shown while typing one
const PAST_DAY_CHIPS = 30;      // Previous days: a chip per day, with what was spent, scrolled sideways
const BILL_ICON = "mdi:file-document-outline";      // bills without a category
const UNCATEGORIZED_ICON = "mdi:shape-outline";
const DEFAULT_CATEGORY_ICON = "mdi:tag";
const ICON_RE = /^[a-z0-9-]+:[a-z0-9-]+$/;
const SUGGESTED_ICONS = [
  "mdi:home", "mdi:flash", "mdi:water", "mdi:fire", "mdi:wifi", "mdi:cellphone",
  "mdi:television-classic", "mdi:cloud", "mdi:music", "mdi:car", "mdi:gas-station",
  "mdi:shield-check", "mdi:heart-pulse", "mdi:credit-card", "mdi:bank", "mdi:cart",
  "mdi:food", "mdi:dumbbell", "mdi:school", "mdi:paw", "mdi:baby-carriage",
  "mdi:tools", "mdi:trash-can", "mdi:gift",
];

class BillsPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.addEventListener("input", (ev) => {
      const el = ev.target;
      if (!el.matches || !el.matches("[data-money]")) return;
      const deleting = (ev.inputType || "").startsWith("delete")
        || el.value.length < (el._moneyPrev ?? el.defaultValue).length;
      const v = typedMoney(el.value, deleting);
      if (v !== el.value) el.value = v;
      el._moneyPrev = v;
      el.setSelectionRange(v.length, v.length);  // keep typing at the end
    }, true);
    // Tapping a money field that already has an amount (a bill's estimate on
    // the pay form, an amount being edited) selects it, so typing replaces it.
    this.shadowRoot.addEventListener("focusin", (ev) => {
      const el = ev.target;
      if (!el.matches || !el.matches("[data-money]") || !el.value) return;
      setTimeout(() => { if (el.isConnected) el.setSelectionRange(0, el.value.length); }, 0);
    });
    this._bills = [];    // active
    this._retired = [];  // retired, most recently retired first
    this._showRetired = false;
    this._showAllBills = false;  // Upcoming shows UPCOMING_LIMIT until expanded
    this._showMorePayments = false;  // Recent payments: RECENT_PAYMENTS or up to RECENT_PAYMENTS_MAX
    this._payments = [];
    this._categories = [];
    this._costs = null;  // { today, month, year, previous_years } from bills.cost_summary
    this._history = null;  // { id, data, error, showAll } for the payment history view
    this._yearSel = {};  // year -> selected month index, -1 (or missing) for Total
    this._openYears = new Set();   // years (this one included) that are expanded
    this._showMonths = new Set();  // years showing their Jan … Dec chips
    this._budget = null;   // from bills.budget_summary
    this._showAllTx = false;
    this._confirmTx = null;  // transaction id waiting for "Delete" confirmation
    this._txDay = addDays(todayIso(), -1);  // Previous days: the day being shown
    this._dayTx = null;      // from bills.list_transactions for _txDay
    this._txOpen = false;    // Previous days: only the date picker until a day is picked
    this._showBreakdown = false;  // "Each day: income − bills − savings" under the eye
    try { this._showBreakdown = localStorage.getItem("bills-panel-breakdown") === "1"; } catch (e) { /* private mode */ }
    // _form: null, or { kind, id, ... } where kind is
    // "pay" | "edit" | "add" | "restore" | "history" (Bills tab),
    // "tx" | "stream" | "savemove" | "budgetsetup" (Budget tab) or "category" (Categories tab)
    const params = new URLSearchParams(window.location.search);
    const payId = params.get("pay");
    const add = params.get("add");  // ?add=expense or ?add=income opens the + form
    let tab = params.get("tab");
    if (!tab) {
      try { tab = localStorage.getItem("bills-panel-tab"); } catch (e) { /* private mode */ }
    }
    if (payId) tab = "bills";
    if (add) tab = "budget";
    this._tab = ["budget", "categories"].includes(tab) ? tab : "bills";
    this._form = payId ? { kind: "pay", id: payId }
      : add ? { kind: "tx", id: null, type: add === "income" ? "income" : "expense" } : null;
    this._msg = "";
    this._error = "";
    this._loaded = false;  // the first load has been started
    this._ready = false;   // ... and has finished, so this._bills can be trusted
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._loaded) {
      this._loaded = true;
      this._refresh();
    }
  }
  set narrow(v) { this._narrow = v; }
  set panel(v) { this._panel = v; }

  connectedCallback() {
    // Links like /bills?add=expense (widgets, shortcuts) or /bills?pay=<id>
    // (reminders) can arrive while the panel is already open: the app
    // navigates inside the page instead of reloading it, so listen for that.
    this._onLocation = () => this._applyDeepLink();
    window.addEventListener("location-changed", this._onLocation);
    window.addEventListener("popstate", this._onLocation);
    if (this._loaded) this._applyDeepLink();  // panel shown again from the sidebar
  }

  disconnectedCallback() {
    clearTimeout(this._msgTimer);
    window.removeEventListener("location-changed", this._onLocation);
    window.removeEventListener("popstate", this._onLocation);
  }

  _applyDeepLink() {
    const base = (this._panel && this._panel.url_path) || "bills";
    if (!window.location.pathname.startsWith("/" + base)) return;  // another page
    const params = new URLSearchParams(window.location.search);
    const add = params.get("add");
    const pay = params.get("pay");
    if (add) {
      this._tab = "budget";
      this._msg = "";
      this._form = { kind: "tx", id: null, type: add === "income" ? "income" : "expense" };
    } else if (pay) {
      this._tab = "bills";
      // Until the bills have loaded there's nothing to check the link
      // against; the first load checks it instead.
      if (!this._ready || this._bill(pay)) {
        this._msg = "";
        this._form = { kind: "pay", id: pay };
      } else {
        this._flash("That bill isn't active anymore.");
        this._close(false);
      }
    } else {
      return;
    }
    this._render();
    window.scrollTo(0, 0);
  }

  _flash(msg) {
    this._msg = msg;
    clearTimeout(this._msgTimer);
    this._msgTimer = setTimeout(() => this._hideMsg(), 8000);
  }

  _hideMsg() {
    this._msg = "";
    const el = this.shadowRoot.querySelector(".ok");
    if (!el) return;
    el.classList.add("hide");
    setTimeout(() => el.remove(), 400);
  }

  async _call(service, data = {}) {
    const res = await this._hass.callWS({
      type: "call_service",
      domain: "bills",
      service,
      service_data: data,
      return_response: true,
    });
    return res.response;
  }

  async _refresh() {
    try {
      // After midnight, "yesterday" moves on; keep showing the day picked
      // unless it's now today (which belongs in Today's transactions).
      if (this._txDay >= todayIso()) this._txDay = addDays(todayIso(), -1);
      const [b, p, c, costs, budget, dayTx] = await Promise.all([
        this._call("list_bills", { include_retired: true }),
        this._call("list_payments"),
        this._call("list_categories"),
        this._call("cost_summary"),
        this._call("budget_summary"),
        this._txOpen ? this._call("list_transactions", { date: this._txDay }) : null,
      ]);
      this._budget = budget;
      if (dayTx) this._dayTx = dayTx;
      this._bills = b.bills.filter((x) => x.active);
      this._retired = b.bills.filter((x) => !x.active).sort((x, y) =>
        (y.retired_on || "").localeCompare(x.retired_on || ""));
      this._payments = p.payments.slice(0, RECENT_PAYMENTS_MAX);
      this._categories = c.categories;
      this._costs = costs;
      this._error = "";
      // A reminder link (?pay=<id>) opened before the bills had loaded is
      // checked now, once.
      const first = !this._ready;
      this._ready = true;
      if (first && this._form && this._form.kind === "pay" && !this._bill(this._form.id)) {
        this._flash("That bill isn't active anymore.");
        this._close(false);
      }
    } catch (e) {
      this._error = e.message || String(e);
    }
    this._render();
  }

  _bill(id) {
    return this._bills.find((b) => b.id === id);
  }

  _retiredBill(id) {
    return this._retired.find((b) => b.id === id);
  }

  _category(id) {
    return id ? this._categories.find((c) => c.id === id) : undefined;
  }

  _open(kind, id = null, extra = {}) {
    this._form = { kind, id, ...extra };
    this._msg = "";
    this._render();
    window.scrollTo(0, 0);
  }

  _close(render = true) {
    this._form = null;
    if (window.location.search) {
      history.replaceState(null, "", window.location.pathname);
    }
    if (render) this._render();
  }

  _money(n) {
    if (n === null || n === undefined) return "—";
    const cur = (this._hass && this._hass.config.currency) || "USD";
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(n);
  }

  _icon(name, cls = "") {
    return `<ha-icon class="${cls}" icon="${esc(name)}"></ha-icon>`;
  }

  _billIcon(b) {
    const c = b && this._category(b.category_id);
    return this._icon(c ? c.icon : BILL_ICON, "lead");
  }

  _daysUntil(iso) {
    const due = new Date(iso + "T00:00:00");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((due - today) / 86400000);
  }

  _when(iso) {
    const d = this._daysUntil(iso);
    if (d < 0) return { text: `overdue by ${-d} day${d === -1 ? "" : "s"}`, cls: "late" };
    if (d === 0) return { text: "due today", cls: "soon" };
    if (d === 1) return { text: "due tomorrow", cls: "soon" };
    return { text: `due in ${d} days`, cls: "" };
  }

  _repeats(b) {
    if (b.frequency === "once") return "one-time";
    const unit = UNITS[b.frequency];
    return b.interval === 1 ? `${b.frequency}` : `every ${b.interval} ${unit}s`;
  }

  // ---------- lists ----------

  _billsList() {
    if (!this._bills.length) {
      return `<p class="muted">No active bills. Use <b>Add bill</b> to create one.</p>`;
    }
    const hidden = this._bills.length - UPCOMING_LIMIT;
    const shown = this._showAllBills ? this._bills : this._bills.slice(0, UPCOMING_LIMIT);
    const toggle = hidden > 0
      ? `<button class="link showmore" id="toggle-bills" aria-expanded="${this._showAllBills}">${
          this._showAllBills ? "Show fewer" : `Show ${hidden} more`}</button>`
      : "";
    return shown.map((b) => {
      const w = this._when(b.next_due);
      return `<div class="row">
        ${this._billIcon(b)}
        <button class="rowlink grow" data-history="${esc(b.id)}" title="Payment history">
          <div class="name">${esc(b.name)}${b.autopay ? ' <span class="tag">autopay</span>' : ""}${
            b.in_budget === false ? ' <span class="tag">not in budget</span>' : ""}</div>
          <div class="muted ${w.cls}">${esc(b.next_due)} · ${w.text} · ${esc(this._repeats(b))}</div>
        </button>
        <div class="amt">${this._money(b.amount)}</div>
        <div class="btns">
          <button class="secondary" data-edit="${esc(b.id)}">Edit</button>
          <button data-pay="${esc(b.id)}">Pay</button>
        </div>
      </div>`;
    }).join("") + toggle;
  }

  _retiredSection() {
    if (!this._retired.length) return "";
    const n = this._retired.length;
    const rows = this._retired.map((b) => `<div class="row">
        ${this._billIcon(b)}
        <button class="rowlink grow" data-history="${esc(b.id)}" title="Payment history">
          <div class="name">${esc(b.name)}</div>
          <div class="muted">${b.retired_on ? "retired " + esc(b.retired_on) + " · " : ""}${
            esc(this._repeats(b))}</div>
        </button>
        <div class="amt muted">${this._money(b.amount)}</div>
        <div class="btns">
          <button class="secondary" data-restore="${esc(b.id)}">Restore</button>
        </div>
      </div>`).join("");
    return `<div class="section-head">
        <h2>Retired</h2>
        <button class="link" id="toggle-retired" aria-expanded="${this._showRetired}">
          ${this._showRetired ? "Hide" : `Show ${n} retired bill${n === 1 ? "" : "s"}`}</button>
      </div>
      ${this._showRetired ? `<div class="card">${rows}</div>` : ""}`;
  }

  _paymentsList() {
    if (!this._payments.length) return `<p class="muted">No payments yet.</p>`;
    const hidden = this._payments.length - RECENT_PAYMENTS;
    const shown = this._showMorePayments ? this._payments : this._payments.slice(0, RECENT_PAYMENTS);
    const toggle = hidden > 0
      ? `<button class="link showmore" id="toggle-payments" aria-expanded="${this._showMorePayments}">${
          this._showMorePayments ? "Show fewer" : `Show ${hidden} more`}</button>`
      : "";
    return shown.map((p) => {
      const bill = this._bill(p.bill_id) || this._retiredBill(p.bill_id);
      return `<div class="row">
        ${this._billIcon(bill)}
        <button class="rowlink grow" data-history="${esc(p.bill_id)}" title="Payment history">
          <div class="name">${esc(p.bill_name)}</div>
          <div class="muted">paid ${esc(p.paid_date)} for ${esc(p.due_date)}${
            p.confirmation ? " · #" + esc(p.confirmation) : ""}</div>
        </button>
        <div class="amt">${this._money(p.amount_paid)}</div>
      </div>`;
    }).join("") + toggle;
  }

  // ---------- cost summaries ----------

  _monthLabel(iso, style = "long") {
    return new Date(iso + "T00:00:00").toLocaleDateString(undefined,
      style === "long" ? { month: "long", year: "numeric" } : { month: "short" });
  }

  // "$130.00 paid · $40.00 upcoming · 1 without amount"
  _splitText(x, dueWord, fullWord) {
    const parts = [];
    if (x.paid && !x.upcoming && !x.unpriced) parts.push(fullWord);
    else if (x.paid) parts.push(`${this._money(x.paid)} paid`);
    if (x.upcoming) parts.push(`${this._money(x.upcoming)} ${dueWord}`);
    if (x.unpriced) parts.push(`${x.unpriced} without amount`);
    return parts.join(" · ") || "—";
  }

  // Totals, a paid meter and the categories of one breakdown (from
  // bills.cost_summary). With showBills, each category lists its bills.
  _breakdown(s, { emptyText, showBills = false }) {
    if (!s.categories.length) return `<p class="muted">${esc(emptyText)}</p>`;
    // A period that's over has nothing upcoming, only unpaid.
    const past = this._costs && s.end < this._costs.today;
    const dueWord = past ? "unpaid" : "upcoming";
    const pctPaid = (x) => (x.total > 0 ? Math.round((x.paid / x.total) * 100) : 0);
    const paidPct = pctPaid(s);
    // Every bar shows how much is paid: the top one for the whole period,
    // each category's for that category.
    const rows = s.categories.map((c) => {
      const pct = pctPaid(c);
      const lines = showBills && c.bills ? `<div class="billlines">${c.bills.map((b) => `
          <div class="billline">
            <span>${esc(b.name)}${b.count > 1 ? ` <span class="muted">×${b.count}</span>` : ""}</span>
            <span>${this._splitText(b, dueWord, `${this._money(b.paid)} paid`)}</span>
          </div>`).join("")}</div>` : "";
      return `<div class="row cat">
        ${this._icon(c.icon || (c.id ? DEFAULT_CATEGORY_ICON : UNCATEGORIZED_ICON), "lead")}
        <div class="grow">
          <div class="name">${esc(c.name)}</div>
          <div class="muted small">${this._splitText(c, dueWord, "paid in full")}</div>
          <div class="minibar" title="${pct}% paid"><span style="width:${pct}%"></span></div>
          ${lines}
        </div>
        <div class="amt">${this._money(c.total)}</div>
      </div>`;
    }).join("");
    return `<div class="stats">
          <div><div class="muted small">Paid</div><div class="big">${this._money(s.paid)}</div></div>
          <div><div class="muted small">${past ? "Unpaid" : "Upcoming"}</div><div class="big">${
            this._money(s.upcoming)}</div></div>
          <div><div class="muted small">Total</div><div class="big">${this._money(s.total)}</div></div>
        </div>
        <div class="meter" title="${paidPct}% paid"><span style="width:${paidPct}%"></span></div>
        <div class="muted small meter-label">${paidPct}% paid</div>
        ${rows}
        ${s.unpriced ? `<p class="muted small note">${s.unpriced} due date${
          s.unpriced === 1 ? "" : "s"} without an amount ${
          s.unpriced === 1 ? "isn't" : "aren't"} included in the totals.</p>` : ""}`;
  }

  // The Total chip (plus Jan … Dec once "Show months" is on), then the
  // selected one's breakdown.
  _yearBody(y) {
    const showMonths = this._showMonths.has(y.year);
    const sel = showMonths ? (this._yearSel[y.year] ?? -1) : -1;
    const options = [[-1, "Total", y.total]];
    if (showMonths) {
      y.months.forEach((m, i) => options.push([i, this._monthLabel(m.start, "short"), m.total]));
    }
    const chips = options.map(([i, label, total]) => `<button class="chip ${i === sel ? "sel" : ""}"
          data-ysel="${y.year}:${i}" aria-pressed="${i === sel}">
        <span>${esc(label)}</span><b>${total ? this._money(total) : "—"}</b>
      </button>`).join("");
    const s = sel < 0 ? y : y.months[sel];
    const label = sel < 0 ? String(y.year) : this._monthLabel(s.start);
    return `<div class="chips">${chips}</div>
      <div class="selbar">
        <span class="selhead">${sel < 0 ? `All of ${y.year}` : esc(label)}</span>
        <button class="link monthstoggle" data-monthstoggle="${y.year}" aria-expanded="${showMonths}">
          ${showMonths ? "Hide months" : "Show months"}
          ${this._icon(showMonths ? "mdi:chevron-up" : "mdi:chevron-down", "tiny")}</button>
      </div>
      ${this._breakdown(s, { emptyText: `No bills due in ${label}.`, showBills: sel >= 0 })}`;
  }

  _costs_html() {
    if (!this._costs) return "";
    const { month, year } = this._costs;
    const prev = this._costs.previous_years || [];
    const yearCard = (y) => {
      const open = this._openYears.has(y.year);
      return `<div class="card yearcard">
        <button class="yearhead" data-yeartoggle="${y.year}" aria-expanded="${open}">
          ${this._icon(open ? "mdi:chevron-down" : "mdi:chevron-right", "lead")}
          <span class="grow name">${y.year}</span>
          <span class="amt">${this._money(y.total)}</span>
        </button>
        ${open ? `<div class="yearbody">${this._yearBody(y)}</div>` : ""}
      </div>`;
    };
    return `
      <h2>This month <span class="muted h-sub">· ${esc(this._monthLabel(month.start))}</span></h2>
      <div class="card">${this._breakdown(month, { emptyText: "No bills due this month." })}</div>
      <h2>This year</h2>
      ${yearCard(year)}
      <h2>Previous years</h2>
      ${prev.length ? prev.map(yearCard).join("") : `<div class="card"><p class="muted">
        No historical yearly data to display here yet. Years show up once they have
        payments.</p></div>`}`;
  }

  // ---------- payment history ----------

  async _openHistory(id) {
    this._history = { id, data: null, error: "", showAll: false };
    this._open("history", id);
    try {
      const data = await this._call("bill_history", { bill: id });
      if (this._history && this._history.id === id) this._history.data = data;
    } catch (e) {
      if (this._history && this._history.id === id) this._history.error = e.message || String(e);
    }
    if (this._form && this._form.kind === "history" && this._form.id === id) this._render();
  }

  _arrow(change, pct) {
    if (change === null || change === undefined) return "";
    if (Math.abs(pct ?? 0) < 2 && Math.abs(change) < 0.005) return "same as before";
    const sign = change > 0 ? "▲" : change < 0 ? "▼" : "=";
    return `${sign} ${this._money(Math.abs(change))}${pct !== null && pct !== undefined ? ` (${Math.abs(pct)}%)` : ""}`;
  }

  _trendWords(t) {
    if (!t) return null;
    return { up: "Going up", down: "Going down", steady: "Steady" }[t.direction];
  }

  // Clean axis maximum: 1, 2, 2.5 or 5 times a power of ten.
  _niceMax(v) {
    if (!(v > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * mag) return m * mag;
    return 10 * mag;
  }

  _axisMoney(n, max) {
    const cur = (this._hass && this._hass.config.currency) || "USD";
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: cur, maximumFractionDigits: max >= 10 ? 0 : 2,
    }).format(n);
  }

  // Column chart of the latest payments, oldest on the left. Plain HTML so
  // text stays readable at any width; the payments list below is the table view.
  _historyChart(rows, estimate) {
    const MAX_BARS = 24;
    const shown = rows.slice(-MAX_BARS);
    const top = this._niceMax(Math.max(...shown.map((p) => p.amount_paid), estimate || 0));
    const pct = (v) => Math.max(0, Math.min(100, (v / top) * 100));
    const ticks = [0, top / 2, top].map((t) => `<div class="gl" style="bottom:${pct(t)}%">
        <span>${this._axisMoney(t, top)}</span></div>`).join("");
    const est = estimate ? `<div class="est" style="bottom:${pct(estimate)}%">
        <span>estimate ${this._money(estimate)}</span></div>` : "";
    const cols = shown.map((p, i) => {
      const label = this._monthLabel(p.due_date) + " · " + this._money(p.amount_paid);
      const last = i === shown.length - 1;
      return `<button class="col${last ? " on" : ""}" data-tip="${esc(label)}" aria-label="${esc(label)}"
          style="--h:${pct(p.amount_paid)}%">
          ${last ? `<span class="cap">${this._money(p.amount_paid)}</span>` : ""}
          <span class="bar"></span></button>`;
    }).join("");
    const first = this._monthLabel(shown[0].due_date);
    const lastLabel = this._monthLabel(shown[shown.length - 1].due_date);
    return `<div class="chart">
        <div class="plot">${ticks}${est}<div class="cols">${cols}</div></div>
        <div class="xlabels"><span>${esc(first)}</span><span>${
          rows.length > MAX_BARS ? `last ${MAX_BARS} payments` : ""}</span><span>${esc(lastLabel)}</span></div>
        <div class="muted small charttip" id="charttip">${esc(
          this._monthLabel(shown[shown.length - 1].due_date) + " · " +
          this._money(shown[shown.length - 1].amount_paid))}</div>
      </div>`;
  }

  _historyView() {
    const h = this._history;
    const b = h && h.data ? h.data.bill : (this._bill(h && h.id) || this._retiredBill(h && h.id));
    const cat = b && this._category(b.category_id);
    const sub = b ? [cat ? cat.name : "Uncategorized", this._repeats(b),
      b.active ? `estimate ${this._money(b.amount)}` : "retired"].join(" · ") : "";
    const actions = `<div class="actions">
        <button type="button" class="secondary" data-cancel>Close</button>
        ${b && b.active ? `<button type="button" class="secondary" data-edit="${esc(b.id)}">Edit</button>
          <button type="button" data-pay="${esc(b.id)}">Pay</button>` : ""}
        ${b && !b.active ? `<button type="button" class="secondary" data-restore="${esc(b.id)}">Restore</button>` : ""}
      </div>`;
    const head = `<div class="histhead">
        ${this._billIcon(b)}
        <div class="grow">
          <h2>${esc(b ? b.name : "Payment history")}</h2>
          <div class="muted small">${esc(sub)}</div>
        </div>
      </div>`;
    let body;
    if (h.error) body = `<div class="err">${esc(h.error)}</div>`;
    else if (!h.data) body = `<p class="muted">Loading payment history…</p>`;
    else body = this._historyBody(h.data, b);
    return `<div class="card" id="history">${head}${body}${actions}</div>`;
  }

  _historyBody(data, b) {
    const st = data.stats;
    // Oldest first for the chart and the change-from-previous column.
    const rows = data.payments.filter((p) => p.amount_paid !== null && p.amount_paid !== undefined)
      .slice().reverse();
    if (!data.payments.length) {
      return `<p class="muted">No payments recorded yet. They'll show here once you pay this bill.</p>`;
    }
    const tiles = [
      ["Last payment", st.last !== null ? this._money(st.last) : "—",
        st.change !== null ? this._arrow(st.change, st.change_pct) + " vs previous" : "first payment"],
      ["Average", st.average !== null ? this._money(st.average) : "—",
        `over ${st.count} payment${st.count === 1 ? "" : "s"}`],
      ["Lowest – highest", st.min !== null ? `${this._money(st.min)} – ${this._money(st.max)}` : "—",
        st.first_due ? `since ${this._monthLabel(st.first_due)}` : ""],
      ["Trend", this._trendWords(st.trend) || "Not enough yet",
        st.trend ? `${st.trend.pct > 0 ? "+" : ""}${st.trend.pct ?? 0}% · last ${st.trend.window} vs ${
          st.trend.window} before` : "needs 4 payments"],
    ].map(([label, value, delta]) => `<div class="tile">
        <div class="muted small">${label}</div>
        <div class="tilev">${esc(value)}</div>
        <div class="muted small">${esc(delta)}</div>
      </div>`).join("");
    const yoy = st.year_over_year ? `<p class="muted small yoy">Last 12 months averaged
        <b>${this._money(st.year_over_year.recent_avg)}</b> a payment vs
        ${this._money(st.year_over_year.prior_avg)} the 12 months before
        (${this._arrow(st.year_over_year.recent_avg - st.year_over_year.prior_avg,
          st.year_over_year.pct)}).</p>` : "";

    // Change from the previous payment, keyed by payment id.
    const delta = {};
    rows.forEach((p, i) => {
      if (i === 0) return;
      const d = p.amount_paid - rows[i - 1].amount_paid;
      delta[p.id] = Math.abs(d) < 0.005 ? "=" : `${d > 0 ? "▲" : "▼"} ${this._money(Math.abs(d))}`;
    });
    const LIMIT = 4;  // the chart above still shows the full range
    const list = this._history.showAll ? data.payments : data.payments.slice(0, LIMIT);
    const items = list.map((p) => `<div class="row hist">
        <div class="grow">
          <div class="name">${esc(this._monthLabel(p.due_date))}</div>
          <div class="muted small">due ${esc(p.due_date)} · paid ${esc(p.paid_date)}${
            p.confirmation ? " · #" + esc(p.confirmation) : ""}${p.note ? " · " + esc(p.note) : ""}</div>
        </div>
        <div class="delta muted small">${delta[p.id] || ""}</div>
        <div class="amt">${this._money(p.amount_paid)}</div>
      </div>`).join("");
    const more = data.payments.length > LIMIT
      ? `<button class="link showmore" id="hist-all">${this._history.showAll
          ? "Show fewer" : `Show all ${data.payments.length} payments`}</button>` : "";
    return `<div class="tiles">${tiles}</div>
      ${yoy}
      ${rows.length ? this._historyChart(rows, b && b.active ? b.amount : null) : ""}
      <h3>Payments</h3>
      ${items}${more}`;
  }

  // ---------- budget tab ----------

  _setTab(tab) {
    this._tab = tab;
    try { localStorage.setItem("bills-panel-tab", tab); } catch (e) { /* private mode */ }
    this._close(false);
    this._render();
  }

  _dayLabel(iso, i) {
    if (i === 0) return "Today";
    if (i === 1) return "Tomorrow";
    return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "long" });
  }

  _often(s) {
    const n = s.interval;
    if (s.frequency === "weekly") return n === 1 ? "every week" : `every ${n} weeks`;
    if (s.frequency === "monthly") return n === 1 ? "monthly" : `every ${n} months`;
    return n === 1 ? "yearly" : `every ${n} years`;
  }

  _oftenOptions(selected, withOnce) {
    const opts = [["w1", "Every week"], ["w2", "Every 2 weeks"], ["m1", "Monthly"], ["y1", "Yearly"]];
    // A stream saved with an unusual interval (e.g. every 3 months) gets its own option.
    if (selected && /^[wmy]\d+$/.test(selected) && !opts.some(([k]) => k === selected)) {
      const [f, n] = [selected[0], selected.slice(1)];
      opts.push([selected, `Every ${n} ${{ w: "weeks", m: "months", y: "years" }[f]}`]);
    }
    if (withOnce) opts.unshift(["once", "One-off"]);
    return opts.map(([k, label]) =>
      `<option value="${k}" ${k === selected ? "selected" : ""}>${label}</option>`).join("");
  }

  _parseOften(key) {
    return { frequency: { w: "weekly", m: "monthly", y: "yearly" }[key[0]], interval: parseInt(key.slice(1), 10) };
  }

  _catOptions(selectedId) {
    return [`<option value="">Uncategorized</option>`].concat(this._categories.map((c) =>
      `<option value="${esc(c.id)}" ${selectedId === c.id ? "selected" : ""}>${esc(c.name)}</option>`
    )).join("");
  }

  _budgetTab() {
    const B = this._budget;
    if (!B) return `<p class="muted">Loading budget…</p>`;
    if (!B.configured) {
      return this._form && this._form.kind === "budgetsetup" ? "" : this._setupForm(true);
    }
    const neg = (n) => (n < 0 ? "late" : "");
    const a = B.allowance;
    // Each later day adds its own allowance (plus anything dated that day), so
    // show that step, and say why when the daily amount changes.
    const step = (n) => `${n < 0 ? "−" : "+"}${this._money(Math.abs(n))}`;
    const days = B.days.map((d, i) => `<div class="day">
        <div class="muted small">${esc(this._dayLabel(d.date, i))}</div>
        <div class="dayamt ${neg(d.amount)}">${this._money(d.amount)}</div>
        ${i && d.change !== undefined ? `<div class="muted small">${step(d.change)}</div>` : ""}
      </div>`).join("");
    const changes = B.days.filter((d) => d.reasons).map((d) => {
      const i = B.days.indexOf(d);
      const why = d.reasons.length ? ` — ${d.reasons.join(", ")}` : "";
      const when = i === 1 ? "tomorrow" : this._dayLabel(d.date, i);
      return `<div class="muted small breakdown">From ${esc(when)}:
        ${this._money(d.allowance)} a day${esc(why)}</div>`;
    }).join("");
    const hero = `<div class="card hero">
        <div class="muted">Today's budget</div>
        <div class="heroamt ${neg(B.today)}">${this._money(B.today)}</div>
        <div class="muted small">${this._money(a.allowance)} a day${
          B.spent_today ? ` · spent ${this._money(B.spent_today)} today` : ""}${
          B.income_today ? ` · ${this._money(B.income_today)} income today` : ""}</div>
        <div class="days3">${days}</div>
        ${changes}
        ${this._dailyBreakdown(a, B.bills_without_amount)}
      </div>`;
    return `${hero}
      <h2>Today's transactions</h2>
      <div class="card">${this._txList()}</div>
      <h2>Previous days' transactions</h2>
      <div class="card">${this._pastDays()}</div>
      <div class="section-head"><h2>Income</h2>
        <button class="link addlink" data-newstream="income">+ Recurring income</button></div>
      <div class="card">${this._streamList("income")}</div>
      <h2>Savings</h2>
      <div class="card">${this._savingsCard()}</div>
      <p class="settings"><button class="link" id="budget-settings">Budget reset</button></p>`;
  }

  _txIcon(t) {
    const c = this._category(t.category_id);
    if (c) return c.icon;
    return { expense: "mdi:cart-outline", income: "mdi:cash-plus",
             to_savings: "mdi:piggy-bank", from_savings: "mdi:piggy-bank-outline",
             bill_adjustment: BILL_ICON, bill_payment: BILL_ICON }[t.kind];
  }

  // What each day is made of, behind an eye button so the card stays short.
  _dailyBreakdown(a, unpriced) {
    if (!this._showBreakdown) {
      return `<button class="link iconbtn2 eyebtn" id="toggle-breakdown" aria-expanded="false"
          aria-label="Show what each day is made of" title="Show what each day is made of">${
        this._icon("mdi:eye-outline", "tiny muted-icon")}</button>`;
    }
    return `<div class="muted small breakdown">Each day: ${this._money(a.income)} income
          − ${this._money(a.bills)} bills − ${this._money(a.savings)} savings</div>
        ${unpriced ? `<div class="muted small breakdown">${unpriced} bill${
          unpriced === 1 ? " has" : "s have"} no amount, so ${
          unpriced === 1 ? "it isn't" : "they aren't"} counted.</div>` : ""}
        <button class="link iconbtn2 eyebtn" id="toggle-breakdown" aria-expanded="true"
          aria-label="Hide what each day is made of" title="Hide">${
        this._icon("mdi:eye-off-outline", "tiny muted-icon")}</button>`;
  }

  // Today's transactions (and any dated later), RECENT_TX until expanded.
  _txList() {
    const all = this._budget.transactions || [];
    if (!all.length) {
      return `<p class="muted">Nothing spent today. Tap <b>+ Add</b> to record spending or income.</p>`;
    }
    const rows = this._txRows(this._showAllTx ? all : all.slice(0, RECENT_TX), todayIso());
    const more = all.length - RECENT_TX;
    const toggle = more > 0 ? `<button class="link showmore" id="toggle-tx">${
      this._showAllTx ? "Show fewer" : `Show ${more} more`}</button>` : "";
    return rows + toggle;
  }

  // A row of day chips (newest first) with what was spent each day. Tapping
  // one opens that day: arrows and a date picker for any earlier day, its
  // total and its transactions.
  _pastDays() {
    const yesterday = addDays(todayIso(), -1);
    const totals = this._budget.day_totals || {};
    const sel = this._txOpen ? this._txDay : null;
    const fmtDay = (iso, opts) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, opts);
    // The last PAST_DAY_CHIPS days, or back to the day picked if it's older.
    const days = [];
    for (let d = yesterday, i = 0; i < PAST_DAY_CHIPS || (sel && d >= sel); d = addDays(d, -1), i++) {
      days.push(d);
    }
    const chips = days.map((d) => {
      const t = totals[d];
      const label = d === yesterday ? "Yesterday"
        : `${fmtDay(d, { weekday: "short" })} ${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
      return `<button class="chip ${d === sel ? "sel" : ""}" data-txday="${d}" aria-pressed="${d === sel}">
          <span>${esc(label)}</span><b>${t && t.spent ? this._money(t.spent) : "—"}</b>
        </button>`;
    }).join("");
    if (!sel) return `<div class="daychips">${chips}</div>`;
    const t = totals[sel] || { spent: 0, income: 0, count: 0 };
    const loaded = this._dayTx && this._dayTx.date === sel;
    const list = !loaded ? `<p class="muted small">Loading…</p>`
      : this._dayTx.transactions.length ? this._txRows(this._dayTx.transactions, sel)
      : `<p class="muted small">Nothing recorded on this day.</p>`;
    return `<div class="daychips">${chips}</div>
      <div class="daynav">
        <button class="link iconbtn2" id="txday-prev" aria-label="Previous day" title="Previous day">${
          this._icon("mdi:chevron-left")}</button>
        <input type="date" id="txday" name="txday" aria-label="Day" value="${sel}" max="${yesterday}">
        <button class="link iconbtn2" id="txday-next" aria-label="Next day" title="Next day"
          ${sel >= yesterday ? "disabled" : ""}>${this._icon("mdi:chevron-right")}</button>
      </div>
      <div class="daytotal">
        <div class="muted small">${esc(fmtDay(sel, { weekday: "long", month: "long", day: "numeric", year: "numeric" }))}</div>
        <div><span class="muted">Spent</span> <b class="dayspent">${this._money(t.spent)}</b>${
          t.income ? ` <span class="muted">· income ${this._money(t.income)}</span>` : ""}</div>
      </div>
      ${list}
      <button class="link showmore" id="txday-hide">Hide</button>`;
  }

  async _showTxDay(day) {
    const yesterday = addDays(todayIso(), -1);
    if (!day) return;
    this._txDay = day > yesterday ? yesterday : day;
    this._txOpen = true;
    this._confirmTx = null;
    this._render();  // the total shows straight away; the list follows
    try {
      const res = await this._call("list_transactions", { date: this._txDay });
      if (res.date === this._txDay) { this._dayTx = res; this._render(); }
    } catch (e) {
      this._error = e.message || String(e);
      this._render();
    }
  }

  // The date is left off rows dated `day` (the day the list is about).
  _txRows(list, day) {
    const sign = { expense: -1, income: 1, to_savings: -1, from_savings: 1, bill_payment: -1 };
    const kindLabel = { expense: "", income: "income", to_savings: "to savings",
                        from_savings: "from savings", bill_payment: "bill" };
    return list.map((t) => {
      const c = this._category(t.category_id);
      const adj = t.kind === "bill_adjustment";
      // A bill paid for more (or less) than its estimate: the difference is
      // settled in the budget automatically, so it can't be deleted here.
      const name = adj
        ? `${t.note}: ${this._money(t.amount)} ${t.difference > 0 ? "over" : "under"} estimate`
        : t.note;
      const date = t.date === day ? "" : t.date;
      const bits = adj
        ? [date, `paid ${this._money(t.paid)}, estimate ${this._money(t.estimate)}`].filter(Boolean)
        : [date, c ? c.name : "", kindLabel[t.kind]].filter(Boolean);
      const amt = adj ? -t.difference : sign[t.kind] * t.amount;
      const confirming = this._confirmTx === t.id;
      return `<div class="row">
        ${this._icon(this._txIcon(t), "lead")}
        <div class="grow">
          <div class="name">${esc(name)}</div>
          <div class="muted small">${esc(bits.join(" · "))}</div>
        </div>
        <div class="amt">${amt > 0 ? "+" : ""}${this._money(amt)}</div>
        ${t.readonly ? `<span class="iconbtn2" title="From a bill payment">${
            this._icon("mdi:file-document-outline", "tiny muted-icon")}</span>` : confirming
          ? `<div class="btns"><button class="secondary" data-keeptx>Keep</button>
               <button class="danger" data-dodeltx="${esc(t.id)}">Delete</button></div>`
          : `<button class="link iconbtn2" data-deltx="${esc(t.id)}" aria-label="Delete ${esc(t.note)}"
               title="Delete">${this._icon("mdi:close", "tiny muted-icon")}</button>`}
      </div>`;
    }).join("");
  }

  _streamList(type) {
    const today = todayIso();
    const list = (this._budget.recurring || []).filter((s) => s.type === type);
    if (!list.length) {
      return type === "income"
        ? `<p class="muted">No recurring income yet. Add your paycheck so the daily budget knows what's coming in.</p>`
        : `<p class="muted small">No savings plans yet.</p>`;
    }
    return list.map((s) => {
      const c = this._category(s.category_id);
      const ended = s.end_date && s.end_date < today;
      const upcoming = s.start_date > today;
      const when = ended ? `ended ${s.end_date}` : upcoming ? `starts ${s.start_date}`
        : s.end_date ? `until ${s.end_date}` : "open-ended";
      return `<div class="row ${ended ? "ended" : ""}">
        ${this._icon(c ? c.icon : (type === "income" ? "mdi:cash-multiple" : "mdi:piggy-bank"), "lead")}
        <div class="grow">
          <div class="name">${esc(s.name)}</div>
          <div class="muted small">${this._money(s.amount)} ${esc(this._often(s))} · ${esc(when)}</div>
        </div>
        <div class="btns"><button class="secondary" data-editstream="${esc(s.id)}">Edit</button></div>
      </div>`;
    }).join("");
  }

  _savingsCard() {
    const sv = this._budget.savings;
    return `<div class="stats two-stats">
        <div><div class="muted small">All-time savings</div><div class="big">${this._money(sv.total)}</div></div>
        <div><div class="muted small">Regular savings</div><div class="big">${this._money(sv.per_month)}<span class="muted small"> / month</span></div></div>
      </div>
      ${this._streamList("savings")}
      <div class="actions wrapactions">
        <button class="secondary" data-savemove="from">Take from savings</button>
        <button class="secondary" data-savemove="to">Move to savings</button>
        <button data-newstream="savings">Add plan</button>
      </div>`;
  }

  _txForm(type) {
    const income = type === "income";
    return `<form id="txform" class="card" novalidate>
      <div class="seg" role="radiogroup" aria-label="Type">
        <button type="button" class="segbtn ${income ? "" : "sel"}" data-type="expense" role="radio"
                aria-checked="${!income}">Expense</button>
        <button type="button" class="segbtn ${income ? "sel" : ""}" data-type="income" role="radio"
                aria-checked="${income}">Income</button>
      </div>
      <div class="err" data-formerr hidden></div>
      <label>Amount
        <input name="amount" class="bigin" ${MONEY_INPUT}
               placeholder="0.00" autofocus></label>
      <label>Category
        <span class="inline"><span id="caticon">${this._icon(BILL_ICON, "lead")}</span>
          <select name="category">${this._catOptions(null)}</select></span></label>
      <label>Note (optional)
        <input name="note" type="text" autocomplete="off" placeholder="Uses the category name if empty"
               role="combobox" aria-autocomplete="list" aria-controls="notesuggest" aria-expanded="false"></label>
      <div id="notesuggest" class="suggest" role="listbox" aria-label="Earlier notes" hidden></div>
      <label data-income>How often
        <select name="often">${this._oftenOptions("once", true)}</select></label>
      <label data-once>Date
        <input name="date" type="date" value="${todayIso()}"></label>
      <div class="two" data-recurring>
        <label>Starts <input name="start" type="date" value="${todayIso()}"></label>
        <label>Ends (optional) <input name="end" type="date"></label>
      </div>
      <p class="muted small" data-recurring>Leave the end date empty if it's open-ended; you can add one later.</p>
      <div class="actions">
        <button type="button" class="secondary" data-cancel>Cancel</button>
        <button type="submit" id="txsubmit">Add</button>
      </div>
    </form>`;
  }

  _streamForm(s, type) {
    const edit = !!s;
    type = s ? s.type : type;
    const income = type === "income";
    const key = s ? `${s.frequency[0]}${s.interval}` : "w2";
    return `<form id="streamform" class="card" novalidate>
      <h2>${edit ? "Edit " + esc(s.name) : income ? "Add recurring income" : "Add savings plan"}</h2>
      <div class="err" data-formerr hidden></div>
      <label>Name
        <input name="name" type="text" autocomplete="off" value="${esc(s ? s.name : "")}"
               placeholder="${income ? "e.g. Paycheck" : "e.g. Emergency fund"}"></label>
      <div class="two">
        <label>Amount
          <input name="amount" ${MONEY_INPUT}
                 value="${s ? moneyValue(s.amount) : ""}" placeholder="0.00" ${edit ? "" : "autofocus"}></label>
        <label>How often
          <select name="often">${this._oftenOptions(key, false)}</select></label>
      </div>
      ${income ? `<label>Category
        <span class="inline"><span id="caticon">${this._icon(
          (this._category(s && s.category_id) || {}).icon || BILL_ICON, "lead")}</span>
          <select name="category">${this._catOptions(s ? s.category_id : null)}</select></span></label>` : ""}
      <div class="two">
        <label>Starts <input name="start" type="date" value="${esc(s ? s.start_date : todayIso())}"></label>
        <label>Ends (optional) <input name="end" type="date" value="${esc(s && s.end_date ? s.end_date : "")}"></label>
      </div>
      <p class="muted small">${edit
        ? "Changes count from today on; days already past keep what they had."
        : "Leave the end date empty if it's open-ended; you can add one later."}</p>
      <div class="actions">
        ${edit ? `<button type="button" class="link danger-text" id="delstream">Delete…</button>
                  <span class="spacer"></span>` : ""}
        <button type="button" class="secondary" data-cancel>Cancel</button>
        <button type="submit">${edit ? "Save" : "Add"}</button>
      </div>
      ${edit ? `<div id="confirm" class="confirm" hidden>
        <p>Delete <b>${esc(s.name)}</b>? It stops counting from today. To keep it until a
          date instead, set an end date.</p>
        <div class="actions">
          <button type="button" class="secondary" id="keep">Keep it</button>
          <button type="button" class="danger" id="dodelstream">Delete</button>
        </div>
      </div>` : ""}
    </form>`;
  }

  _moveForm(dir) {
    const to = dir === "to";
    return `<form id="moveform" class="card" novalidate>
      <h2>${to ? "Move to savings" : "Take from savings"}</h2>
      <p class="muted small">${to ? "Takes it out of today's budget and adds it to savings."
        : "Takes it out of savings and adds it to today's budget."}</p>
      <div class="err" data-formerr hidden></div>
      <label>Amount
        <input name="amount" ${MONEY_INPUT}
               placeholder="0.00" autofocus></label>
      <label>Note (optional) <input name="note" type="text" autocomplete="off"></label>
      <label>Date <input name="date" type="date" value="${todayIso()}" max="${todayIso()}"></label>
      <div class="actions">
        <button type="button" class="secondary" data-cancel>Cancel</button>
        <button type="submit">${to ? "Move to savings" : "Take from savings"}</button>
      </div>
    </form>`;
  }

  _setupForm(first) {
    const B = this._budget || {};
    return `<form id="setupform" class="card" novalidate>
      <h2>${first ? "Set up your budget" : "Budget reset"}</h2>
      <p class="muted small">${first
        ? "Your daily budget is your recurring income, minus your bills and savings plans, spread over each day. What you don't spend carries over to tomorrow; overspending comes out of tomorrow."
        : "Resetting starts the budget again from a new start date and starting amounts. Days before it no longer count; your transactions, income and savings plans are kept."}</p>
      <div class="err" data-formerr hidden></div>
      <label>Start date
        <input name="start" type="date" value="${esc(first ? todayIso() : B.start_date)}" max="${todayIso()}"></label>
      <div class="two">
        <label>Starting spending money
          <input name="amount" ${MONEY_INPUT}
                 placeholder="0.00"></label>
        <label>Savings you already have
          <input name="savings" ${MONEY_INPUT} placeholder="0.00"></label>
      </div>
      <div class="actions">
        ${first ? "" : `<button type="button" class="secondary" data-cancel>Cancel</button>`}
        <button type="submit">${first ? "Start budget" : "Reset budget"}</button>
      </div>
    </form>`;
  }

  _bindTx(form) {
    const f = form.elements;
    let type = form.querySelector(".segbtn.sel").dataset.type;
    const submit = form.querySelector("#txsubmit");
    const sync = () => {
      const recurring = type === "income" && f.often.value !== "once";
      form.querySelectorAll("[data-income]").forEach((el) => { el.hidden = type !== "income"; });
      form.querySelectorAll("[data-recurring]").forEach((el) => { el.hidden = !recurring; });
      form.querySelectorAll("[data-once]").forEach((el) => { el.hidden = recurring; });
      form.querySelectorAll(".segbtn").forEach((b) => {
        b.classList.toggle("sel", b.dataset.type === type);
        b.setAttribute("aria-checked", String(b.dataset.type === type));
      });
      submit.textContent = type === "expense" ? "Add expense"
        : recurring ? "Add recurring income" : "Add income";
    };
    form.querySelectorAll(".segbtn").forEach((b) => b.addEventListener("click", () => {
      type = b.dataset.type;
      sync();
    }));
    f.often.addEventListener("change", sync);
    const showCatIcon = () => {
      form.querySelector("#caticon").innerHTML =
        this._billIcon({ category_id: f.category.value || null });
    };
    f.category.addEventListener("change", showCatIcon);
    sync();

    // Notes used before: typing "Ch" offers "Chipotle". Ones starting with
    // what's typed come first, then ones containing it.
    const box = form.querySelector("#notesuggest");
    const hide = () => { box.hidden = true; f.note.setAttribute("aria-expanded", "false"); };
    const suggest = () => {
      const q = f.note.value.trim().toLowerCase();
      const notes = ((this._budget && this._budget.recent_notes) || {})[type] || [];
      const hits = !q ? [] : [
        ...notes.filter((n) => n.note.toLowerCase().startsWith(q)),
        ...notes.filter((n) => !n.note.toLowerCase().startsWith(q) && n.note.toLowerCase().includes(q)),
      ].filter((n) => n.note.toLowerCase() !== q).slice(0, NOTE_SUGGESTIONS);
      if (!hits.length) return hide();
      box.innerHTML = hits.map((n, i) => {
        const c = this._category(n.category_id);
        return `<button type="button" class="suggestion" role="option" data-note="${i}">
            <span>${esc(n.note)}</span>${c ? `<span class="muted small">${esc(c.name)}</span>` : ""}
          </button>`;
      }).join("");
      box.querySelectorAll("[data-note]").forEach((b) => {
        // pointerdown keeps the field focused (and the keyboard up) on phones.
        b.addEventListener("pointerdown", (e) => e.preventDefault());
        b.addEventListener("click", () => {
          const n = hits[Number(b.dataset.note)];
          f.note.value = n.note;
          // Fill in the category used with it last time, unless one's picked.
          if (!f.category.value && this._category(n.category_id)) {
            f.category.value = n.category_id;
            showCatIcon();
          }
          hide();
        });
      });
      box.hidden = false;
      f.note.setAttribute("aria-expanded", "true");
    };
    f.note.addEventListener("input", suggest);
    f.note.addEventListener("focus", suggest);
    f.note.addEventListener("blur", hide);
    f.note.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
    form.querySelectorAll(".segbtn").forEach((b) => b.addEventListener("click", hide));

    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const amount = parseFloat(f.amount.value);
      if (!(amount > 0)) return this._formError(form, "Enter an amount.");
      const base = { amount };
      if (f.category.value) base.category = f.category.value;
      const note = f.note.value.trim();
      const catName = (this._category(f.category.value) || {}).name;
      const label = note || catName || (type === "expense" ? "Expense" : "Income");
      if (type === "income" && f.often.value !== "once") {
        if (!f.start.value) return this._formError(form, "Pick a start date.");
        if (f.end.value && f.end.value < f.start.value) {
          return this._formError(form, "The end date can't be before the start date.");
        }
        const data = { ...base, type: "income", ...this._parseOften(f.often.value),
                       start_date: f.start.value };
        if (note) data.name = note;
        if (f.end.value) data.end_date = f.end.value;
        return this._submit(form, "add_recurring", data, (r) =>
          `Added ${r.recurring.name}: ${this._money(amount)} ${this._often(r.recurring)}.`);
      }
      const data = { ...base, date: f.date.value || todayIso() };
      if (note) data.note = note;
      this._submit(form, type === "expense" ? "add_expense" : "add_income", data, (r) =>
        `Added ${label} ${type === "expense" ? "−" : "+"}${this._money(amount)}. ` +
        `Today's budget: ${this._money(r.today)}.`);
    });
  }

  _bindStream(form, s, type) {
    const f = form.elements;
    if (f.category) {
      f.category.addEventListener("change", () => {
        form.querySelector("#caticon").innerHTML =
          this._billIcon({ category_id: f.category.value || null });
      });
    }
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const amount = parseFloat(f.amount.value);
      if (!(amount > 0)) return this._formError(form, "Enter an amount.");
      if (!f.start.value) return this._formError(form, "Pick a start date.");
      if (f.end.value && f.end.value < f.start.value) {
        return this._formError(form, "The end date can't be before the start date.");
      }
      const name = f.name.value.trim();
      const data = { amount, ...this._parseOften(f.often.value), start_date: f.start.value,
                     end_date: f.end.value || null };
      const category = f.category ? (f.category.value || null) : null;
      if (!s) {
        const add = { ...data, type };
        if (!add.end_date) delete add.end_date;
        if (name) add.name = name;
        if (category) add.category = category;
        return this._submit(form, "add_recurring", add, (r) => `Added ${r.recurring.name}.`);
      }
      const before = { amount: s.amount, frequency: s.frequency, interval: s.interval,
                       start_date: s.start_date, end_date: s.end_date || null };
      const changes = {};
      for (const [k, v] of Object.entries(data)) if (v !== before[k]) changes[k] = v;
      if (name && name !== s.name) changes.name = name;
      if (f.category && category !== (s.category_id || null)) changes.category = category;
      if (!Object.keys(changes).length) return this._close();
      this._submit(form, "update_recurring", { recurring: s.id, ...changes },
        (r) => `Saved ${r.recurring.name}.`);
    });
    if (s) {
      this._bindConfirm(form, "delstream", "dodelstream", async () => {
        await this._call("delete_recurring", { recurring: s.id });
        this._flash(`Deleted ${s.name}.`);
        this._close(false);
        await this._refresh();
      });
    }
  }

  _bindMove(form, dir) {
    const f = form.elements;
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const amount = parseFloat(f.amount.value);
      if (!(amount > 0)) return this._formError(form, "Enter an amount.");
      const data = { amount, date: f.date.value || todayIso() };
      if (f.note.value.trim()) data.note = f.note.value.trim();
      this._submit(form, dir === "to" ? "move_to_savings" : "take_from_savings", data, (r) =>
        `${dir === "to" ? "Moved" : "Took"} ${this._money(amount)} ${dir === "to" ? "to" : "from"} savings. ` +
        `Today's budget: ${this._money(r.today)}.`);
    });
  }

  _bindSetup(form) {
    const f = form.elements;
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (!f.start.value) return this._formError(form, "Pick a start date.");
      const amount = f.amount.value === "" ? 0 : parseFloat(f.amount.value);
      const savings = f.savings.value === "" ? 0 : parseFloat(f.savings.value);
      if (Number.isNaN(amount)) return this._formError(form, "Starting spending money isn't a number.");
      if (!(savings >= 0)) return this._formError(form, "Savings can't be negative.");
      this._submit(form, "budget_setup",
        { start_date: f.start.value, starting_amount: amount, starting_savings: savings },
        () => (this._budget && this._budget.configured
          ? `Budget reset from ${f.start.value}.`
          : "Budget started. Add your recurring income next."));
    });
  }

  // ---------- forms ----------

  _payForm(b) {
    const w = this._when(b.next_due);
    const current = b.amount === null || b.amount === undefined
      ? "no estimate yet" : `currently ${this._money(b.amount)}`;
    return `<form id="payform" class="card">
      <h2>Pay ${esc(b.name)}</h2>
      <p class="muted ${w.cls}">Due ${esc(b.next_due)} · ${w.text}</p>
      <div class="err" data-formerr hidden></div>
      <label>Amount paid
        <input name="amount" ${MONEY_INPUT}
               value="${moneyValue(b.amount)}" placeholder="0.00" autofocus></label>
      <label class="check" id="estrow" hidden>
        <input name="update_amount" type="checkbox">
        <span>Use this as the new estimate <span class="muted">(${esc(current)})</span></span></label>
      <p class="muted small" id="budgetdiff" hidden></p>
      <label>Date paid
        <input name="paid_date" type="date" value="${todayIso()}" required></label>
      <label>Confirmation number (optional)
        <input name="confirmation" type="text"></label>
      <label>Note (optional)
        <input name="note" type="text"></label>
      <div class="actions">
        <button type="button" class="secondary" data-cancel>Cancel</button>
        <button type="submit">Record payment</button>
      </div>
    </form>`;
  }

  _restoreForm(b) {
    const ended = !b.restore_due;
    return `<form id="restoreform" class="card">
      <h2>Restore ${esc(b.name)}</h2>
      <div class="err" data-formerr hidden></div>
      <p class="muted">${ended
        ? "Its schedule has no dates left, so pick when it's next due."
        : "It goes back on the list with reminders. Check the next due date."}</p>
      <label>Next due
        <input name="due_date" type="date" required value="${esc(b.restore_due ?? "")}"></label>
      ${b.end_date ? `<p class="muted small">If the end date (${esc(b.end_date)}) is before this,
        it's removed.</p>` : ""}
      <div class="actions">
        <button type="button" class="secondary" data-cancel>Cancel</button>
        <button type="submit">Restore bill</button>
      </div>
    </form>`;
  }

  _billForm(b) {
    const edit = !!b;
    const v = b || { ...NEW_BILL, next_due: todayIso() };
    const opts = FREQUENCIES.map(([val, label]) =>
      `<option value="${val}" ${v.frequency === val ? "selected" : ""}>${label}</option>`
    ).join("");
    const catOpts = [`<option value="">Uncategorized</option>`].concat(
      this._categories.map((c) =>
        `<option value="${esc(c.id)}" ${v.category_id === c.id ? "selected" : ""}>${esc(c.name)}</option>`)
    ).join("");
    return `<form id="billform" class="card" novalidate>
      <h2>${edit ? "Edit " + esc(v.name) : "Add a bill"}</h2>
      ${edit ? `<button type="button" class="link histlink" data-history="${esc(v.id)}">
        ${this._icon("mdi:chart-bar", "tiny")} Payment history</button>` : ""}
      <div class="err" data-formerr hidden></div>
      <label>Name
        <input name="name" type="text" required autocomplete="off" value="${esc(v.name)}"
               placeholder="e.g. Phone" ${edit ? "" : "autofocus"}></label>
      <label>Category
        <span class="inline">
          <span id="caticon">${this._billIcon(v)}</span>
          <select name="category">${catOpts}</select>
        </span></label>
      ${this._categories.length ? "" : `<p class="muted small hint">Make categories with the
        <b>Categories</b> tab.</p>`}
      <div class="two">
        <label>Amount
          <input name="amount" ${MONEY_INPUT}
                 value="${moneyValue(v.amount)}" placeholder="Varies"></label>
        <label>${edit ? "Next due" : "First due date"}
          <input name="due_date" type="date" required value="${esc(v.next_due)}"></label>
      </div>
      <label class="check">
        <input name="in_budget" type="checkbox" ${v.in_budget !== false ? "checked" : ""}>
        <span>Count in my budget</span></label>
      <p class="muted small hint" id="budgethint"></p>
      <p class="note-box small" id="noamount" hidden>Without an amount, this bill isn't counted
        in your budget. Add an estimate here, tick <b>Use this as the new estimate</b> when
        you pay it, or record what you pay as an expense in the Budget tab.</p>
      <div class="two">
        <label>Repeats
          <select name="frequency">${opts}</select></label>
        <label data-repeat>Every
          <span class="inline">
            <input name="interval" type="number" min="1" step="1" inputmode="numeric"
                   value="${v.interval}">
            <span id="unit"></span>
          </span></label>
      </div>
      <label data-repeat>Ends (optional)
        <input name="end_date" type="date" value="${esc(v.end_date ?? "")}"></label>
      <label>Remind me this many days before
        <input name="remind_days_before" type="number" min="0" step="1" inputmode="numeric"
               value="${v.remind_days_before}"></label>
      <label class="check">
        <input name="autopay" type="checkbox" ${v.autopay ? "checked" : ""}>
        <span>Autopay</span></label>
      <label>Payment website (optional)
        <input name="biller_url" type="text" inputmode="url" autocomplete="off"
               placeholder="https://" value="${esc(v.biller_url ?? "")}"></label>
      <label>Notes (optional)
        <input name="notes" type="text" value="${esc(v.notes ?? "")}"></label>
      ${edit ? `<p class="muted small">Changing the due date or how often it repeats
        restarts the schedule from the new due date.</p>` : ""}
      <div class="actions">
        ${edit ? `<button type="button" class="link danger-text" id="retire">Retire…</button>
                  <span class="spacer"></span>` : ""}
        <button type="button" class="secondary" data-cancel>Cancel</button>
        <button type="submit">${edit ? "Save" : "Add bill"}</button>
      </div>
      ${edit ? `<div id="confirm" class="confirm" hidden>
        <p>Retire <b>${esc(v.name)}</b>? It disappears from the list and reminders stop.
           Its payment history is kept.</p>
        <div class="actions">
          <button type="button" class="secondary" id="keep">Keep it</button>
          <button type="button" class="danger" id="doretire">Retire bill</button>
        </div>
      </div>` : ""}
    </form>`;
  }

  _categoriesView() {
    const rows = this._categories.length
      ? this._categories.map((c) => `<div class="row">
          ${this._icon(c.icon, "lead")}
          <div class="grow">
            <div class="name">${esc(c.name)}</div>
            <div class="muted small">${c.bill_count} active bill${c.bill_count === 1 ? "" : "s"}</div>
          </div>
          <div class="btns">
            <button class="secondary" data-editcat="${esc(c.id)}">Edit</button>
          </div>
        </div>`).join("")
      : `<p class="muted">No categories yet. Tap <b>+ New</b> to add one, then pick it for
          bills, expenses and income.</p>`;
    return `<p class="muted small">Shared by bills and the budget. Each category's icon
        shows next to its bills and transactions.</p>
      <div class="card">${rows}</div>`;
  }

  _categoryForm(c) {
    const edit = !!c;
    const icon = c ? c.icon : DEFAULT_CATEGORY_ICON;
    const grid = SUGGESTED_ICONS.map((i) =>
      `<button type="button" class="iconbtn ${i === icon ? "sel" : ""}" data-icon="${i}"
               title="${i}" aria-label="${i}">${this._icon(i)}</button>`).join("");
    return `<form id="catform" class="card" novalidate>
      <h2>${edit ? "Edit category" : "New category"}</h2>
      <div class="err" data-formerr hidden></div>
      <label>Name
        <input name="name" type="text" required autocomplete="off" value="${esc(c ? c.name : "")}"
               placeholder="e.g. Utilities" ${edit ? "" : "autofocus"}></label>
      <label>Icon
        <span class="inline">
          <span id="iconpreview">${this._icon(icon, "lead")}</span>
          <input name="icon" type="text" autocomplete="off" autocapitalize="off"
                 spellcheck="false" value="${esc(icon)}" placeholder="mdi:tag">
        </span></label>
      <p class="muted small hint">Tap one below, or type any icon name from
        Home Assistant (e.g. <code>mdi:lightning-bolt</code>).</p>
      <div class="icongrid">${grid}</div>
      <div class="actions">
        ${edit ? `<button type="button" class="link danger-text" id="delcat">Delete…</button>
                  <span class="spacer"></span>` : ""}
        <button type="button" class="secondary" id="catback">Cancel</button>
        <button type="submit">${edit ? "Save" : "Add category"}</button>
      </div>
      ${edit ? `<div id="confirm" class="confirm" hidden>
        <p>Delete <b>${esc(c.name)}</b>? ${c.bill_count
          ? `Its ${c.bill_count} bill${c.bill_count === 1 ? "" : "s"} become uncategorized.`
          : "No bills use it."}</p>
        <div class="actions">
          <button type="button" class="secondary" id="keep">Keep it</button>
          <button type="button" class="danger" id="dodelete">Delete category</button>
        </div>
      </div>` : ""}
    </form>`;
  }

  // Read the bill form into service fields. Returns { data } or { error }.
  _readBillForm(form) {
    const f = form.elements;
    const name = f.name.value.trim();
    if (!name) return { error: "Give the bill a name." };
    if (!f.due_date.value) return { error: "Pick a due date." };
    const frequency = f.frequency.value;
    const interval = parseInt(f.interval.value, 10);
    if (frequency !== "once" && !(interval >= 1)) {
      return { error: "“Every” must be 1 or more." };
    }
    const remind = parseInt(f.remind_days_before.value, 10);
    if (!(remind >= 0)) return { error: "Reminder days must be 0 or more." };
    let amount = null;
    if (f.amount.value !== "") {
      amount = parseFloat(f.amount.value);
      if (!(amount >= 0)) return { error: "Amount must be 0 or more." };
    }
    const end = frequency === "once" ? null : (f.end_date.value || null);
    if (end && end < f.due_date.value) {
      return { error: "The end date can't be before the due date." };
    }
    let url = f.biller_url.value.trim() || null;
    if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
    return {
      data: {
        name,
        category: f.category.value || null,
        amount,
        due_date: f.due_date.value,
        frequency,
        interval: frequency === "once" ? 1 : interval,
        end_date: end,
        remind_days_before: remind,
        autopay: f.autopay.checked,
        in_budget: f.in_budget.checked,
        biller_url: url,
        notes: f.notes.value.trim() || null,
      },
    };
  }

  // ---------- render ----------

  _render() {
    const k = this._form && this._form.kind;
    const id = this._form && this._form.id;
    let b = null;
    if (id && k === "restore") b = this._retiredBill(id);
    else if (id && k === "category") b = this._category(id);
    else if (id) b = this._bill(id);
    let formHtml = "";
    if (k === "restore" && b) formHtml = this._restoreForm(b);
    else if (k === "pay" && b) formHtml = this._payForm(b);
    else if (k === "edit" && b) formHtml = this._billForm(b);
    else if (k === "add") formHtml = this._billForm(null);
    else if (k === "category") formHtml = this._categoryForm(b);
    else if (k === "history") formHtml = this._historyView();
    else if (k === "tx") formHtml = this._txForm(this._form.type);
    else if (k === "stream") {
      const s = id && this._budget ? (this._budget.recurring || []).find((x) => x.id === id) : null;
      b = s;
      formHtml = this._streamForm(s, this._form.type);
    } else if (k === "savemove") formHtml = this._moveForm(this._form.dir);
    else if (k === "budgetsetup") formHtml = this._setupForm(!(this._budget && this._budget.configured));
    const budgetTab = this._tab === "budget";
    const configured = this._budget && this._budget.configured;
    const catTab = this._tab === "categories";
    const tabBtn = (t, label) => `<button class="tab ${this._tab === t ? "sel" : ""}" role="tab"
        aria-selected="${this._tab === t}" data-tab="${t}">${label}</button>`;
    let actions = "";
    if (budgetTab && configured && k !== "tx") {
      actions = `<button id="addtx" class="addbtn">${this._icon("mdi:plus", "onprimary")} Add</button>`;
    } else if (catTab && k !== "category") {
      actions = `<button id="newcat" class="addbtn">${this._icon("mdi:plus", "onprimary")} New</button>`;
    } else if (!budgetTab && !catTab && k !== "add") {
      actions = `<button id="add" class="addbtn">${this._icon("mdi:plus", "onprimary")} Add bill</button>`;
    }
    let body;
    if (budgetTab) body = this._budgetTab();
    else if (catTab) body = this._categoriesView();
    else {
      body = `<h2>Upcoming</h2>
        <div class="card">${this._billsList()}</div>
        <h2>Recent payments</h2>
        <div class="card">${this._paymentsList()}</div>
        ${this._costs_html()}
        ${this._retiredSection()}`;
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; background: var(--primary-background-color); min-height: 100vh; }
        [hidden] { display: none !important; }
        .wrap { max-width: 640px; margin: 0 auto; padding: 16px; color: var(--primary-text-color); }
        header { display: flex; align-items: center; gap: 8px; }
        header h1 { flex: 1; }
        h1 { font-size: 24px; margin: 8px 0 16px; }
        h2 { font-size: 18px; margin: 24px 0 8px; }
        .h-sub { font-size: 15px; font-weight: 400; }
        .card { background: var(--card-background-color); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
        .card h2 { margin-top: 0; }
        .row { display: flex; align-items: center; gap: 12px; padding: 10px 0;
               border-bottom: 1px solid var(--divider-color); }
        .row:last-child { border-bottom: 0; }
        .grow { flex: 1; min-width: 0; }
        .name { font-weight: 500; overflow-wrap: anywhere; }
        .amt { white-space: nowrap; }
        .btns { display: flex; gap: 6px; }
        .btns button { padding: 8px 12px; }
        ha-icon { --mdc-icon-size: 22px; color: var(--state-icon-color, var(--secondary-text-color)); }
        ha-icon.lead { flex: none; }
        .muted { color: var(--secondary-text-color); font-size: 14px; }
        .small { font-size: 13px; }
        .hint { margin: -6px 0 8px; }
        .late { color: var(--error-color); }
        .soon { color: var(--warning-color); }
        .tag { font-size: 11px; border: 1px solid var(--divider-color); border-radius: 8px; padding: 1px 6px; font-weight: 400; }
        label { display: block; margin: 12px 0; font-size: 14px; color: var(--secondary-text-color); }
        input, select { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 10px;
                font-size: 16px; line-height: 1.25; border-radius: 8px; border: 1px solid var(--divider-color);
                background: var(--card-background-color); color: var(--primary-text-color); font-family: inherit; }
        input[type="date"] { -webkit-appearance: none; appearance: none; min-width: 0;
                max-width: 100%; height: calc(1.25em + 22px); line-height: 1.25; text-align: left; }
        input[type="date"]::-webkit-date-and-time-value { text-align: left; margin: 0; }
        input[type="date"]::-webkit-calendar-picker-indicator { opacity: .7; }
        label.check { display: flex; align-items: center; gap: 10px; color: var(--primary-text-color); font-size: 15px; }
        label.check input { width: 20px; height: 20px; margin: 0; flex: none; }
        .two { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
        .two label { min-width: 0; }
        .inline { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
        .inline input, .inline select { margin-top: 0; }
        .inline input[name="interval"] { width: 5em; flex: none; }
        .inline span { color: var(--primary-text-color); }
        .inline > span:first-child { display: flex; }
        .icongrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(44px, 1fr)); gap: 6px; }
        .iconbtn { background: transparent; border: 1px solid var(--divider-color); padding: 8px;
                   display: flex; align-items: center; justify-content: center; }
        .iconbtn.sel { border: 2px solid var(--primary-color); padding: 7px; }
        .iconbtn.sel ha-icon { color: var(--primary-color); }
        code { font-size: 12px; }
        .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
        .big { font-size: 20px; font-weight: 500; white-space: nowrap; }
        .meter, .minibar { background: var(--divider-color); border-radius: 4px; overflow: hidden; }
        .meter { height: 8px; margin: 12px 0 4px; }
        .meter-label { text-align: right; margin-bottom: 4px; }
        .showmore { width: 100%; margin-top: 4px; color: var(--primary-color); }
        .chips { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
                 gap: 6px; margin-bottom: 14px; }
        .chip { background: transparent; color: var(--primary-text-color); text-align: left;
                border: 1px solid var(--divider-color); padding: 6px 8px;
                display: flex; flex-direction: column; gap: 2px; }
        .chip span { font-size: 12px; color: var(--secondary-text-color); }
        .chip b { font-size: 13px; font-weight: 500; white-space: nowrap; }
        .chip.sel { border: 2px solid var(--primary-color); padding: 5px 7px; }
        .chip.sel span { color: var(--primary-color); }
        .selbar { display: flex; align-items: center; justify-content: space-between;
                  gap: 8px; margin: -6px 0 8px; }
        .selhead { font-weight: 500; }
        .monthstoggle { display: flex; align-items: center; gap: 2px; color: var(--primary-color);
                        white-space: nowrap; }
        ha-icon.tiny { --mdc-icon-size: 18px; color: var(--primary-color); }
        .yearhead { width: 100%; display: flex; align-items: center; gap: 12px; padding: 0;
                    background: transparent; color: var(--primary-text-color);
                    font-size: 16px; text-align: left; }
        .yearbody { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--divider-color); }
        .billlines { margin-top: 8px; }
        .billline { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0;
                    font-size: 13px; color: var(--secondary-text-color); }
        .billline > span:first-child { color: var(--primary-text-color); overflow-wrap: anywhere; }
        .billline > span:last-child { text-align: right; }
        button.rowlink { background: transparent; color: inherit; padding: 0; border: 0;
                         text-align: left; font: inherit; border-radius: 4px; }
        button.rowlink:hover .name { text-decoration: underline; }
        .histlink { display: flex; align-items: center; gap: 4px; color: var(--primary-color);
                    margin: -4px 0 4px; padding-left: 0; }
        .histhead { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
        .histhead h2 { margin: 0; }
        h3 { font-size: 15px; margin: 20px 0 4px; }
        .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; }
        .tile { min-width: 0; }
        .tilev { font-size: 18px; font-weight: 500; overflow-wrap: anywhere; }
        .yoy { margin: 12px 0 0; }
        .yoy b { color: var(--primary-text-color); font-weight: 500; }
        .chart { margin-top: 16px; }
        .plot { position: relative; height: 160px; margin-top: 20px; }
        .gl { position: absolute; left: 0; right: 0; border-top: 1px solid var(--divider-color); }
        .gl span { position: absolute; left: 0; width: 44px; transform: translateY(-50%);
                   background: var(--card-background-color); font-size: 11px;
                   color: var(--secondary-text-color); }
        .est { position: absolute; left: 48px; right: 0; border-top: 1px dashed var(--secondary-text-color); }
        .est span { position: absolute; left: 4px; bottom: 2px; font-size: 11px; z-index: 1;
                    color: var(--secondary-text-color); background: var(--card-background-color);
                    padding: 0 2px; }
        .cols { position: absolute; left: 48px; right: 0; top: 0; bottom: 0;
                display: flex; align-items: flex-end; gap: 2px; }
        .col { flex: 1; min-width: 0; height: 100%; position: relative; padding: 0;
               background: transparent; border-radius: 0; display: flex;
               align-items: flex-end; justify-content: center; }
        .col .bar { display: block; width: 100%; max-width: 24px; height: var(--h);
                    min-height: 2px; background: var(--primary-color); opacity: .75;
                    border-radius: 4px 4px 0 0; }
        .col.on .bar, .col:hover .bar, .col:focus-visible .bar { opacity: 1; }
        .col .cap { position: absolute; bottom: calc(var(--h) + 2px); font-size: 11px;
                    white-space: nowrap; color: var(--primary-text-color); right: 0; }
        .xlabels { display: flex; justify-content: space-between; margin-left: 48px;
                   font-size: 11px; color: var(--secondary-text-color); padding-top: 4px; }
        .charttip { margin-top: 6px; min-height: 18px; }
        .row.hist .delta { white-space: nowrap; text-align: right; min-width: 64px; }
        .minibar { height: 4px; margin-top: 6px; }
        .meter span, .minibar span { display: block; height: 100%; background: var(--primary-color); }
        .row.cat .amt { font-weight: 500; }
        .note { margin: 12px 0 0; }
        button { font-size: 14px; padding: 8px 16px; border-radius: 8px; border: 0; cursor: pointer;
                 background: var(--primary-color); color: var(--text-primary-color, #fff); font-family: inherit; }
        button.secondary { background: transparent; color: var(--primary-text-color);
                           border: 1px solid var(--divider-color); }
        button.danger { background: var(--error-color); color: #fff; }
        button.link { background: transparent; padding: 8px 4px; }
        .danger-text { color: var(--error-color); }
        button:disabled { opacity: .5; cursor: default; }
        .actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; margin-top: 16px; }
        .spacer { flex: 1; }
        .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
        .section-head button.link { color: var(--primary-color); }
        .confirm { margin-top: 16px; padding: 12px; border-radius: 8px;
                   border: 1px solid var(--error-color); }
        .confirm p { margin: 0; }
        .confirm .actions { margin-top: 12px; }
        .ok, .err { padding: 10px 12px; border-radius: 8px; margin-bottom: 12px; }
        .ok { background: var(--success-color, #2e7d32); color: #fff; transition: opacity .4s; }
        .ok.hide { opacity: 0; }
        .err { background: var(--error-color); color: #fff; }
        h1 { margin: 8px 0 12px; }
        header { margin-bottom: 8px; flex-wrap: wrap; }
        .tabs { display: inline-flex; border: 1px solid var(--divider-color); border-radius: 10px;
                padding: 3px; gap: 2px; }
        .tab { background: transparent; color: var(--primary-text-color); padding: 7px 18px;
               border-radius: 7px; font-weight: 500; }
        .tab.sel { background: var(--primary-color); color: var(--text-primary-color, #fff); }
        .addbtn { display: flex; align-items: center; gap: 4px; font-weight: 500; padding: 8px 14px 8px 10px; }
        ha-icon.onprimary { --mdc-icon-size: 20px; color: var(--text-primary-color, #fff); }
        ha-icon.muted-icon { color: var(--secondary-text-color); }
        .hero { text-align: center; padding: 20px 16px; }
        .heroamt { font-size: 44px; font-weight: 500; line-height: 1.15; margin: 4px 0 6px; }
        .days3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 16px 0 10px; }
        .day { border: 1px solid var(--divider-color); border-radius: 10px; padding: 8px 4px; }
        .dayamt { font-size: 17px; font-weight: 500; white-space: nowrap; }
        .breakdown { margin-top: 4px; }
        .eyebtn { margin: 4px auto 0; }
        .suggest { margin: -6px 0 12px; border: 1px solid var(--divider-color); border-radius: 10px;
                   overflow: hidden; }
        .suggestion { display: flex; width: 100%; justify-content: space-between; align-items: baseline;
                      gap: 12px; padding: 10px 12px; background: transparent; border-radius: 0;
                      color: var(--primary-text-color); text-align: left; font-size: 15px; }
        .suggestion + .suggestion { border-top: 1px solid var(--divider-color); }
        .suggestion:hover, .suggestion:focus-visible { background: rgba(127, 127, 127, .12); }
        .daychips::-webkit-scrollbar { display: none; }
        .daychips { position: relative; display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px;
                    scrollbar-width: none; }
        .daychips .chip { flex: 0 0 auto; min-width: 84px; }
        .daynav { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; }
        .daynav input { flex: 1; }
        .daynav button:disabled { opacity: .3; }
        .daytotal { text-align: center; margin: 12px 0 8px; }
        .dayspent { font-size: 20px; font-weight: 500; }
        .seg { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 3px;
               border: 1px solid var(--divider-color); border-radius: 10px; margin-bottom: 8px; }
        .segbtn { background: transparent; color: var(--primary-text-color); font-weight: 500; padding: 9px; }
        .segbtn.sel { background: var(--primary-color); color: var(--text-primary-color, #fff); }
        input.bigin { font-size: 24px; padding: 10px 12px; }
        .addlink { color: var(--primary-color); }
        .iconbtn2 { padding: 6px; display: flex; }
        .two-stats { grid-template-columns: 1fr 1fr; margin-bottom: 8px; }
        .wrapactions { flex-wrap: wrap; }
        .row.ended { opacity: .6; }
        .settings { text-align: center; margin: 8px 0 24px; }
        .note-box { margin: 0 0 4px; padding: 8px 10px; border-radius: 8px;
                    border: 1px solid var(--divider-color); color: var(--secondary-text-color); }
        .note-box b { color: var(--primary-text-color); font-weight: 500; }
        .settings .link { color: var(--secondary-text-color); text-decoration: underline; }
        @media (max-width: 420px) {
          .heroamt { font-size: 38px; }
          .dayamt { font-size: 15px; }
          .two { grid-template-columns: 1fr; }
          .big { font-size: 17px; }
        }
      </style>
      <div class="wrap">
        <h1>Bills &amp; Budget</h1>
        <header>
          <div class="tabs" role="tablist">
            ${tabBtn("bills", "Bills")}${tabBtn("budget", "Budget")}${tabBtn("categories", "Categories")}
          </div>
          <span class="spacer"></span>
          ${actions}
        </header>
        ${this._error ? `<div class="err">${esc(this._error)}</div>` : ""}
        ${this._msg ? `<div class="ok">${esc(this._msg)}</div>` : ""}
        ${formHtml}
        ${body}
      </div>`;
    this._bind(k, b);
    // Keep the picked day's chip in view (re-rendering resets the scroll).
    const row = this.shadowRoot.querySelector(".daychips");
    const chip = row && row.querySelector(".chip.sel");
    if (chip) row.scrollLeft = chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2;
  }

  _bind(kind, item) {
    const root = this.shadowRoot;
    const on = (id, fn) => { const el = root.getElementById(id); if (el) el.addEventListener("click", fn); };
    const each = (attr, fn) => root.querySelectorAll(`[data-${attr}]`).forEach((btn) =>
      btn.addEventListener("click", () => fn(btn.dataset[attr])));
    on("add", () => this._open("add"));
    each("tab", (t) => this._setTab(t));
    on("addtx", () => this._open("tx", null, { type: "expense" }));
    on("budget-settings", () => this._open("budgetsetup"));
    on("toggle-tx", () => { this._showAllTx = !this._showAllTx; this._render(); });
    on("toggle-breakdown", () => {
      this._showBreakdown = !this._showBreakdown;
      try { localStorage.setItem("bills-panel-breakdown", this._showBreakdown ? "1" : "0"); } catch (e) { /* private mode */ }
      this._render();
    });
    each("txday", (d) => this._showTxDay(d));
    on("txday-prev", () => this._showTxDay(addDays(this._txDay, -1)));
    on("txday-next", () => this._showTxDay(addDays(this._txDay, 1)));
    on("txday-hide", () => { this._txOpen = false; this._confirmTx = null; this._render(); });
    const dayInput = root.getElementById("txday");
    if (dayInput) dayInput.addEventListener("change", () => this._showTxDay(dayInput.value));
    each("newstream", (t) => this._open("stream", null, { type: t }));
    each("editstream", (id) => this._open("stream", id));
    each("savemove", (d) => this._open("savemove", null, { dir: d }));
    each("deltx", (id) => { this._confirmTx = id; this._render(); });
    root.querySelectorAll("[data-keeptx]").forEach((b) =>
      b.addEventListener("click", () => { this._confirmTx = null; this._render(); }));
    each("dodeltx", async (id) => {
      try {
        await this._call("delete_transaction", { transaction: id });
        this._flash("Transaction deleted.");
      } catch (e) {
        this._error = e.message || String(e);
      }
      this._confirmTx = null;
      await this._refresh();
    });
    if (kind === "tx") this._bindTx(root.getElementById("txform"));
    if (kind === "stream") this._bindStream(root.getElementById("streamform"), item, this._form.type);
    if (kind === "savemove") this._bindMove(root.getElementById("moveform"), this._form.dir);
    const setup = root.getElementById("setupform");
    if (setup) this._bindSetup(setup);
    on("newcat", () => this._open("category"));
    on("toggle-payments", () => {
      this._showMorePayments = !this._showMorePayments;
      this._render();
    });
    on("toggle-bills", () => {
      this._showAllBills = !this._showAllBills;
      this._render();
    });
    on("toggle-retired", () => {
      this._showRetired = !this._showRetired;
      this._render();
    });
    each("pay", (id) => this._open("pay", id));
    each("edit", (id) => this._open("edit", id));
    each("restore", (id) => this._open("restore", id));
    each("history", (id) => this._openHistory(id));
    on("hist-all", () => {
      this._history.showAll = !this._history.showAll;
      this._render();
    });
    root.querySelectorAll("[data-tip]").forEach((col) => {
      const show = () => {
        const tip = root.getElementById("charttip");
        if (tip) tip.textContent = col.dataset.tip;
        root.querySelectorAll(".col.on").forEach((c) => c.classList.remove("on"));
        col.classList.add("on");
      };
      col.addEventListener("mouseenter", show);
      col.addEventListener("focus", show);
      col.addEventListener("click", show);
    });
    each("editcat", (id) => this._open("category", id));
    each("ysel", (v) => {
      const [year, idx] = v.split(":").map(Number);
      this._yearSel[year] = idx;
      this._render();
    });
    each("monthstoggle", (v) => {
      const year = Number(v);
      if (this._showMonths.has(year)) {
        this._showMonths.delete(year);
        this._yearSel[year] = -1;  // back to the Total view
      } else {
        this._showMonths.add(year);
      }
      this._render();
    });
    each("yeartoggle", (v) => {
      const year = Number(v);
      if (this._openYears.has(year)) this._openYears.delete(year);
      else this._openYears.add(year);
      this._render();
    });
    root.querySelectorAll("[data-cancel]").forEach((btn) =>
      btn.addEventListener("click", () => this._close()));

    if (kind === "restore" && item) this._bindRestore(root.getElementById("restoreform"), item);
    if (kind === "pay" && item) this._bindPay(root.getElementById("payform"), item);
    if (kind === "add" || (kind === "edit" && item)) {
      this._bindBill(root.getElementById("billform"), kind === "edit" ? item : null);
    }
    if (kind === "category") this._bindCategory(root.getElementById("catform"), item);
  }

  // Run a service from a form; on failure keep the form (and what was typed)
  // and show the error inside it. `next` is the form to show afterwards.
  async _submit(form, service, data, onDone, next = null) {
    const btn = form.querySelector('button[type="submit"]');
    const errEl = form.querySelector("[data-formerr]");
    if (btn) btn.disabled = true;
    errEl.hidden = true;
    try {
      const r = await this._call(service, data);
      this._flash(onDone(r));
      this._close(false);
      this._form = next;
      await this._refresh();
    } catch (e) {
      if (btn) btn.disabled = false;
      this._formError(form, e.message || String(e));
    }
  }

  _formError(form, msg) {
    const errEl = form.querySelector("[data-formerr]");
    errEl.textContent = msg;
    errEl.hidden = false;
    errEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // Shared "are you sure?" box: `trigger` reveals #confirm, #keep hides it,
  // `go` runs the action.
  _bindConfirm(form, triggerId, goId, action) {
    const confirm = form.querySelector("#confirm");
    const trigger = form.querySelector("#" + triggerId);
    trigger.addEventListener("click", () => {
      confirm.hidden = false;
      trigger.disabled = true;
      confirm.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    form.querySelector("#keep").addEventListener("click", () => {
      confirm.hidden = true;
      trigger.disabled = false;
    });
    form.querySelector("#" + goId).addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try {
        await action();
      } catch (e) {
        ev.target.disabled = false;
        this._formError(form, e.message || String(e));
      }
    });
  }

  _bindRestore(form, b) {
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const due = form.elements.due_date.value;
      if (!due) return this._formError(form, "Pick a due date.");
      this._submit(form, "restore_bill", { bill: b.id, due_date: due }, (r) =>
        `Restored ${b.name}. Next due ${r.next_due}.`);
    });
  }

  _bindPay(form, b) {
    const f = form.elements;
    const estRow = form.querySelector("#estrow");
    const syncEst = () => {
      const v = f.amount.value;
      estRow.hidden = v === "" || parseFloat(v) === b.amount;
      if (estRow.hidden) f.update_amount.checked = false;
      // Recurring bills with an estimate settle the difference in the budget.
      const diffEl = form.querySelector("#budgetdiff");
      const diff = Math.round((parseFloat(v) - b.amount) * 100) / 100;
      const counts = this._budget && this._budget.configured && b.frequency !== "once"
        && b.in_budget !== false
        && b.amount !== null && b.amount !== undefined && v !== "" && diff;
      diffEl.hidden = !counts;
      if (counts) {
        diffEl.textContent = diff > 0
          ? `${this._money(diff)} over the estimate: it comes out of the budget on the day paid.`
          : `${this._money(-diff)} under the estimate: it goes back into the budget on the day paid.`;
      }
    };
    f.amount.addEventListener("input", syncEst);
    syncEst();

    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const data = { bill: b.id, paid_date: f.paid_date.value };
      if (f.amount.value !== "") data.amount = parseFloat(f.amount.value);
      if (f.confirmation.value.trim()) data.confirmation = f.confirmation.value.trim();
      if (f.note.value.trim()) data.note = f.note.value.trim();
      if (f.update_amount.checked && data.amount !== undefined) data.update_amount = true;
      this._submit(form, "mark_paid", data, (r) =>
        `Recorded ${b.name}.` +
        (r.next_due ? ` Next due ${r.next_due}.` : " No further due dates."));
    });
  }

  _bindBill(form, b) {
    const f = form.elements;
    const unit = form.querySelector("#unit");
    // One-time bills come out of the budget when paid, so the note is only for
    // repeating bills without an amount.
    const noAmount = form.querySelector("#noamount");
    const hint = form.querySelector("#budgethint");
    const syncNote = () => {
      const once = f.frequency.value === "once";
      noAmount.hidden = !f.in_budget.checked || f.amount.value !== "" || once;
      hint.textContent = !f.in_budget.checked
        ? "Payments are only tracked here in Bills; the budget ignores this bill."
        : once ? "Comes out of the budget on the day you pay it."
        : f.amount.value !== "" ? "Its amount is set aside from the budget a little each day." : "";
      hint.hidden = !hint.textContent;
    };
    f.amount.addEventListener("input", syncNote);
    f.frequency.addEventListener("change", syncNote);
    f.in_budget.addEventListener("change", syncNote);
    syncNote();
    const syncRepeat = () => {
      const freq = f.frequency.value;
      form.querySelectorAll("[data-repeat]").forEach((el) => { el.hidden = freq === "once"; });
      if (UNITS[freq]) {
        const n = parseInt(f.interval.value, 10);
        unit.textContent = UNITS[freq] + (n === 1 ? "" : "s");
      }
    };
    f.frequency.addEventListener("change", syncRepeat);
    f.interval.addEventListener("input", syncRepeat);
    syncRepeat();
    f.category.addEventListener("change", () => {
      form.querySelector("#caticon").innerHTML =
        this._billIcon({ category_id: f.category.value || null });
    });

    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const { data, error } = this._readBillForm(form);
      if (error) return this._formError(form, error);

      if (!b) {
        // Leave out empty optional fields when adding.
        const add = Object.fromEntries(
          Object.entries(data).filter(([, v]) => v !== null));
        return this._submit(form, "add_bill", add, (r) =>
          `Added ${data.name}. First due ${r.next_due}.`);
      }

      // Editing: send only what changed (null clears a field).
      const before = {
        name: b.name, category: b.category_id ?? null, amount: b.amount ?? null,
        due_date: b.next_due, frequency: b.frequency, interval: b.interval,
        end_date: b.end_date ?? null, remind_days_before: b.remind_days_before,
        autopay: b.autopay, biller_url: b.biller_url ?? null, notes: b.notes ?? null,
        in_budget: b.in_budget !== false,
      };
      const changes = {};
      for (const [key, val] of Object.entries(data)) {
        if (val !== before[key]) changes[key] = val;
      }
      if (!Object.keys(changes).length) {
        this._flash("No changes.");
        return this._close();
      }
      this._submit(form, "update_bill", { bill: b.id, ...changes }, (r) =>
        `Saved ${r.bill.name}. Next due ${r.bill.next_due}.`);
    });

    if (b) {
      this._bindConfirm(form, "retire", "doretire", async () => {
        await this._call("retire_bill", { bill: b.id });
        this._flash(`Retired ${b.name}. You can restore it from Retired at the bottom.`);
        this._close(false);
        await this._refresh();
      });
    }
  }

  _bindCategory(form, c) {
    const f = form.elements;
    const preview = form.querySelector("#iconpreview");
    const back = null;  // back to the Categories tab's list
    const sync = () => {
      const v = f.icon.value.trim();
      preview.innerHTML = this._icon(ICON_RE.test(v) ? v : DEFAULT_CATEGORY_ICON, "lead");
      form.querySelectorAll("[data-icon]").forEach((btn) =>
        btn.classList.toggle("sel", btn.dataset.icon === v));
    };
    f.icon.addEventListener("input", sync);
    form.querySelectorAll("[data-icon]").forEach((btn) =>
      btn.addEventListener("click", () => { f.icon.value = btn.dataset.icon; sync(); }));
    form.querySelector("#catback").addEventListener("click", () => this._close());

    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const name = f.name.value.trim();
      const icon = f.icon.value.trim().toLowerCase() || DEFAULT_CATEGORY_ICON;
      if (!name) return this._formError(form, "Give the category a name.");
      if (!ICON_RE.test(icon)) {
        return this._formError(form, "Icons look like mdi:home — a prefix, a colon, then the name.");
      }
      if (!c) {
        return this._submit(form, "add_category", { name, icon },
          () => `Added category ${name}.`, back);
      }
      const changes = {};
      if (name !== c.name) changes.name = name;
      if (icon !== c.icon) changes.icon = icon;
      if (!Object.keys(changes).length) return this._close();
      this._submit(form, "update_category", { category: c.id, ...changes },
        () => `Saved category ${name}.`, back);
    });

    if (c) {
      this._bindConfirm(form, "delcat", "dodelete", async () => {
        const r = await this._call("delete_category", { category: c.id });
        this._flash(`Deleted ${c.name}.` + (r.bills_uncategorized
          ? ` ${r.bills_uncategorized} bill${r.bills_uncategorized === 1 ? " is" : "s are"} now uncategorized.`
          : ""));
        this._form = back;
        await this._refresh();
      });
    }
  }
}

// An open tab can load a newer version of this file after HA restarts;
// the element can only be defined once, so a full page reload picks it up.
if (!customElements.get("bills-panel")) {
  customElements.define("bills-panel", BillsPanel);
}
