import { getConfig } from "../lib/env.js";
import { callMcpTool, listMcpTools, mcpResultToText } from "../lib/mcp-client.js";
import { normalizeToolCalls, ollamaChat } from "../lib/ollama.js";

export const config = {
  runtime: "nodejs"
};

function getAllowedOrigins() {
  const raw = process.env.CORS_ALLOW_ORIGINS || "";
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function applyCors(req, res) {
  const origin = req.headers.origin || "";
  const allowed = getAllowedOrigins();

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Allow non-browser/server-to-server requests with no Origin header.
  if (!origin) {
    return true;
  }

  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    return true;
  }

  return false;
}

const SALES_SYSTEM_PROMPT = [
  "You are an expert ecommerce sales assistant.",
  "Goals:",
  "1) Help shoppers quickly find products and move them toward purchase.",
  "2) Be proactive: when users ask broad requests (for example 'show me products'), immediately provide useful options across relevant categories.",
  "3) Ask clarifying questions only when truly necessary to complete a task. Keep to at most one short clarifying question.",
  "4) Recommend strong alternatives and relevant add-ons when helpful.",
  "5) Use relevant sales context (for example popular products or order history patterns) to guide recommendations and encourage buying decisions.",
  "6) Treat CATALOG_CONTEXT_JSON as the primary source of truth for products and pricing when present.",
  "7) Do not call product listing/search tools when CATALOG_CONTEXT_JSON is available unless the user asks to refresh inventory or catalog data is clearly insufficient.",
  "8) Be honest about what you know; use tools for order/customer lookup and order creation when needed.",
  "9) When creating an order, confirm critical fields before finalizing.",
  "Behavior:",
  "- Default to action over questions. Do not interrogate the shopper.",
  "- For generic shopping intents, use available catalog context first and present a curated list immediately.",
  "- If message history exists, continue naturally from that context without re-asking already answered questions.",
  "- Keep answers concise, useful, and conversion-focused.",
  "- Summarize tool findings clearly and propose the next best step.",
  "- Use friendly sales language and concrete recommendations.",
  "- Do not reveal internal product counts, stock quantities, internal IDs, private customer data, or operational/sensitive fields.",
  "- If sensitive/internal data appears in tool output, omit it and provide a safe shopper-facing summary instead.",
  "- Never invent product or order details."
].join("\n");

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function isProductTool(tool) {
  const name = String(tool?.name || "").toLowerCase();
  const desc = String(tool?.description || "").toLowerCase();
  if (name.includes("find_product") || name.includes("product_search") || name.includes("catalog_search")) {
    return true;
  }
  if (name.includes("create_order") || name.includes("find_order") || name.includes("find_customer")) {
    return false;
  }
  return (
    (name.includes("product") && (name.includes("find") || name.includes("search") || name.includes("list"))) ||
    desc.includes("search products") ||
    desc.includes("find product") ||
    desc.includes("list products")
  );
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseJsonText(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue to best-effort extraction below.
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      // No-op.
    }
  }

  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch {
      // No-op.
    }
  }

  return null;
}

function extractStructuredResult(result) {
  if (!result) return null;
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  if (result.data && typeof result.data === "object") {
    return result.data;
  }
  if (typeof result === "object" && !Array.isArray(result) && result.content == null) {
    return result;
  }
  if (!Array.isArray(result.content)) return null;

  for (const part of result.content) {
    if (!part) continue;
    if (part.type === "json" && part.json && typeof part.json === "object") {
      return part.json;
    }
    if (part.type === "text") {
      const parsed = parseJsonText(part.text || "");
      if (parsed && typeof parsed === "object") return parsed;
    }
  }

  return null;
}

function extractProductsFromData(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  const candidates = [
    data.products,
    data.items,
    data.results,
    data.data,
    data.catalog,
    data.rows
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}

function buildPagedToolArgs(tool, offset, limit) {
  const schema = tool?.inputSchema || {};
  const props = schema.properties || {};
  const args = {};

  if ("offset" in props) args.offset = offset;
  if ("skip" in props) args.skip = offset;
  if ("limit" in props) args.limit = limit;
  if ("page_size" in props) args.page_size = limit;
  if ("per_page" in props) args.per_page = limit;
  if ("page" in props) args.page = Math.floor(offset / limit) + 1;
  if ("query" in props) args.query = "";
  if ("keyword" in props) args.keyword = "";
  if ("search" in props) args.search = "";
  if ("instructions" in props) {
    args.instructions = "List enabled products for shopping assistant catalog preload.";
  }
  if ("enabled" in props) {
    const enabledType = props.enabled?.type;
    args.enabled = enabledType === "string" ? "true" : true;
  }

  return coerceToolArguments(tool, args);
}

function coerceToolArguments(tool, rawArgs) {
  const schema = tool?.inputSchema || {};
  const props = schema.properties || {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const args = { ...(rawArgs || {}) };

  for (const [name, definition] of Object.entries(props)) {
    const expectedType = definition?.type;
    const value = args[name];

    if (value == null) {
      if (required.has(name) && expectedType === "string") {
        if (name === "instructions") {
          args[name] = "Help shopper find matching products.";
        } else {
          args[name] = "";
        }
      }
      continue;
    }

    if (expectedType === "string" && typeof value !== "string") {
      if (typeof value === "boolean") args[name] = value ? "true" : "false";
      else if (typeof value === "number") args[name] = String(value);
      else args[name] = JSON.stringify(value);
      continue;
    }

    if (expectedType === "boolean" && typeof value !== "boolean") {
      if (typeof value === "string") {
        args[name] = value.toLowerCase() === "true";
      } else {
        args[name] = Boolean(value);
      }
      continue;
    }

    if ((expectedType === "number" || expectedType === "integer") && typeof value !== "number") {
      const num = Number(value);
      if (!Number.isNaN(num)) args[name] = num;
    }
  }

  return args;
}

function hasPagingInputs(tool) {
  const props = tool?.inputSchema?.properties || {};
  return (
    "offset" in props ||
    "skip" in props ||
    "limit" in props ||
    "page_size" in props ||
    "per_page" in props ||
    "page" in props
  );
}

async function preloadCatalogData(config, mcpTools, res) {
  const productTool = mcpTools.find((tool) => isProductTool(tool));
  if (!productTool) {
    throw new Error("No product listing tool found on MCP server.");
  }

  const limit = 100;
  const maxPages = 50;
  const supportsPaging = hasPagingInputs(productTool);
  const seen = new Set();
  const products = [];

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * limit;
    const args = buildPagedToolArgs(productTool, offset, limit);
    const raw = await callMcpTool(config, productTool.name, args);
    const structured = extractStructuredResult(raw);
    const batch = extractProductsFromData(structured);

    for (const item of toArray(batch)) {
      const id = item?.id ?? item?.productId ?? item?.product_id ?? null;
      const key = id != null ? String(id) : JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      products.push(item);
    }

    writeSse(res, "catalog_page", {
      tool: productTool.name,
      page: page + 1,
      fetched: toArray(batch).length,
      total: products.length
    });

    if (!supportsPaging) break;
    if (toArray(batch).length < limit) break;
  }

  return {
    sourceTool: productTool.name,
    fetchedAt: new Date().toISOString(),
    totalProducts: products.length,
    products
  };
}

function normalizeCatalogData(raw) {
  if (!raw) return null;

  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") return null;
  const products = toArray(parsed.products).slice(0, 5000);
  const resultProducts = toArray(parsed.results).slice(0, 5000);
  const catalogProducts = products.length ? products : resultProducts;

  return {
    sourceTool: parsed.sourceTool || parsed?.execution?.toolName || "client_payload",
    fetchedAt: parsed.fetchedAt || null,
    totalProducts: Number(parsed.totalProducts || catalogProducts.length || 0),
    products: catalogProducts,
    meta: {
      feedbackUrl: parsed.feedbackUrl || null,
      execution: parsed.execution || null,
      isPreview: parsed.isPreview ?? null,
      generatedJqFilter: parsed.generatedJqFilter || null
    }
  };
}

function toOllamaTools(mcpTools) {
  return mcpTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.inputSchema || {
        type: "object",
        properties: {}
      }
    }
  }));
}

function getToolByName(tools, name) {
  return toArray(tools).find((tool) => tool?.name === name) || null;
}

function sanitizeIncomingMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) return [];

  return rawMessages
    .filter((msg) => msg && typeof msg === "object")
    .map((msg) => ({
      role: msg.role === "assistant" || msg.role === "system" ? msg.role : "user",
      content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "")
    }))
    .slice(-30);
}

function sortByOrder(messages) {
  const withOrder = [];
  const withoutOrder = [];

  for (const msg of toArray(messages)) {
    const order = Number(msg?.order);
    if (Number.isFinite(order)) {
      withOrder.push({ msg, order });
    } else {
      withoutOrder.push(msg);
    }
  }

  withOrder.sort((a, b) => a.order - b.order);
  return [...withOrder.map((x) => x.msg), ...withoutOrder];
}

function buildIncomingConversation(body) {
  const history = sortByOrder(body.message_history);
  const latest = sortByOrder(body.messages);
  return sanitizeIncomingMessages([...history, ...latest]);
}

function pickFirstConvoFlag(body) {
  if (typeof body.firstConvo === "boolean") return body.firstConvo;
  if (typeof body.new_convo === "boolean") return body.new_convo;
  return false;
}

export default async function handler(req, res) {
  const originAllowed = applyCors(req, res);

  if (req.method === "OPTIONS") {
    if (!originAllowed) {
      res.status(403).end();
      return;
    }
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed. Use POST." });
    return;
  }

  if (!originAllowed) {
    res.status(403).json({ error: "Origin not allowed." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  try {
    const config = getConfig();
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const incomingMessages = buildIncomingConversation(body);
    const firstConvo = pickFirstConvoFlag(body);
    const providedCatalog = normalizeCatalogData(body.catalogData || body.product_info || body.products);

    if (incomingMessages.length === 0) {
      writeSse(res, "error", { message: "Request must include messages[]." });
      writeSse(res, "done", { ok: false });
      res.end();
      return;
    }

    const mcpTools = await listMcpTools(config);
    let effectiveCatalog = providedCatalog;
    if (firstConvo && !effectiveCatalog) {
      writeSse(res, "catalog_fetch", { status: "started" });
      effectiveCatalog = await preloadCatalogData(config, mcpTools, res);
      writeSse(res, "catalog_fetch", {
        status: "completed",
        totalProducts: effectiveCatalog.totalProducts
      });
      writeSse(res, "catalog", effectiveCatalog);
    }

    const allowProductTool =
      !effectiveCatalog ||
      body.allowProductLookup === true ||
      body.allow_product_lookup === true;
    const activeTools = allowProductTool ? mcpTools : mcpTools.filter((tool) => !isProductTool(tool));
    const ollamaTools = toOllamaTools(activeTools);

    const conversation = [
      { role: "system", content: SALES_SYSTEM_PROMPT },
      ...(effectiveCatalog
        ? [
            {
              role: "system",
              content: `CATALOG_CONTEXT_JSON:\n${JSON.stringify(effectiveCatalog)}`
            }
          ]
        : []),
      ...incomingMessages
    ];

    writeSse(res, "meta", {
      model: config.ollamaModel,
      tools: activeTools.map((t) => t.name),
      usedCatalogPayload: Boolean(effectiveCatalog),
      firstConvo
    });

    let finalText = "";

    for (let round = 0; round < config.maxToolRounds; round += 1) {
      const modelResponse = await ollamaChat({
        baseUrl: config.ollamaBaseUrl,
        model: config.ollamaModel,
        apiKey: config.ollamaApiKey,
        messages: conversation,
        tools: ollamaTools,
        stream: false
      });

      const assistantMessage = modelResponse?.message || { role: "assistant", content: "" };
      const assistantText = assistantMessage.content || "";
      const toolCalls = normalizeToolCalls(assistantMessage);

      conversation.push({
        role: "assistant",
        content: assistantText,
        tool_calls: assistantMessage.tool_calls || []
      });

      if (assistantText) {
        finalText = assistantText;
        writeSse(res, "assistant", { text: assistantText, round: round + 1 });
      }

      if (toolCalls.length === 0) {
        break;
      }

      for (const call of toolCalls) {
        const toolDef = getToolByName(activeTools, call.name);
        const safeArgs = coerceToolArguments(toolDef, call.arguments || {});
        writeSse(res, "tool_call", { name: call.name, arguments: safeArgs });

        let toolResult;
        try {
          toolResult = await callMcpTool(config, call.name, safeArgs);
        } catch (error) {
          toolResult = {
            content: [{ type: "text", text: `Tool error: ${error.message}` }],
            isError: true
          };
        }

        const toolText = mcpResultToText(toolResult);

        writeSse(res, "tool_result", {
          name: call.name,
          result: toolText,
          isError: Boolean(toolResult?.isError)
        });

        conversation.push({
          role: "tool",
          content: toolText,
          name: call.name
        });
      }
    }

    writeSse(res, "done", {
      ok: true,
      message: finalText,
      ...(firstConvo && effectiveCatalog ? { catalogData: effectiveCatalog } : {})
    });
    res.end();
  } catch (error) {
    writeSse(res, "error", { message: error.message || "Unexpected server error." });
    writeSse(res, "done", { ok: false });
    res.end();
  }
}
