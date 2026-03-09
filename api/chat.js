import { getConfig } from "../lib/env.js";
import { callMcpTool, listMcpTools, mcpResultToText } from "../lib/mcp-client.js";
import { normalizeToolCalls, ollamaChatStream } from "../lib/ollama.js";

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
  "You are the RRHS CO-OP Bot, a smart and natural shopping assistant for the Round Rock High School school store.",
  "Your job is to help students and staff find products, answer questions, suggest strong options, and guide decisions naturally.",
  "How to behave:",
  "- Be conversational and helpful, not robotic.",
  "- Understand user intent from full context, not just keywords.",
  "- Use conversation history for follow-ups like 'any more?' or 'what else?'.",
  "- If a user says something indirect like 'I'm hungry', infer snack/drink intent.",
  "- For broad requests, recommend a few relevant products rather than dumping large lists.",
  "- Keep responses concise and natural.",
  "Catalog rules:",
  "- Use CATALOG_CONTEXT_JSON as source of truth when available.",
  "- Never invent products, prices, variants, stock, or details.",
  "- Never expose internal IDs, raw metadata, or sensitive operational fields.",
  "- Do not claim cart actions were executed unless confirmed by the client.",
  "Recommendation rules:",
  "- Relevance over quantity.",
  "- For broad requests provide 3 to 5 options max.",
  "- For category requests, prioritize matching items from context.",
  "- If user asks for more, continue same category unless topic changes.",
  "Tool rules:",
  "- Use MCP tools when needed to get missing data.",
  "- Prefer existing catalog context to reduce unnecessary tool calls.",
  "- If you mention tool capabilities, do so accurately.",
  "Never invent product details."
].join("\n");
const LOCAL_CART_TOOL_NAME = "add_to_cart_decision";
const LOCAL_CART_TOOL_ENABLED = false;

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
  const toolName = String(tool?.name || "").toLowerCase();

  function expectedTypeOf(definition) {
    if (!definition || typeof definition !== "object") return null;
    if (typeof definition.type === "string") return definition.type;
    if (Array.isArray(definition.type)) {
      const first = definition.type.find((t) => typeof t === "string");
      if (first) return first;
    }
    if (Array.isArray(definition.oneOf)) {
      for (const item of definition.oneOf) {
        const t = expectedTypeOf(item);
        if (t) return t;
      }
    }
    if (Array.isArray(definition.anyOf)) {
      for (const item of definition.anyOf) {
        const t = expectedTypeOf(item);
        if (t) return t;
      }
    }
    if (definition.schema && typeof definition.schema === "object") {
      const t = expectedTypeOf(definition.schema);
      if (t) return t;
    }
    return null;
  }

  for (const [name, definition] of Object.entries(props)) {
    const expectedType = expectedTypeOf(definition);
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

  // Ecwid product search tool expects enabled as string in practice.
  if (toolName.includes("find_product") && "enabled" in args && typeof args.enabled !== "string") {
    if (typeof args.enabled === "boolean") args.enabled = args.enabled ? "true" : "false";
    else args.enabled = String(args.enabled);
  }

  // Some Ecwid product tools require instructions string.
  if (toolName.includes("find_product") && (!("instructions" in args) || typeof args.instructions !== "string")) {
    args.instructions = "Find products from the enabled catalog.";
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

function hasUsableCatalog(catalog) {
  return Boolean(catalog && Array.isArray(catalog.products) && catalog.products.length > 0);
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

function getLatestUserMessage(messages) {
  const list = toArray(messages);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i];
    if (msg?.role === "user" && typeof msg.content === "string" && msg.content.trim()) {
      return msg.content.trim();
    }
  }
  return "";
}

function normalizeCatalogProducts(catalog) {
  const products = toArray(catalog?.products);
  return products
    .map((p) => {
      const name = String(p?.name || p?.title || "").trim();
      const enabled = p?.enabled !== false;
      const priceRaw = p?.price ?? p?.defaultDisplayedPrice ?? p?.defaultPrice ?? null;
      const price = priceRaw == null ? null : Number(priceRaw);
      const idRaw = p?.id ?? p?.productId ?? p?.product_id ?? null;
      const id = idRaw == null ? null : Number(idRaw);
      const options = Array.isArray(p?.options) ? p.options : [];
      const variants = Array.isArray(p?.variants) ? p.variants : [];
      return {
        name,
        enabled,
        price: Number.isFinite(price) ? price : null,
        sku: p?.sku || p?.defaultSku || null,
        id: Number.isFinite(id) ? id : null,
        options,
        variants
      };
    })
    .filter((p) => p.name && p.enabled);
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMaxPrice(text) {
  const match = String(text || "").toLowerCase().match(/(?:under|below|less than|<=?)\s*\$?\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parseCategoryTerms(text) {
  const stop = new Set([
    "show", "me", "some", "products", "product", "find", "list", "recommend", "give", "enabled",
    "under", "below", "less", "than", "price", "for", "with", "and", "or", "the", "a", "an",
    "what", "are", "good", "best", "popular", "cool", "nice", "hi", "hello", "hey", "yo",
    "please", "can", "you", "i", "want", "today", "anything"
  ]);
  return normalizeName(text)
    .split(" ")
    .filter((t) => t && !stop.has(t) && Number.isNaN(Number(t)));
}

function isShoppingBrowseIntent(text) {
  const t = String(text || "").toLowerCase();
  return (
    /\b(show|find|list|recommend|suggest)\b/.test(t) ||
    /\bproducts?\b/.test(t) ||
    /\b(snacks|chips|drinks|apparel|shirts|hoodies|supplies|school supplies|gifts)\b/.test(t)
  );
}

function isGreeting(text) {
  const t = String(text || "").trim().toLowerCase();
  return /^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening)\b/.test(t);
}

function isGeneralRecommendationIntent(text) {
  const t = String(text || "").toLowerCase();
  return (
    /what are some good products/.test(t) ||
    /what products do you recommend/.test(t) ||
    /what should i buy/.test(t) ||
    /\bbest products\b/.test(t) ||
    /\bpopular products\b/.test(t) ||
    /\bgood products\b/.test(t)
  );
}

function formatCatalogRecommendation(userText, catalogProducts) {
  const maxPrice = parseMaxPrice(userText);
  const terms = parseCategoryTerms(userText);
  let filtered = catalogProducts.slice();

  if (maxPrice != null) {
    filtered = filtered.filter((p) => p.price == null || p.price <= maxPrice);
  }

  if (terms.length) {
    filtered = filtered.filter((p) => {
      const name = normalizeName(p.name);
      return terms.some((term) => name.includes(term));
    });
  }

  if (!filtered.length) {
    filtered = catalogProducts
      .filter((p) => (maxPrice == null ? true : p.price == null || p.price <= maxPrice))
      .slice(0, 5);
  }

  const picks = filtered.slice(0, 5);
  if (!picks.length) {
    return "I could not find matching enabled products right now. Tell me a category and budget and I will narrow it down fast.";
  }

  const header = maxPrice != null
    ? `Here are enabled picks${terms.length ? ` for ${terms.join(", ")}` : ""} under $${maxPrice}:`
    : `Here are enabled picks${terms.length ? ` for ${terms.join(", ")}` : ""}:`;
  const lines = [header];
  for (const p of picks) {
    const priceText = p.price == null ? "Price available in checkout" : `$${p.price.toFixed(2)}`;
    lines.push(`- ${p.name} - ${priceText}`);
  }
  lines.push("Tell me which one you want and I can help with checkout.");
  return lines.join("\n");
}

function formatGeneralRecommendations(catalogProducts) {
  const picks = catalogProducts.slice(0, 5);
  if (!picks.length) {
    return "We have snacks, school supplies, apparel, and accessories. Tell me what category you want and I will narrow it down.";
  }

  const lines = ["Here are some good RRHS CO-OP picks right now:"];
  for (const p of picks) {
    const priceText = p.price == null ? "Price available at checkout" : `$${p.price.toFixed(2)}`;
    lines.push(`- ${p.name} - ${priceText}`);
  }
  lines.push("If you want, I can suggest the best snacks, apparel, or school supplies specifically.");
  return lines.join("\n");
}

function extractListedNames(text) {
  const lines = String(text || "").split("\n");
  const names = [];
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (!/^[-*•\d]/.test(line)) continue;
    const noBullet = line.replace(/^[-*•\d\.\)\s]+/, "");
    const name = noBullet.split(/\s-\s|\s–\s|\s\|\s|\s\$/)[0]?.trim();
    if (name && name.length > 1) names.push(name);
  }
  return names;
}

function hasCatalogHallucination(text, catalogProducts) {
  const catalogNames = new Set(catalogProducts.map((p) => normalizeName(p.name)));
  if (!catalogNames.size) return false;
  const listed = extractListedNames(text);
  if (!listed.length) return false;

  for (const name of listed) {
    const normalized = normalizeName(name);
    if (!normalized) continue;
    const exact = catalogNames.has(normalized);
    const partial = [...catalogNames].some((c) => c.includes(normalized) || normalized.includes(c));
    if (!exact && !partial) return true;
  }

  return false;
}

function streamTextAsDeltas(res, text, round) {
  const chunks = String(text || "").match(/\S+\s*|\n/g) || [];
  for (const chunk of chunks) {
    writeSse(res, "assistant_delta", { token: chunk, round });
  }
}

function isToolingQuestion(text) {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("what are all available tools") ||
    t.includes("what tools") ||
    t.includes("available tools") ||
    t.includes("do you have") ||
    t.includes("cart tool")
  );
}

function toolingSummaryText(activeTools) {
  const names = toArray(activeTools).map((t) => t?.name).filter(Boolean);
  const lines = [
    "Available capabilities:",
    "- Product/catalog search tools",
    "- Customer lookup tools",
    "- Order search tools",
    "- Order creation tools",
    "- Cart decision layer via `cart_actions` and `pending` (frontend executes Ecwid.Cart methods)"
  ];
  if (names.length) {
    lines.push("", "MCP tools currently connected:");
    for (const n of names) lines.push(`- ${n}`);
  }
  lines.push("", "So yes: cart add/modify intent is supported through structured cart actions.");
  return lines.join("\n");
}

function localCartToolDefinition() {
  return {
    type: "function",
    function: {
      name: LOCAL_CART_TOOL_NAME,
      description:
        "Resolve add-to-cart intent into structured cart_actions and pending chooser payload for frontend Ecwid.Cart execution.",
      parameters: {
        type: "object",
        properties: {
          user_message: { type: "string" },
          catalog_products: {
            type: "array",
            items: { type: "object" }
          },
          pending: { type: "object" },
          message_history: {
            type: "array",
            items: { type: "object" }
          }
        }
      }
    }
  };
}

const ADD_INTENT_RE = /\b(add|put|throw)\b.*\b(cart|bag)\b|\badd\b/i;
const ORDINAL_WORDS = {
  first: 0,
  second: 1,
  third: 2,
  fourth: 3,
  fifth: 4,
  sixth: 5,
  seventh: 6,
  eighth: 7,
  ninth: 8,
  tenth: 9
};
const CARDINAL_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10
};

function shouldAddToCart(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  return ADD_INTENT_RE.test(t) && (t.includes("cart") || t.includes("bag") || t.startsWith("add "));
}

function parseQuantity(text) {
  const t = String(text || "").toLowerCase();
  const match = t.match(/\b(\d{1,2})\s*(x|×)?\b/);
  if (!match) return 1;
  const qty = Number(match[1]);
  return Number.isFinite(qty) ? Math.max(1, Math.min(20, qty)) : 1;
}

function wantsMultipleDistinctItems(text) {
  const t = String(text || "").toLowerCase();
  return t.includes("both") || t.includes("all") || /\b(last|first|these|those)\s+\d+\b/.test(t);
}

function productMatchScore(userText, productName) {
  const u = normalizeName(userText);
  const p = normalizeName(productName);
  if (!u || !p) return 0;
  if (u.includes(p)) return 100 + p.length;
  const ut = new Set(u.split(" ").filter(Boolean));
  const pt = new Set(p.split(" ").filter(Boolean));
  let overlap = 0;
  for (const token of pt) {
    if (ut.has(token)) overlap += 1;
  }
  return overlap;
}

function findCartCandidates(userText, catalogProducts) {
  const scored = [];
  for (const p of toArray(catalogProducts)) {
    const score = productMatchScore(userText, p.name);
    if (score > 0) scored.push({ product: p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.product).slice(0, 5);
}

function getOptionNames(product) {
  const names = [];
  for (const opt of toArray(product?.options)) {
    const n = opt?.name || opt?.title || opt?.optionName;
    if (n) names.push(String(n));
  }
  return names;
}

function userSpecifiedVariant(userText, variantLabel, variantKey) {
  const text = String(userText || "").toLowerCase();
  if (!text) return false;
  if (variantKey && String(variantKey).toLowerCase() && text.includes(String(variantKey).toLowerCase())) {
    return true;
  }
  const tokens = String(variantLabel || "")
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
  return tokens.filter((t) => t.length >= 2).some((tok) => text.includes(tok));
}

function userSpecifiedOptionType(userText, product) {
  const t = normalizeName(userText);
  if (!t) return false;
  for (const n of getOptionNames(product)) {
    const normalized = normalizeName(n);
    if (normalized && t.includes(normalized)) return true;
  }
  return false;
}

function extractSingleOrdinalIndex(text, total) {
  const t = String(text || "").toLowerCase();
  if (!t || total <= 0) return null;
  if (/\blast\s+one\b|\bthe\s+last\b|\blast\b/.test(t)) return total - 1;
  for (const [word, idx] of Object.entries(ORDINAL_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(t) && idx < total) return idx;
  }
  const m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (m) {
    const idx = Number(m[1]) - 1;
    if (Number.isFinite(idx) && idx >= 0 && idx < total) return idx;
  }
  return null;
}

function parseMultiIndices(text, totalOptions) {
  if (!text) return [];
  const t = text.toLowerCase();
  if (totalOptions && /\b(all|every|all of them)\b/.test(t)) return [...Array(totalOptions).keys()];
  if (totalOptions === 2 && /\b(both|both of them|those two|these two)\b/.test(t)) return [0, 1];

  const indices = [];
  const seen = new Set();
  const tokenRe = /\b(\d{1,2})(?:st|nd|rd|th)?\b|\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|one|two|three|four|five|six|seven|eight|nine|ten)\b/g;
  let match;
  while ((match = tokenRe.exec(t)) !== null) {
    let idx = null;
    if (match[1]) {
      idx = Number(match[1]) - 1;
    } else if (match[2]) {
      const word = match[2];
      if (word === "last" && totalOptions) idx = totalOptions - 1;
      else if (word in ORDINAL_WORDS) idx = ORDINAL_WORDS[word];
      else if (word in CARDINAL_WORDS) idx = CARDINAL_WORDS[word] - 1;
    }
    if (idx == null || Number.isNaN(idx)) continue;
    if (totalOptions != null && (idx < 0 || idx >= totalOptions)) continue;
    if (!seen.has(idx)) {
      seen.add(idx);
      indices.push(idx);
    }
  }
  return indices;
}

function buildCartAction(product, quantity) {
  if (!product || !Number.isFinite(Number(product.id))) return null;
  const pid = Number(product.id);
  const cidRaw = product.combinationId ?? product.variation ?? product.variantId ?? 0;
  const cid = Number.isFinite(Number(cidRaw)) ? Number(cidRaw) : 0;
  const opts = Array.isArray(product.selectedOptions)
    ? product.selectedOptions
    : Array.isArray(product.options)
      ? product.options
      : [];
  return {
    type: "cart.add",
    productId: pid,
    combinationId: cid,
    quantity,
    sku: product.sku || null,
    options: opts,
    product: {
      id: pid,
      quantity,
      options: {},
      sku: product.sku || null,
      name: product.name || null
    }
  };
}

function productHasSingleVariant(products, productId) {
  for (const p of toArray(products)) {
    if (Number(p?.id || 0) !== Number(productId || 0)) continue;
    const variants = toArray(p?.variants).filter((v) => v?.variantKey && v?.in_stock !== false);
    return variants.length === 1;
  }
  return false;
}

function pickCartCandidates(userText, productLinks, products) {
  if (!productLinks.length) return { candidates: [], reason: null };
  if (productLinks.length === 1) return { candidates: productLinks, reason: "single" };

  const selectionIndices = parseMultiIndices(userText, productLinks.length);
  if (selectionIndices.length) {
    return { candidates: selectionIndices.map((i) => productLinks[i]).filter(Boolean), reason: "index" };
  }

  const explicit = productLinks.filter((link) =>
    userSpecifiedVariant(userText, link.variantLabel || "", String(link.variantKey || ""))
  );
  if (explicit.length === 1) return { candidates: explicit, reason: "explicit" };
  if (explicit.length > 1) return { candidates: [], reason: null };

  const lowerText = String(userText || "").toLowerCase();
  const byName = productLinks.filter((link) => link.name && lowerText.includes(String(link.name).toLowerCase()));
  if (byName.length === 1) return { candidates: byName, reason: "name" };

  return { candidates: [], reason: null };
}

function buildCartActions(userText, productLinks, products) {
  if (!shouldAddToCart(userText)) return [];
  const { candidates, reason } = pickCartCandidates(userText, productLinks, products);
  if (!candidates.length) return [];
  let qty = parseQuantity(userText);
  if (candidates.length >= 2 && wantsMultipleDistinctItems(userText)) qty = 1;
  const actions = [];

  for (const candidate of candidates) {
    const pid = Number(candidate.id || 0);
    const label = candidate.variantLabel || "";
    let allowAdd = true;
    if (reason === "name") {
      allowAdd = productHasSingleVariant(products, pid) || userSpecifiedVariant(userText, label, String(candidate.variantKey || ""));
    }
    if (!allowAdd) continue;
    const action = buildCartAction(candidate, qty);
    if (action) actions.push(action);
  }
  return actions;
}

function buildCartActionsFromLinks(productLinks, quantity) {
  return productLinks
    .map((link) => buildCartAction(link, quantity))
    .filter(Boolean);
}

function enforceSingleOrdinalCartActions(userText, cartActions) {
  if (cartActions.length <= 1) return cartActions;
  const idx = extractSingleOrdinalIndex(userText, cartActions.length);
  if (idx == null) return cartActions;
  return [cartActions[idx]];
}

function looksLikeSelectionReply(text) {
  const t = String(text || "").toLowerCase();
  return /\b(both|either|all|one|two|three|first|second|third|fourth|fifth|last)\b/.test(t) ||
    /\b\d{1,2}(?:st|nd|rd|th)?\b/.test(t);
}

function resolvePendingChoice(userText, pending, products) {
  if (!pending || pending.type !== "choose_for_cart" || !Array.isArray(pending.options) || !pending.options.length) {
    return { actions: [], pending: null };
  }
  const { candidates } = pickCartCandidates(userText, pending.options, products);
  if (candidates.length) {
    let qty = Number(pending.quantity || 1);
    if (candidates.length >= 2 && wantsMultipleDistinctItems(userText)) qty = 1;
    return { actions: buildCartActionsFromLinks(candidates, qty), pending: null };
  }

  const lower = String(userText || "").toLowerCase();
  const mentionsOption = pending.options.some((option) =>
    (option.name && lower.includes(String(option.name).toLowerCase())) ||
    userSpecifiedVariant(lower, option.variantLabel || "", String(option.variantKey || ""))
  );
  if (looksLikeSelectionReply(userText) || mentionsOption) {
    return { actions: [], pending };
  }
  return { actions: [], pending: null };
}

function buildCartConfirmationMessage(cartActions) {
  if (!cartActions.length) return null;
  const total = cartActions.reduce((sum, action) => sum + Number(action.quantity || 0), 0) || cartActions.length;
  return total === 1 ? "Added to your cart." : `Added ${total} items to your cart.`;
}

function buildPendingFromCandidates(candidates, quantity, reason) {
  return {
    type: "choose_for_cart",
    reason,
    quantity,
    options: candidates.map((p, i) => ({
      index: i + 1,
      id: p.id,
      name: p.name,
      sku: p.sku || null,
      price: p.price,
      optionTypes: getOptionNames(p)
    }))
  };
}

function resolveCartDecision(userText, catalogProducts, pendingInput) {
  const products = toArray(catalogProducts);
  const { actions: pendingActions, pending: pendingResponse } = resolvePendingChoice(userText, pendingInput, products);
  if (pendingActions.length) {
    const finalActions = enforceSingleOrdinalCartActions(userText, pendingActions);
    return {
      message: buildCartConfirmationMessage(finalActions) || "Added to your cart.",
      cart_actions: finalActions,
      pending: null
    };
  }
  if (pendingResponse) {
    return {
      message: "Please choose one of the listed options.",
      cart_actions: [],
      pending: pendingResponse
    };
  }

  const links = findCartCandidates(userText, products);
  const cartActions = buildCartActions(userText, links, products);
  const finalCartActions = enforceSingleOrdinalCartActions(userText, cartActions);

  if (finalCartActions.length) {
    return {
      message: buildCartConfirmationMessage(finalCartActions) || "Added to your cart.",
      cart_actions: finalCartActions,
      pending: null
    };
  }

  if (shouldAddToCart(userText) && links.length > 1) {
    const pending = buildPendingFromCandidates(links, parseQuantity(userText), "Please choose the product type/options before adding to cart.");
    const lines = [pending.reason];
    for (const option of pending.options.slice(0, 4)) {
      const priceText = Number.isFinite(Number(option.price)) ? ` - $${Number(option.price).toFixed(2)}` : "";
      const optionTypeText = option.optionTypes.length ? ` | types: ${option.optionTypes.join(", ")}` : "";
      lines.push(`${option.index}. ${option.name}${priceText}${optionTypeText}`);
    }
    lines.push("Reply with a number (for example, 1 or 2).");
    return {
      message: lines.join("\n"),
      cart_actions: [],
      pending
    };
  }

  if (shouldAddToCart(userText)) {
    return {
      message: "Tell me the product type or exact product name to add to cart.",
      cart_actions: [],
      pending: null
    };
  }

  return {
    message: "No add-to-cart intent detected.",
    cart_actions: [],
    pending: null
  };
}

function runLocalCartTool(args, fallbackUserText, catalogProducts, pendingInput) {
  const userText = String(args?.user_message || fallbackUserText || "");
  const pending = args?.pending && typeof args.pending === "object" ? args.pending : pendingInput;
  const providedCatalog = Array.isArray(args?.catalog_products) ? args.catalog_products : catalogProducts;
  const normalizedCatalog = normalizeCatalogProducts({ products: providedCatalog });
  return resolveCartDecision(userText, normalizedCatalog, pending);
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
    if (firstConvo && !hasUsableCatalog(effectiveCatalog)) {
      writeSse(res, "catalog_fetch", { status: "started" });
      effectiveCatalog = await preloadCatalogData(config, mcpTools, res);
      writeSse(res, "catalog_fetch", {
        status: "completed",
        totalProducts: effectiveCatalog.totalProducts
      });
      writeSse(res, "catalog", effectiveCatalog);
    }

    const allowProductTool =
      !hasUsableCatalog(effectiveCatalog) ||
      body.allowProductLookup === true ||
      body.allow_product_lookup === true;
    const activeTools = allowProductTool ? mcpTools : mcpTools.filter((tool) => !isProductTool(tool));
    const ollamaTools = LOCAL_CART_TOOL_ENABLED
      ? [...toOllamaTools(activeTools), localCartToolDefinition()]
      : toOllamaTools(activeTools);

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
    const latestUserText = getLatestUserMessage(incomingMessages);
    const catalogProducts = normalizeCatalogProducts(effectiveCatalog);
    const pendingInput = body.pending || null;

    writeSse(res, "meta", {
      model: config.ollamaModel,
      tools: activeTools.map((t) => t.name),
      usedCatalogPayload: Boolean(effectiveCatalog),
      firstConvo
    });

    let finalText = "";
    let finalCartActions = [];
    let finalPending = null;
    let correctionAttempts = 0;

    for (let round = 0; round < config.maxToolRounds; round += 1) {
      const modelResponse = await ollamaChatStream({
        baseUrl: config.ollamaBaseUrl,
        model: config.ollamaModel,
        apiKey: config.ollamaApiKey,
        messages: conversation,
        tools: ollamaTools
      });

      const assistantMessage = modelResponse?.message || { role: "assistant", content: "" };
      let assistantText = assistantMessage.content || "";
      const toolCalls = normalizeToolCalls(assistantMessage);

      if (
        hasUsableCatalog(effectiveCatalog) &&
        hasCatalogHallucination(assistantText, catalogProducts) &&
        correctionAttempts < 2
      ) {
        correctionAttempts += 1;
        conversation.push({
          role: "assistant",
          content: assistantText,
          tool_calls: assistantMessage.tool_calls || []
        });
        conversation.push({
          role: "user",
          content:
            "Revise your previous response to only mention products that exist in CATALOG_CONTEXT_JSON. Do not invent any products or prices."
        });
        continue;
      }

      conversation.push({
        role: "assistant",
        content: assistantText,
        tool_calls: assistantMessage.tool_calls || []
      });

      if (assistantText) {
        finalText = assistantText;
        streamTextAsDeltas(res, assistantText, round + 1);
        writeSse(res, "assistant", { text: assistantText, round: round + 1 });
      }

      if (toolCalls.length === 0) {
        break;
      }

      for (const call of toolCalls) {
        let toolResult;
        let safeArgs = call.arguments || {};
        if (LOCAL_CART_TOOL_ENABLED && call.name === LOCAL_CART_TOOL_NAME) {
          safeArgs = {
            user_message: safeArgs.user_message || latestUserText,
            catalog_products: Array.isArray(safeArgs.catalog_products) ? safeArgs.catalog_products : catalogProducts,
            pending: safeArgs.pending || pendingInput,
            message_history: safeArgs.message_history || body.message_history || []
          };
          writeSse(res, "tool_call", { name: call.name, arguments: safeArgs });
          const decision = runLocalCartTool(safeArgs, latestUserText, catalogProducts, pendingInput);
          toolResult = {
            content: [{ type: "text", text: JSON.stringify(decision) }],
            structuredContent: decision
          };
          finalCartActions = Array.isArray(decision.cart_actions) ? decision.cart_actions : [];
          finalPending = decision.pending || null;
          if (decision.message) {
            finalText = decision.message;
          }
        } else {
          const toolDef = getToolByName(activeTools, call.name);
          safeArgs = coerceToolArguments(toolDef, call.arguments || {});
          writeSse(res, "tool_call", { name: call.name, arguments: safeArgs });
          try {
            toolResult = await callMcpTool(config, call.name, safeArgs);
          } catch (error) {
            toolResult = {
              content: [{ type: "text", text: `Tool error: ${error.message}` }],
              isError: true
            };
          }
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
      cart_actions: finalCartActions,
      pending: finalPending,
      ...(firstConvo && effectiveCatalog ? { catalogData: effectiveCatalog } : {})
    });
    res.end();
  } catch (error) {
    writeSse(res, "error", { message: error.message || "Unexpected server error." });
    writeSse(res, "done", { ok: false });
    res.end();
  }
}
