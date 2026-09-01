// Runs OCR on a receipt image and extracts likely yen amount candidates.
// Tesseract.js runs entirely in the browser (no photo is uploaded anywhere).

export async function recognizeReceipt(file, onProgress) {
  const { data } = await Tesseract.recognize(file, "jpn+eng", {
    logger: (m) => {
      if (onProgress && m.status && typeof m.progress === "number") {
        onProgress(m.status, m.progress);
      }
    },
  });
  return data.text || "";
}

// Pulls out numbers that look like yen amounts (合計 lines are weighted highest).
export function extractAmountCandidates(text) {
  const lines = text.split("\n");
  const found = [];

  const numberPattern = /([0-9][0-9,]{1,8})\s*円?/g;

  lines.forEach((line) => {
    let m;
    const isTotalLine = /(合計|お会計|総額|total|計)/i.test(line) && !/(小計|割引)/.test(line);
    while ((m = numberPattern.exec(line)) !== null) {
      const raw = m[1].replace(/,/g, "");
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0 || value > 1000000) continue;
      found.push({ value, weight: isTotalLine ? 3 : 1 });
    }
  });

  if (found.length === 0) return [];

  // Merge duplicate values, keep highest weight, sort by weight then value desc.
  const byValue = new Map();
  for (const f of found) {
    const existing = byValue.get(f.value);
    if (!existing || f.weight > existing.weight) byValue.set(f.value, f);
  }
  return Array.from(byValue.values())
    .sort((a, b) => b.weight - a.weight || b.value - a.value)
    .slice(0, 6)
    .map((f) => f.value);
}
