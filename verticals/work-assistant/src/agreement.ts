/**
 * Inter-rater agreement (valeriworkvertical.md §8) — the dataset-quality bar:
 * Cohen's kappa (2 raters) and Krippendorff's alpha (any raters, nominal,
 * missing values allowed). Pure functions, textbook-verifiable.
 */

/** Cohen's kappa between two complete paired rating lists. */
export function cohenKappa(a: string[], b: string[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  const labels = new Set([...a, ...b]);
  let po = 0;
  const marginalA = new Map<string, number>();
  const marginalB = new Map<string, number>();
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) po += 1;
    marginalA.set(a[i]!, (marginalA.get(a[i]!) ?? 0) + 1);
    marginalB.set(b[i]!, (marginalB.get(b[i]!) ?? 0) + 1);
  }
  po /= a.length;
  let pe = 0;
  for (const label of labels) {
    pe += ((marginalA.get(label) ?? 0) / a.length) * ((marginalB.get(label) ?? 0) / b.length);
  }
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

/**
 * Krippendorff's alpha, nominal metric, any number of raters per unit,
 * `null` = missing rating (unit skipped if fewer than 2 ratings).
 * alpha = 1 - Do/De over the coincidence matrix.
 */
export function krippendorffAlpha(units: (string | null)[][]): number {
  const coincidence = new Map<string, Map<string, number>>();
  let pairable = 0; // Σ m_u over pairable units (units with ≥ 2 ratings)

  for (const unit of units) {
    const ratings = unit.filter((r): r is string => r !== null && r !== undefined);
    if (ratings.length < 2) continue;
    const weight = 1 / (ratings.length - 1);
    for (let i = 0; i < ratings.length; i++) {
      for (let j = 0; j < ratings.length; j++) {
        if (i === j) continue;
        pairable += weight;
        const row = coincidence.get(ratings[i]!) ?? new Map<string, number>();
        row.set(ratings[j]!, (row.get(ratings[j]!) ?? 0) + weight);
        coincidence.set(ratings[i]!, row);
      }
    }
  }

  if (pairable === 0) return 1; // nothing pairable — vacuously perfect

  let doSum = 0;
  for (const [c, row] of coincidence) {
    for (const [c2, weight] of row) {
      if (c !== c2) doSum += weight;
    }
  }
  const doDisagreement = doSum / pairable;

  // De counts only pairable values (units with ≥ 2 ratings).
  const nByLabel = new Map<string, number>();
  for (const unit of units) {
    const ratings = unit.filter((r): r is string => r !== null && r !== undefined);
    if (ratings.length < 2) continue;
    for (const r of ratings) {
      nByLabel.set(r, (nByLabel.get(r) ?? 0) + 1);
    }
  }
  const n = [...nByLabel.values()].reduce((a, v) => a + v, 0);
  if (n <= 1) return 1;
  let deDisagreement = 0;
  for (const count of nByLabel.values()) {
    deDisagreement += count * (count - 1);
  }
  const de = deDisagreement / (n * (n - 1));
  if (de === 0) return 1;
  return 1 - doDisagreement / de;
}
