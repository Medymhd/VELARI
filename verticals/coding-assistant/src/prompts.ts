import type { ChatMessage } from "@app/contracts";

export function buildCodeExplainMessages(code: string, language?: string): ChatMessage[] {
  return [
    { role: "system", content: "You are a senior engineer. Explain the code concisely, note complexity, edge cases, and suggest one improvement." },
    { role: "user", content: `Language: ${language ?? "auto"}\n\nCode:\n\`\`\`\n${code.slice(0, 8000)}\n\`\`\`` },
  ];
}

export function buildCodeReviewMessages(code: string): ChatMessage[] {
  return [
    { role: "system", content: "Review the code for correctness, performance, and style. Respond with JSON {issues:[{line, severity, message}], summary:string}." },
    { role: "user", content: code.slice(0, 8000) },
  ];
}
