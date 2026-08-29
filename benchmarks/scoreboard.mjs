/**
 * Aggregates benchmarks/results/*.json into a markdown scoreboard.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

function load(name) {
  const p = new URL(`./results/${name}`, import.meta.url);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

const stt = load("stt.json");
const coach = load("coach.json");
const vision = load("vision.json");

const lines = ["# Benchmark scoreboard", "", `Generated: ${new Date().toISOString()}`, ""];

lines.push("## STT");
lines.push("");
lines.push("| Provider | First partial | First final | Total | Text len |");
lines.push("|---|---:|---:|---:|---:|");
if (stt?.providers) {
  for (const [id, r] of Object.entries(stt.providers)) {
    if (r.error) {
      lines.push(`| ${id} | error | — | — | — |`);
      continue;
    }
    lines.push(
      `| ${id} | ${r.firstPartialMs ?? "—"} ms | ${r.firstFinalMs ?? "—"} ms | ${r.totalMs ? `${r.totalMs} ms` : "—"} | ${r.textLen ?? "—"} |`,
    );
  }
}

lines.push("");
lines.push("## Coach");
lines.push("");
lines.push("| Endpoint | Model | TTFT (avg) | Total (avg) | JSON validity |");
lines.push("|---|---|---:|---:|---:|");
if (coach?.endpoints) {
  for (const [id, r] of Object.entries(coach.endpoints)) {
    lines.push(`| ${id} | ${r.model} | ${r.firstTokenMs ?? "—"} ms | ${r.totalMs ?? "—"} ms | ${(r.jsonValidity * 100).toFixed(0)}% |`);
  }
}

lines.push("");
lines.push("## Vision");
lines.push("");
lines.push("| Endpoint | Model | Total (avg) |");
lines.push("|---|---|---:|");
if (vision?.endpoints) {
  for (const [id, r] of Object.entries(vision.endpoints)) {
    lines.push(`| ${id} | ${r.model} | ${r.totalMs ?? "—"} ms |`);
  }
}

const out = lines.join("\n") + "\n";
writeFileSync(new URL("./results/SCOREBOARD.md", import.meta.url), out);
console.log(out);
