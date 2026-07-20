export function docketNumberForItem(item = {}) {
  const value = String(
    item.elitical?.num ||
      item.num ||
      item.docketNum ||
      item.docketNumber ||
      ""
  ).trim();

  return /^[A-Z]+-\d+$/i.test(value) ? value.toUpperCase() : "";
}

export function normalizeDocketNumber(value) {
  return String(value || "").trim().toUpperCase();
}

export function isExactDocketNumberQuery(value) {
  return /^[A-Z]+-\d+$/i.test(String(value || "").trim());
}
