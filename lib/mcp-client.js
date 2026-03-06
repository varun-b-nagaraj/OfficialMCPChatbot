let cached = {
  client: null,
  ready: null,
  tools: null
};

async function loadSdk() {
  const clientCandidates = [
    "@modelcontextprotocol/sdk/client/index.js",
    "@modelcontextprotocol/sdk/client/index.mjs",
    "@modelcontextprotocol/sdk/client"
  ];

  const transportCandidates = [
    "@modelcontextprotocol/sdk/client/streamableHttp.js",
    "@modelcontextprotocol/sdk/client/streamableHttp.mjs",
    "@modelcontextprotocol/sdk/client/streamableHttp"
  ];

  let Client;
  let StreamableHTTPClientTransport;

  for (const mod of clientCandidates) {
    try {
      const imported = await import(mod);
      Client = imported.Client;
      if (Client) break;
    } catch {
      // Try next path.
    }
  }

  for (const mod of transportCandidates) {
    try {
      const imported = await import(mod);
      StreamableHTTPClientTransport = imported.StreamableHTTPClientTransport;
      if (StreamableHTTPClientTransport) break;
    } catch {
      // Try next path.
    }
  }

  if (!Client || !StreamableHTTPClientTransport) {
    throw new Error(
      "Unable to import MCP SDK transport/client. Check @modelcontextprotocol/sdk version compatibility."
    );
  }

  return { Client, StreamableHTTPClientTransport };
}

function normalizeToolsResponse(result) {
  if (!result) return [];
  if (Array.isArray(result.tools)) return result.tools;
  if (Array.isArray(result)) return result;
  return [];
}

export async function getMcpClient(config) {
  if (cached.client && cached.ready) {
    await cached.ready;
    return cached.client;
  }

  const { Client, StreamableHTTPClientTransport } = await loadSdk();

  const client = new Client({ name: "shop-assistant", version: "1.0.0" });
  const url = new URL(config.mcpServerUrl);

  if (!url.searchParams.get("token")) {
    url.searchParams.set("token", config.mcpToken);
  }

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${config.mcpToken}`
      }
    }
  });

  cached.client = client;
  cached.ready = client.connect(transport);
  await cached.ready;

  return client;
}

export async function listMcpTools(config) {
  if (cached.tools) return cached.tools;
  const client = await getMcpClient(config);
  const result = await client.listTools();
  const tools = normalizeToolsResponse(result);
  cached.tools = tools;
  return tools;
}

export async function callMcpTool(config, name, args) {
  const client = await getMcpClient(config);
  return client.callTool({ name, arguments: args || {} });
}

export function mcpResultToText(result) {
  if (!result) return "No result returned.";

  if (Array.isArray(result.content)) {
    return result.content
      .map((part) => {
        if (!part) return "";
        if (part.type === "text") return part.text || "";
        return JSON.stringify(part);
      })
      .join("\n")
      .trim();
  }

  if (typeof result === "string") return result;
  return JSON.stringify(result);
}
