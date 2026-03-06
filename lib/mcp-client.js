let cached = {
  clients: new Map(),
  tools: new Map()
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

  const stdioCandidates = [
    "@modelcontextprotocol/sdk/client/stdio.js",
    "@modelcontextprotocol/sdk/client/stdio.mjs",
    "@modelcontextprotocol/sdk/client/stdio"
  ];

  let Client;
  let StreamableHTTPClientTransport;
  let StdioClientTransport;

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

  for (const mod of stdioCandidates) {
    try {
      const imported = await import(mod);
      StdioClientTransport = imported.StdioClientTransport;
      if (StdioClientTransport) break;
    } catch {
      // Try next path.
    }
  }

  if (!Client || !StreamableHTTPClientTransport) {
    throw new Error(
      "Unable to import MCP SDK transport/client. Check @modelcontextprotocol/sdk version compatibility."
    );
  }

  return { Client, StreamableHTTPClientTransport, StdioClientTransport };
}

function normalizeToolsResponse(result) {
  if (!result) return [];
  if (Array.isArray(result.tools)) return result.tools;
  if (Array.isArray(result)) return result;
  return [];
}

export async function getMcpClient(config) {
  const cacheKey = getCacheKey(config);
  const existing = cached.clients.get(cacheKey);

  if (existing) {
    await existing.ready;
    return existing.client;
  }

  const { Client, StreamableHTTPClientTransport, StdioClientTransport } = await loadSdk();

  const client = new Client({ name: "shop-assistant", version: "1.0.0" });
  let ready;

  if (config.mcpServerDefinition) {
    if (!StdioClientTransport) {
      throw new Error("Stdio MCP transport unavailable in installed @modelcontextprotocol/sdk version.");
    }

    const definition = config.mcpServerDefinition;
    const transport = new StdioClientTransport({
      command: definition.command,
      args: Array.isArray(definition.args) ? definition.args : [],
      env: {
        ...process.env,
        ...(definition.env || {})
      }
    });

    ready = client.connect(transport);
  } else {
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

    ready = client.connect(transport);
  }

  cached.clients.set(cacheKey, { client, ready });
  await ready;

  return client;
}

export async function listMcpTools(config) {
  const cacheKey = getCacheKey(config);
  const toolCache = cached.tools.get(cacheKey);
  if (toolCache) return toolCache;
  const client = await getMcpClient(config);
  const result = await client.listTools();
  const tools = normalizeToolsResponse(result);
  cached.tools.set(cacheKey, tools);
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

function getCacheKey(config) {
  if (config.mcpServerDefinition) {
    const definition = config.mcpServerDefinition;
    return `stdio:${config.mcpServerName}:${definition.command}:${JSON.stringify(definition.args || [])}`;
  }

  return `http:${config.mcpServerUrl}`;
}
