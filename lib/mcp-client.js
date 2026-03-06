import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let cached = {
  client: null,
  ready: null,
  tools: null
};

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
