// Keyword -> category rules used to auto-categorize imported/typed transactions
// by payee name. Users can add/remove their own rules in the Settings tab.

export const DEFAULT_RULES = [
  { keyword: "スイカ", category: "交通費" },
  { keyword: "Suica", category: "交通費" },
  { keyword: "SUICA", category: "交通費" },
  { keyword: "Amazon", category: "その他" },
  { keyword: "アマゾン", category: "その他" },
  { keyword: "Netflix", category: "サブスク" },
  { keyword: "Spotify", category: "サブスク" },
  { keyword: "iCloud", category: "サブスク" },
  { keyword: "Apple", category: "サブスク" },
  { keyword: "アップル", category: "サブスク" },
  { keyword: "フィツトプレイ", category: "サブスク" },
  { keyword: "カイガイデビ", category: "サブスク" },
  { keyword: "アツプルドツ", category: "サブスク" },
];

// Returns the category of the first matching rule (case-insensitive substring
// match against the transaction name), or null if nothing matches.
export function matchCategory(name, rules) {
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const rule of rules) {
    if (rule.keyword && lower.includes(rule.keyword.toLowerCase())) {
      return rule.category;
    }
  }
  return null;
}
