import type { VerticalManifest } from "@app/contracts";

export const codingAssistantManifest: VerticalManifest = {
  id: "coding-assistant",
  version: "0.1.0",
  displayName: "Coding Assistant",
  requiredCapabilities: ["chat", "structured_output", "vision", "streaming"],
  requiredPermissions: ["screen_capture"],
  routes: [
    { method: "POST", path: "/explain", handlerId: "code.explain" },
    { method: "POST", path: "/review", handlerId: "code.review" },
  ],
  tools: [
    {
      id: "code.suggest_fix",
      description: "Suggest a fix for the captured code/problem. Requires approval before applying.",
      inputSchema: {
        type: "object",
        properties: { code: { type: "string" }, language: { type: "string" } },
        required: ["code"],
      },
      risk: "external_write",
    },
  ],
  retentionDefaults: "retain_30d",
};
