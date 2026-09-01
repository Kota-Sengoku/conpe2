import { store, newId } from "./db.js";
import { parseCsv, guessColumns, rowsToTransactions, toAmount } from "./paypay-csv.js";
import { recognizeReceipt, extractAmountCandidates } from "./ocr.js";

const EXPENSE_CATEGORIES = ["食費", "日用品", "交通費", "娯楽", "サブスク", "医療", "交際費", "PayPay", "その他"];
const INCOME_CATEGORIES = ["給料", "お小遣い", "その他"];

const state = {
  today: new Date(),
  viewYear: null,
  viewMonth: null, // 0-indexed
  transactions: [],
  subscriptions: [],
};
state.viewYear = state.today.getFullYear();
state.viewMonth = state.today.getMonth();

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function yen(n) {
  return `${Math.round(n).toLocaleString("ja-JP")}円`;
}

const LS_LAST_IMPORT = "paypayLastImportDate";
const LS_DISMISSED = "paypayReminderDismissedDate";

function pad2(n) { return String(n).padStart(2, "0"); }
function isoDate(y, m, d) { return `${y}-${pad2(m + 1)}-${pad2(d)}`; }
function todayIso() {
  const t = state.today;
  return isoDate(t.getFullYear(), t.getMonth(), t.getDate());
}

/* ---------------- Data loading ---------------- */

async function loadAll() {
  state.transactions = await store.getAll("transactions");
  state.subscriptions = await store.getAll("subscriptions");
}

async function ensureRecurringForMonth(year, month) {
  if (state.subscriptions.length === 0) return;
  const existingKeys = new Set(
    state.transactions
      .filter((t) => t.subscriptionId)
      .map((t) => `${t.subscriptionId}:${t.date.slice(0, 7)}`)
  );
  const lastDay = new Date(year, month + 1, 0).getDate();
  const toAdd = [];
  for (const sub of state.subscriptions) {
    const key = `${sub.id}:${year}-${pad2(month + 1)}`;
    if (existingKeys.has(key)) continue;
    const day = Math.min(sub.day, lastDay);
    toAdd.push({
      id: newId(),
      date: isoDate(year, month, day),
      amount: sub.amount,
      type: "expense",
      name: `サブスク（${sub.name}）`,
      category: "サブスク",
      recurring: true,
      subscriptionId: sub.id,
    });
  }
  if (toAdd.length > 0) {
    await store.bulkPut("transactions", toAdd);
    state.transactions.push(...toAdd);
  }
}

/* ---------------- Tab switching ---------------- */

function switchView(viewId) {
  $$(".view").forEach((v) => v.classList.toggle("hidden", v.id !== viewId));
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === viewId));
  const isCalendar = viewId === "viewCalendar";
  $("#prevMonthBtn").classList.toggle("hidden", !isCalendar);
  $("#nextMonthBtn").classList.toggle("hidden", !isCalendar);
  $("#searchBtn").classList.toggle("hidden", !isCalendar);
  $("#monthLabel").textContent = isCalendar
    ? `${state.viewYear}年${pad2(state.viewMonth + 1)}月`
    : { viewInput: "入力", viewGraph: "グラフ", viewSettings: "設定" }[viewId];
  if (viewId === "viewGraph") renderGraph();
  if (viewId === "viewSettings") renderSubscriptionList();
}

$$(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

/* ---------------- Calendar rendering ---------------- */

function monthTransactions(year, month) {
  const prefix = `${year}-${pad2(month + 1)}`;
  return state.transactions.filter((t) => t.date.startsWith(prefix));
}

function dayTotals(year, month) {
  const totals = {};
  for (const t of monthTransactions(year, month)) {
    const day = Number(t.date.slice(8, 10));
    if (!totals[day]) totals[day] = { income: 0, expense: 0 };
    totals[day][t.type] += t.amount;
  }
  return totals;
}

async function renderCalendar() {
  await ensureRecurringForMonth(state.viewYear, state.viewMonth);

  const grid = $("#calendarGrid");
  grid.innerHTML = "";
  const year = state.viewYear;
  const month = state.viewMonth;
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  const totals = dayTotals(year, month);
  const todayStr = todayIso();

  const cells = [];
  for (let i = 0; i < firstDow; i++) {
    cells.push({ day: daysInPrevMonth - firstDow + 1 + i, other: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, other: false });
  }
  while (cells.length % 7 !== 0) {
    cells.push({ day: cells.length - firstDow - daysInMonth + 1, other: true, trailing: true });
  }

  cells.forEach((c, idx) => {
    const dow = idx % 7;
    const div = document.createElement("div");
    div.className = "day-cell";
    if (c.other) div.classList.add("other-month");
    if (dow === 0) div.classList.add("sunday");
    if (dow === 6) div.classList.add("saturday");

    const dateStr = c.other ? null : isoDate(year, month, c.day);
    if (dateStr === todayStr) div.classList.add("today");

    const num = document.createElement("span");
    num.className = "day-num";
    num.textContent = c.day;
    div.appendChild(num);

    if (!c.other && totals[c.day]) {
      const t = totals[c.day];
      if (t.expense > 0) {
        const amt = document.createElement("span");
        amt.className = "day-amount";
        amt.textContent = yen(t.expense);
        div.appendChild(amt);
      } else if (t.income > 0) {
        const amt = document.createElement("span");
        amt.className = "day-amount income";
        amt.textContent = yen(t.income);
        div.appendChild(amt);
      }
    }

    if (!c.other) {
      div.addEventListener("click", () => openDayModal(dateStr));
    }
    grid.appendChild(div);
  });

  renderSummary(year, month);
  renderTxList(year, month);
  checkPaypayReminder();
}

/* ---------------- PayPay import reminder ---------------- */

function checkPaypayReminder() {
  const today = todayIso();
  const lastImport = localStorage.getItem(LS_LAST_IMPORT);
  const dismissed = localStorage.getItem(LS_DISMISSED);
  const shouldShow = lastImport !== today && dismissed !== today;
  $("#paypayReminder").classList.toggle("hidden", !shouldShow);
}

function markPaypayImported() {
  localStorage.setItem(LS_LAST_IMPORT, todayIso());
  checkPaypayReminder();
}

$("#reminderDismissBtn").addEventListener("click", () => {
  localStorage.setItem(LS_DISMISSED, todayIso());
  checkPaypayReminder();
});

$("#reminderImportBtn").addEventListener("click", () => {
  switchView("viewInput");
  $("#csvPanel").scrollIntoView({ behavior: "smooth", block: "start" });
});

function renderSummary(year, month) {
  const txs = monthTransactions(year, month);
  const income = txs.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const expense = txs.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  $("#sumIncome").textContent = yen(income);
  $("#sumExpense").textContent = yen(expense);
  $("#sumTotal").textContent = `${income - expense < 0 ? "-" : ""}${yen(Math.abs(income - expense)).replace("円", "")}円`;
}

function weekdayLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const wd = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  return `${pad2(d.getMonth() + 1)}月${pad2(d.getDate())}日(${wd})`;
}

function txRowEl(t) {
  const row = document.createElement("div");
  row.className = "tx-row";
  const left = document.createElement("div");
  left.innerHTML = `<div class="tx-name">${escapeHtml(t.name || t.category)}</div><div class="tx-cat">${escapeHtml(t.category)}</div>`;
  const right = document.createElement("div");
  right.className = `tx-amount ${t.type === "income" ? "income" : ""}`;
  right.innerHTML = `${t.recurring ? '<span class="tx-recur-icon">&#8635;</span>' : ""}${t.type === "income" ? "+" : ""}${yen(t.amount)}`;
  row.appendChild(left);
  row.appendChild(right);
  row.addEventListener("click", () => {
    if (confirm(`「${t.name || t.category}」${yen(t.amount)} を削除しますか？`)) {
      deleteTransaction(t.id);
    }
  });
  return row;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderTxList(year, month) {
  const list = $("#txList");
  list.innerHTML = "";
  const txs = monthTransactions(year, month).sort((a, b) => b.date.localeCompare(a.date));
  if (txs.length === 0) {
    list.innerHTML = '<div class="tx-empty">この月の記録はまだありません</div>';
    return;
  }
  let lastDate = null;
  for (const t of txs) {
    if (t.date !== lastDate) {
      const header = document.createElement("div");
      header.className = "tx-date-header";
      header.textContent = weekdayLabel(t.date);
      list.appendChild(header);
      lastDate = t.date;
    }
    list.appendChild(txRowEl(t));
  }
}

function openDayModal(dateStr) {
  const txs = state.transactions.filter((t) => t.date === dateStr);
  $("#dayModalTitle").textContent = weekdayLabel(dateStr);
  const listEl = $("#dayModalList");
  listEl.innerHTML = "";
  if (txs.length === 0) {
    listEl.innerHTML = '<div class="tx-empty">この日の記録はありません</div>';
  } else {
    txs.forEach((t) => listEl.appendChild(txRowEl(t)));
  }
  $("#dayModal").classList.remove("hidden");
}
$("#dayModalClose").addEventListener("click", () => $("#dayModal").classList.add("hidden"));
$("#dayModal").addEventListener("click", (e) => {
  if (e.target.id === "dayModal") $("#dayModal").classList.add("hidden");
});

$("#prevMonthBtn").addEventListener("click", () => {
  state.viewMonth--;
  if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear--; }
  switchView("viewCalendar");
  renderCalendar();
});
$("#nextMonthBtn").addEventListener("click", () => {
  state.viewMonth++;
  if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear++; }
  switchView("viewCalendar");
  renderCalendar();
});

async function deleteTransaction(id) {
  await store.delete("transactions", id);
  state.transactions = state.transactions.filter((t) => t.id !== id);
  $("#dayModal").classList.add("hidden");
  renderCalendar();
}

/* ---------------- Manual input ---------------- */

function fillCategorySelect(sel, list) {
  sel.innerHTML = list.map((c) => `<option value="${c}">${c}</option>`).join("");
}

let manualType = "expense";
$("#typeSeg").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  manualType = btn.dataset.type;
  $$("#typeSeg .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
  fillCategorySelect($("#fCategory"), manualType === "expense" ? EXPENSE_CATEGORIES : INCOME_CATEGORIES);
});
fillCategorySelect($("#fCategory"), EXPENSE_CATEGORIES);
$("#fDate").value = todayIso();

$("#manualForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const amount = toAmount($("#fAmount").value);
  if (amount <= 0) return;
  const t = {
    id: newId(),
    date: $("#fDate").value || todayIso(),
    amount,
    type: manualType,
    name: $("#fName").value.trim(),
    category: $("#fCategory").value,
    memo: $("#fMemo").value.trim(),
    recurring: false,
  };
  await store.put("transactions", t);
  state.transactions.push(t);

  if ($("#fRecurring").checked && manualType === "expense") {
    const sub = {
      id: newId(),
      name: t.name || t.category,
      amount,
      day: Number(t.date.slice(8, 10)),
    };
    await store.put("subscriptions", sub);
    state.subscriptions.push(sub);
    t.recurring = true;
    t.subscriptionId = sub.id;
    await store.put("transactions", t);
  }

  e.target.reset();
  $("#fDate").value = todayIso();
  fillCategorySelect($("#fCategory"), manualType === "expense" ? EXPENSE_CATEGORIES : INCOME_CATEGORIES);
  alert("追加しました");
  state.viewYear = Number(t.date.slice(0, 4));
  state.viewMonth = Number(t.date.slice(5, 7)) - 1;
  renderCalendar();
});

/* ---------------- Receipt OCR ---------------- */

fillCategorySelect($("#rCategory"), EXPENSE_CATEGORIES);
$("#rDate").value = todayIso();

$("#receiptInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const preview = $("#ocrPreview");
  preview.src = URL.createObjectURL(file);
  preview.classList.remove("hidden");
  $("#ocrCandidates").classList.add("hidden");
  const statusEl = $("#ocrStatus");
  statusEl.textContent = "画像を読み取り中…";

  try {
    const text = await recognizeReceipt(file, (status, progress) => {
      statusEl.textContent = `${status}（${Math.round(progress * 100)}%）`;
    });
    const candidates = extractAmountCandidates(text);
    statusEl.textContent = candidates.length
      ? "金額の候補が見つかりました。正しいものを選んでください。"
      : "金額を自動で読み取れませんでした。手入力してください。";

    const chipRow = $("#ocrAmountChips");
    chipRow.innerHTML = "";
    candidates.forEach((v, i) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip" + (i === 0 ? " selected" : "");
      chip.textContent = yen(v);
      chip.addEventListener("click", () => {
        $$(".chip", chipRow).forEach((c) => c.classList.remove("selected"));
        chip.classList.add("selected");
        $("#rAmount").value = v;
      });
      chipRow.appendChild(chip);
    });
    if (candidates.length) $("#rAmount").value = candidates[0];
    $("#ocrCandidates").classList.remove("hidden");
  } catch (err) {
    console.error(err);
    statusEl.textContent = "読み取りに失敗しました。手入力してください。";
    $("#ocrCandidates").classList.remove("hidden");
  }
});

$("#saveReceiptBtn").addEventListener("click", async () => {
  const amount = toAmount($("#rAmount").value);
  if (amount <= 0) { alert("金額を入力してください"); return; }
  const t = {
    id: newId(),
    date: $("#rDate").value || todayIso(),
    amount,
    type: "expense",
    name: $("#rName").value.trim() || "レシート",
    category: $("#rCategory").value,
    recurring: false,
    source: "receipt",
  };
  await store.put("transactions", t);
  state.transactions.push(t);
  $("#ocrCandidates").classList.add("hidden");
  $("#ocrPreview").classList.add("hidden");
  $("#ocrStatus").textContent = "";
  $("#receiptInput").value = "";
  alert("追加しました");
  state.viewYear = Number(t.date.slice(0, 4));
  state.viewMonth = Number(t.date.slice(5, 7)) - 1;
  renderCalendar();
});

/* ---------------- PayPay CSV import ---------------- */

let csvParsed = null;

$("#csvInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const { headers, rows } = parseCsv(text);
  if (headers.length === 0 || rows.length === 0) {
    $("#csvStatus").textContent = "CSVを読み込めませんでした。";
    return;
  }
  csvParsed = { headers, rows };
  const guess = guessColumns(headers);
  $("#csvStatus").textContent = `${rows.length}件の行を検出しました。列の対応を確認してください。`;

  ["mapDate", "mapExpense", "mapIncome", "mapName"].forEach((id, i) => {
    const key = ["date", "expense", "income", "name"][i];
    const sel = $(`#${id}`);
    sel.innerHTML = '<option value="-1">（使用しない）</option>' +
      headers.map((h, idx) => `<option value="${idx}">${escapeHtml(h)}</option>`).join("");
    sel.value = String(guess[key] ?? -1);
    sel.onchange = updateCsvPreview;
  });

  $("#csvMapWrap").classList.remove("hidden");
  updateCsvPreview();
});

function currentMapping() {
  return {
    date: Number($("#mapDate").value),
    expense: Number($("#mapExpense").value),
    income: Number($("#mapIncome").value),
    name: Number($("#mapName").value),
  };
}

function updateCsvPreview() {
  if (!csvParsed) return;
  const mapping = currentMapping();
  const parsedTx = rowsToTransactions(csvParsed.headers, csvParsed.rows, mapping);
  $("#csvCount").textContent = parsedTx.length;

  const previewRows = parsedTx.slice(0, 8);
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>日付</th><th>種別</th><th>金額</th><th>内容</th></tr></thead>` +
    `<tbody>${previewRows.map((r) => `<tr><td>${r.date}</td><td>${r.type === "expense" ? "支出" : "収入"}</td><td>${yen(r.amount)}</td><td>${escapeHtml(r.name)}</td></tr>`).join("")}</tbody>`;
  const wrap = $("#csvPreview");
  wrap.innerHTML = "";
  wrap.appendChild(table);
}

$("#importCsvBtn").addEventListener("click", async () => {
  if (!csvParsed) return;
  const mapping = currentMapping();
  const parsedTx = rowsToTransactions(csvParsed.headers, csvParsed.rows, mapping);
  if (parsedTx.length === 0) { alert("取り込める行がありません"); return; }
  const records = parsedTx.map((r) => ({
    id: newId(),
    date: r.date,
    amount: r.amount,
    type: r.type,
    name: r.name,
    category: r.category,
    recurring: false,
    source: "paypay",
  }));
  await store.bulkPut("transactions", records);
  state.transactions.push(...records);
  markPaypayImported();
  alert(`${records.length}件を取り込みました`);
  $("#csvMapWrap").classList.add("hidden");
  $("#csvInput").value = "";
  $("#csvStatus").textContent = "";
  csvParsed = null;
  const latest = records[records.length - 1];
  state.viewYear = Number(latest.date.slice(0, 4));
  state.viewMonth = Number(latest.date.slice(5, 7)) - 1;
  renderCalendar();
});

/* ---------------- Subscriptions (settings) ---------------- */

function renderSubscriptionList() {
  const list = $("#subList");
  list.innerHTML = "";
  if (state.subscriptions.length === 0) {
    list.innerHTML = '<div class="hint">登録されているサブスクはありません</div>';
    return;
  }
  state.subscriptions.forEach((s) => {
    const row = document.createElement("div");
    row.className = "sub-row";
    row.innerHTML = `<div><div>${escapeHtml(s.name)}</div><div class="sub-meta">毎月${s.day}日・${yen(s.amount)}</div></div>`;
    const delBtn = document.createElement("button");
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`「${s.name}」を削除しますか？（過去に追加済みの記録は残ります）`)) return;
      await store.delete("subscriptions", s.id);
      state.subscriptions = state.subscriptions.filter((x) => x.id !== s.id);
      renderSubscriptionList();
    });
    row.appendChild(delBtn);
    list.appendChild(row);
  });
}

$("#subForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sub = {
    id: newId(),
    name: $("#sName").value.trim(),
    amount: toAmount($("#sAmount").value),
    day: Number($("#sDay").value) || 1,
  };
  if (!sub.name || sub.amount <= 0) return;
  await store.put("subscriptions", sub);
  state.subscriptions.push(sub);
  e.target.reset();
  $("#sDay").value = 1;
  renderSubscriptionList();
  renderCalendar();
});

/* ---------------- Data management ---------------- */

$("#exportBtn").addEventListener("click", () => {
  const payload = JSON.stringify({ transactions: state.transactions, subscriptions: state.subscriptions }, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `kakeibo-backup-${todayIso()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

$("#importBtn").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (Array.isArray(data.transactions)) {
      await store.bulkPut("transactions", data.transactions);
    }
    if (Array.isArray(data.subscriptions)) {
      await store.bulkPut("subscriptions", data.subscriptions);
    }
    await loadAll();
    alert("読み込みました");
    renderCalendar();
  } catch (err) {
    alert("読み込みに失敗しました。ファイルを確認してください。");
  }
  e.target.value = "";
});

$("#clearBtn").addEventListener("click", async () => {
  if (!confirm("すべてのデータを削除します。元に戻せません。よろしいですか？")) return;
  await store.clear("transactions");
  await store.clear("subscriptions");
  state.transactions = [];
  state.subscriptions = [];
  renderCalendar();
  renderSubscriptionList();
});

/* ---------------- Graphs ---------------- */

let categoryChart = null;
let trendChart = null;

const CHART_COLORS = ["#4CC38A", "#3B6FE0", "#E0A83D", "#E0453D", "#8E5BE0", "#3DC3D8", "#C38A4C", "#7A7A7A", "#D84C97"];

function renderGraph() {
  const year = state.viewYear;
  const month = state.viewMonth;
  $("#graphMonthLabel").textContent = `${year}年${pad2(month + 1)}月のカテゴリ別支出`;

  const txs = monthTransactions(year, month).filter((t) => t.type === "expense");
  const byCat = {};
  for (const t of txs) byCat[t.category] = (byCat[t.category] || 0) + t.amount;
  const labels = Object.keys(byCat);
  const values = Object.values(byCat);

  if (categoryChart) categoryChart.destroy();
  const ctx = $("#categoryChart").getContext("2d");
  if (labels.length === 0) {
    $("#categoryLegend").innerHTML = '<div class="hint">この月の支出データはありません</div>';
  } else {
    categoryChart = new Chart(ctx, {
      type: "doughnut",
      data: { labels, datasets: [{ data: values, backgroundColor: labels.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]) }] },
      options: { plugins: { legend: { display: false } } },
    });
    $("#categoryLegend").innerHTML = labels.map((l, i) =>
      `<div class="legend-item"><span class="legend-dot" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></span>${escapeHtml(l)} ${yen(byCat[l])}</div>`
    ).join("");
  }

  // Trend: last 6 months including current view month.
  const trendLabels = [];
  const trendValues = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(year, month - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth();
    trendLabels.push(`${m + 1}月`);
    const sum = monthTransactions(y, m).filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
    trendValues.push(sum);
  }
  if (trendChart) trendChart.destroy();
  const ctx2 = $("#trendChart").getContext("2d");
  trendChart = new Chart(ctx2, {
    type: "bar",
    data: { labels: trendLabels, datasets: [{ label: "支出", data: trendValues, backgroundColor: "#4CC38A" }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
  });
}

/* ---------------- Search ---------------- */

$("#searchBtn").addEventListener("click", () => {
  const keyword = prompt("検索したいお店・内容を入力してください");
  if (!keyword || !keyword.trim()) return;
  const kw = keyword.trim();
  const matches = state.transactions
    .filter((t) => (t.name || "").includes(kw) || (t.category || "").includes(kw))
    .sort((a, b) => b.date.localeCompare(a.date));

  $("#dayModalTitle").textContent = `「${kw}」の検索結果（${matches.length}件）`;
  const listEl = $("#dayModalList");
  listEl.innerHTML = "";
  if (matches.length === 0) {
    listEl.innerHTML = '<div class="tx-empty">見つかりませんでした</div>';
  } else {
    let lastDate = null;
    for (const t of matches) {
      if (t.date !== lastDate) {
        const header = document.createElement("div");
        header.className = "tx-date-header";
        header.textContent = weekdayLabel(t.date);
        listEl.appendChild(header);
        lastDate = t.date;
      }
      listEl.appendChild(txRowEl(t));
    }
  }
  $("#dayModal").classList.remove("hidden");
});

/* ---------------- Init ---------------- */

async function init() {
  await loadAll();
  switchView("viewCalendar");
  await renderCalendar();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
