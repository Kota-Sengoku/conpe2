// Parses a transaction-history CSV export (PayPay's "利用明細", a bank's
// web statement export such as 三菱UFJ銀行, etc). None of these offer a
// personal automated-fetch API, so CSV export + auto-parsing is the most
// reliable way to bulk-import transaction history without manual re-typing.

export function parseCsv(text) {
  // Strip BOM, normalize newlines.
  const clean = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = clean.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line) => {
    const cells = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQuotes = false;
        } else cur += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        cells.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  };

  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

function findColumn(headers, keywords) {
  const idx = headers.findIndex((h) => keywords.some((k) => h.includes(k)));
  return idx;
}

export function guessColumns(headers) {
  return {
    date: findColumn(headers, ["利用日", "取引日", "日付", "日時", "ご利用日", "取引年月日"]),
    expense: findColumn(headers, ["出金", "支出", "利用金額", "ご利用金額", "お支払い金額", "お支払金額"]),
    income: findColumn(headers, ["入金", "受取", "お預かり金額", "お預り金額"]),
    name: findColumn(headers, ["取引内容", "取引先", "内容", "店", "摘要", "ご利用店名"]),
  };
}

export function toAmount(str) {
  if (!str) return 0;
  const n = Number(String(str).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function toIsoDate(str) {
  if (!str) return null;
  const m = String(str).match(/(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// `categorizeFn(name)` should return a category string or null/undefined
// when no rule matches; `defaultCategory` is used as the fallback.
export function rowsToTransactions(headers, rows, mapping, categorizeFn, defaultCategory = "その他") {
  const out = [];
  for (const r of rows) {
    const dateRaw = mapping.date >= 0 ? r[mapping.date] : "";
    const date = toIsoDate(dateRaw);
    if (!date) continue;
    const expenseAmt = mapping.expense >= 0 ? toAmount(r[mapping.expense]) : 0;
    const incomeAmt = mapping.income >= 0 ? toAmount(r[mapping.income]) : 0;
    const name = (mapping.name >= 0 ? r[mapping.name] : "") || "取込データ";
    const category = (categorizeFn && categorizeFn(name)) || defaultCategory;
    if (expenseAmt > 0) {
      out.push({ date, amount: expenseAmt, type: "expense", name, category });
    } else if (incomeAmt > 0) {
      out.push({ date, amount: incomeAmt, type: "income", name, category: "その他" });
    }
  }
  return out;
}
