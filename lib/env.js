const requiredVars = [
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL"
];

export function getConfig() {
  const missing = requiredVars.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const mcpServerUrl =
    process.env.MCP_CONNECT_URL ||
    process.env.MCP_SERVER_URL ||
    process.env.MCP_URL ||
    "https://mcp.zapier.com/api/v1/connect";
  let mcpToken = process.env.MCP_TOKEN || process.env.ZAPIER_MCP_TOKEN || "";

  if (!mcpToken) {
    try {
      const parsed = new URL(mcpServerUrl);
      mcpToken = parsed.searchParams.get("token") || "";
    } catch {
      // Ignore URL parse failures and validate below.
    }
  }

  if (!mcpToken) {
    throw new Error(
      "Missing MCP token. Set MCP_TOKEN (or ZAPIER_MCP_TOKEN), or include token in MCP_CONNECT_URL."
    );
  }

  return {
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL.replace(/\/$/, ""),
    ollamaModel: process.env.OLLAMA_MODEL,
    ollamaApiKey: process.env.OLLAMA_API_KEY || "",
    mcpServerUrl,
    mcpToken,
    maxToolRounds: Number(process.env.MAX_TOOL_ROUNDS || 8)
  };
}
