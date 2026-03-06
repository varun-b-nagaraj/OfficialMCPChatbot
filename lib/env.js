const requiredVars = [
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL"
];

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function getConfig() {
  const missing = requiredVars.filter((key) => !clean(process.env[key]));
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const mcpServerUrl = clean(
    process.env.MCP_CONNECT_URL ||
    process.env.MCP_SERVER_URL ||
    process.env.MCP_URL ||
    "https://mcp.zapier.com/api/v1/connect"
  );
  let mcpToken = clean(process.env.MCP_TOKEN || process.env.ZAPIER_MCP_TOKEN || "");

  if (!mcpToken) {
    try {
      const parsed = new URL(mcpServerUrl);
      mcpToken = clean(parsed.searchParams.get("token") || "");
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
    ollamaBaseUrl: clean(process.env.OLLAMA_BASE_URL).replace(/\/$/, ""),
    ollamaModel: clean(process.env.OLLAMA_MODEL),
    ollamaApiKey: clean(process.env.OLLAMA_API_KEY || ""),
    mcpServerUrl,
    mcpToken,
    maxToolRounds: Number(process.env.MAX_TOOL_ROUNDS || 8)
  };
}
