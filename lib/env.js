import fs from "node:fs";
import path from "node:path";

const requiredVars = [
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL"
];

function loadNamedMcpServerConfig(configPath, serverName) {
  const fullPath = path.isAbsolute(configPath)
    ? configPath
    : path.join(process.cwd(), configPath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`MCP server config file not found: ${fullPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  const servers = parsed?.mcpServers || {};
  const selected = servers[serverName];

  if (!selected) {
    throw new Error(`MCP server '${serverName}' not found in ${fullPath}`);
  }

  if (!selected.command) {
    throw new Error(`MCP server '${serverName}' must define 'command'.`);
  }

  return {
    configPath: fullPath,
    definition: selected
  };
}

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
  const mcpServerName = process.env.MCP_SERVER_NAME || "";
  const mcpServerConfigPath = process.env.MCP_SERVER_CONFIG_PATH || "./mcp.servers.json";
  let mcpToken = process.env.MCP_TOKEN || process.env.ZAPIER_MCP_TOKEN || "";
  let namedServerConfig = null;

  if (mcpServerName) {
    namedServerConfig = loadNamedMcpServerConfig(mcpServerConfigPath, mcpServerName);
  } else if (!mcpToken) {
    try {
      const parsed = new URL(mcpServerUrl);
      mcpToken = parsed.searchParams.get("token") || "";
    } catch {
      // Ignore URL parse failures and validate below.
    }
  }

  if (!mcpServerName && !mcpToken) {
    throw new Error(
      "Missing MCP token. Set MCP_TOKEN (or ZAPIER_MCP_TOKEN), or include token in MCP_CONNECT_URL."
    );
  }

  return {
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL.replace(/\/$/, ""),
    ollamaModel: process.env.OLLAMA_MODEL,
    ollamaApiKey: process.env.OLLAMA_API_KEY || "",
    mcpServerName,
    mcpServerUrl,
    mcpToken,
    mcpServerConfigPath: namedServerConfig?.configPath || "",
    mcpServerDefinition: namedServerConfig?.definition || null,
    maxToolRounds: Number(process.env.MAX_TOOL_ROUNDS || 8)
  };
}
