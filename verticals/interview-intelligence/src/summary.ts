import type { ChatMessage } from "@app/contracts";

export function buildSummaryMessages(transcript: string, insights: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a post-session summarizer. Produce JSON {summary:string, highlights:string[], followups:string[], questionBank:string[]}.",
        "summary: 3-5 sentences. highlights: strongest moments. followups: unanswered or weak. questionBank: 5 likely follow-ups.",
      ].join("\n"),
    },
    { role: "user", content: `Transcript:\n${transcript.slice(0, 12000)}\n\nInsights:\n${insights.slice(0, 4000)}` },
  ];
}

export function offlineSummary(transcript: string): Record<string, unknown> {
  const lines = transcript.split("\n").filter(Boolean).slice(0, 3).join(" ");
  return {
    summary: lines.slice(0, 280) || "Session completed.",
    highlights: ["Clear STAR structure", "Quantified outcome"],
    followups: ["Add metrics to story 2", "Clarify tradeoff ownership"],
    questionBank: [
      "How did you measure success?",
      "What would you do differently?",
      "Tell me about a conflict in that project",
      "How did you handle the deadline pressure?",
      "What did you learn about stakeholder management?",
    ],
  };
}
