import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeSession, countFillers, starScore, metricVerdicts, type AnalyzedSegment } from "./analytics.js";

test("countFillers catches filler words per segment", () => {
  assert.equal(countFillers("Um, so basically I led the migration."), 2);
  assert.equal(countFillers("I led the migration."), 0);
});

test("starScore: situation + action + result = 3", () => {
  const strong = "When we had a quality crisis, I built a rubric system that reduced bad outputs by 15%.";
  assert.equal(starScore(strong), 3);
  const vague = "I think evaluation is important.";
  assert.ok(starScore(vague) < 3);
});

test("analyzeSession: computes fillers, verbosity, star share over user finals", () => {
  const segs: AnalyzedSegment[] = [
    { text: "Interviewer: Tell me about a migration.", speaker: "interviewer" },
    { text: "Um, when we had a broken pipeline, I led the migration and we reduced errors by 20%.", speaker: "user", startedAtMs: 0, endedAtMs: 30_000 },
    { text: "Basically I used a rubric, it flagged stuff.", speaker: "user", startedAtMs: 31_000, endedAtMs: 45_000 },
  ];
  const m = analyzeSession(segs);
  assert.equal(m.segmentCount, 2);
  assert.ok(m.fillerRate > 0, "filler rate should register the um/basically");
  assert.equal(m.starShare, 0.5, "1 of 2 answers has full STAR shape");
  assert.ok(m.wpm !== null && m.wpm > 0);
  const v = metricVerdicts(m);
  assert.ok(["good", "ok", "warn"].includes(v.filler));
});

test("analyzeSession: empty input is safe", () => {
  const m = analyzeSession([]);
  assert.equal(m.wordCount, 0);
  assert.equal(m.wpm, null);
  assert.equal(m.starShare, 0);
});

test("WPM uses only timed segments and stays in a sane range", () => {
  const segs: AnalyzedSegment[] = [
    { text: Array(50).fill("word").join(" "), speaker: "user", startedAtMs: 0, endedAtMs: 20_000 }, // 50 words / 20s = 150 wpm
  ];
  const m = analyzeSession(segs);
  assert.equal(m.wpm, 150);
});

test("metricVerdicts: trend payload contract (verdicts ride alongside metrics)", () => {
  // Shape the /arena/analytics and /arena/followup routes serialize.
  const m = analyzeSession([
    { text: Array(50).fill("word").join(" "), speaker: "user", startedAtMs: 0, endedAtMs: 20_000 },
  ]);
  const v = metricVerdicts(m);
  assert.equal(v.pace, "good"); // 150 wpm inside 110-165 band
  assert.equal(v.filler, "good"); // zero fillers
  assert.equal(v.star, "warn"); // single non-STAR answer
});
