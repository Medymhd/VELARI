import { test } from "node:test";
import assert from "node:assert/strict";
import { cohenKappa, krippendorffAlpha } from "./agreement.js";

test("cohenKappa: perfect agreement = 1, complete inversion = -1", () => {
  const a = ["A", "B", "A", "B", "A", "B", "A", "B", "A", "B"];
  assert.equal(cohenKappa(a, [...a]), 1);
  const r1 = ["A", "B", "A", "B", "A", "B", "A", "B", "A", "B"];
  const r2 = ["B", "A", "B", "A", "B", "A", "B", "A", "B", "A"];
  assert.equal(cohenKappa(r1, r2), -1, "complete inversion = -1");
});

test("cohenKappa: the canonical po=0.75 example ≈ 0.75", () => {
  // 100 items: both-A 45, both-B 30, r1-only A 15, r2-only A 10.
  // po = 0.75; marginals r1 75A/25B, r2 60A/40B → pe = 0.51 → κ ≈ 0.4898…
  const pairs: [string, string][] = [
    ...Array(45).fill(["A", "A"]),
    ...Array(30).fill(["B", "B"]),
    ...Array(15).fill(["A", "B"]),
    ...Array(10).fill(["B", "A"]),
  ];
  const kappa = cohenKappa(pairs.map((p) => p[0]!), pairs.map((p) => p[1]!));
  // κ = (0.75 − 0.51)/(1 − 0.51) = 0.4898
  assert.ok(Math.abs(kappa - 0.4898) < 0.01, `kappa ≈ 0.49, got ${kappa}`);
});

test("krippendorffAlpha: perfect agreement = 1", () => {
  // 4 units × 2 raters, every unit agrees.
  const units = [["A", "A"], ["B", "B"], ["A", "A"], ["B", "B"]];
  assert.equal(krippendorffAlpha(units), 1);
});

test("krippendorffAlpha: known nominal case ≈ 0.6416", () => {
  // 10 units × 2 raters: 6 both-A, 2 both-B, 2 disagree (A/B).
  // Do = 4/20 = 0.2; De = (14·13 + 6·5)/(20·19) ≈ 0.5579 → alpha ≈ 0.6416.
  const units = [
    ["A", "A"], ["A", "A"], ["A", "A"], ["A", "A"], ["A", "A"], ["A", "A"],
    ["B", "B"], ["B", "B"],
    ["A", "B"], ["B", "A"],
  ];
  const alpha = krippendorffAlpha(units);
  assert.ok(Math.abs(alpha - 0.6416) < 0.001, `alpha ≈ 0.6416, got ${alpha}`);
});

test("krippendorffAlpha: missing ratings skipped", () => {
  const units = [["A", "A"], ["A", null], ["B", null], ["A", "A"]];
  assert.equal(krippendorffAlpha(units), 1, "pairable units all agree");
});

test("krippendorffAlpha: 3 raters with one dissenter → exactly 0.5", () => {
  // Do = 2/9; De = (5·4 + 4·3)/(9·8) = 32/72 = 0.4444 → alpha = 0.5.
  const units = [["A", "A", "A"], ["A", "A", "B"], ["B", "B", "B"]];
  const alpha = krippendorffAlpha(units);
  assert.ok(Math.abs(alpha - 0.5) < 0.001, `alpha = 0.5, got ${alpha}`);
});
