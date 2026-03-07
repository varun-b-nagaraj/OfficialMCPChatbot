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
  "10) For cart operations, return structured cart action intent to the client layer and ask for product type/options when selection is ambiguous.",
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
    "under", "below", "less", "than", "price", "for", "with", "and", "or", "the", "a", "an"
  ]);
  return normalizeName(text)
    .split(" ")
    .filter((t) => t && !stop.has(t) && Number.isNaN(Number(t)));
}

function isShoppingBrowseIntent(text) {
  const t = String(text || "").toLowerCase();
  return /(show|find|list|recommend|suggest|shop|what.*have|products?)/.test(t);
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

function looksLikeAddToCartIntent(text) {
  const t = String(text || "").toLowerCase();
  return /\b(add|put|place|throw|toss)\b/.test(t) && /\b(cart|bag)\b/.test(t);
}

function parseQuantity(text) {
  const t = String(text || "").toLowerCase();
  const match = t.match(/\b(\d{1,2})\s*(x|qty|quantity)?\b/);
  if (!match) return 1;
  const qty = Number(match[1]);
  if (!Number.isFinite(qty)) return 1;
  return Math.max(1, Math.min(20, qty));
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

function userSpecifiedOptionType(userText, product) {
  const t = normalizeName(userText);
  if (!t) return false;
  for (const n of getOptionNames(product)) {
    const normalized = normalizeName(n);
    if (normalized && t.includes(normalized)) return true;
  }
  return false;
}

function ordinalIndex(text) {
  const t = String(text || "").toLowerCase();
  if (/\bfirst\b/.test(t)) return 0;
  if (/\bsecond\b/.test(t)) return 1;
  if (/\bthird\b/.test(t)) return 2;
  if (/\bfourth\b/.test(t)) return 3;
  if (/\blast\b/.test(t)) return -1;
  const m = t.match(/\b(\d+)\b/);
  if (m) {
    const n = Number(m[1]) - 1;
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function resolvePendingSelection(pending, userText) {
  if (!pending || pending.type !== "choose_for_cart" || !Array.isArray(pending.options)) return null;
  if (!pending.options.length) return null;
  const idx = ordinalIndex(userText);
  if (idx == null) return null;
  const chosen = idx === -1 ? pending.options[pending.options.length - 1] : pending.options[idx];
  return chosen || null;
}

function buildCartAction(product, quantity) {
  if (!product || !Number.isFinite(Number(product.id))) return null;
  return {
    type: "cart.add",
    product: {
      id: Number(product.id),
      quantity,
      options: {},
      sku: product.sku || null,
      name: product.name || null
    }
  };
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
    const latestUserText = getLatestUserMessage(incomingMessages);
    const catalogProducts = normalizeCatalogProducts(effectiveCatalog);
    const pendingInput = body.pending || null;

    writeSse(res, "meta", {
      model: config.ollamaModel,
      tools: activeTools.map((t) => t.name),
      usedCatalogPayload: Boolean(effectiveCatalog),
      firstConvo
    });

    if (effectiveCatalog && looksLikeAddToCartIntent(latestUserText)) {
      const quantity = parseQuantity(latestUserText);
      const pendingChoice = resolvePendingSelection(pendingInput, latestUserText);
      if (pendingChoice) {
        const action = buildCartAction(pendingChoice, quantity);
        if (action) {
          const confirmation = `Added ${pendingChoice.name} to your cart.`;
          streamTextAsDeltas(res, confirmation, 1);
          writeSse(res, "assistant", { text: confirmation, round: 1 });
          writeSse(res, "done", {
            ok: true,
            message: confirmation,
            cart_actions: [action],
            pending: null,
            ...(firstConvo ? { catalogData: effectiveCatalog } : {})
          });
          res.end();
          return;
        }
      }

      const candidates = findCartCandidates(latestUserText, catalogProducts);
      if (!candidates.length) {
        const noMatch = "I could not find that product in the enabled catalog. Tell me the product type or exact name.";
        streamTextAsDeltas(res, noMatch, 1);
        writeSse(res, "assistant", { text: noMatch, round: 1 });
        writeSse(res, "done", {
          ok: true,
          message: noMatch,
          cart_actions: [],
          pending: null,
          ...(firstConvo ? { catalogData: effectiveCatalog } : {})
        });
        res.end();
        return;
      }

      const best = candidates[0];
      const multiple = candidates.length > 1;
      const requiresType = getOptionNames(best).length > 0 && !userSpecifiedOptionType(latestUserText, best);

      if (multiple || requiresType || !Number.isFinite(Number(best.id))) {
        const reason = requiresType
          ? "Please choose the product type/options before adding to cart."
          : "Please choose which product you want to add.";
        const pending = buildPendingFromCandidates(candidates, quantity, reason);
        const lines = [reason];
        for (const option of pending.options.slice(0, 4)) {
          const priceText = Number.isFinite(Number(option.price)) ? ` - $${Number(option.price).toFixed(2)}` : "";
          const optionTypeText = option.optionTypes.length ? ` | types: ${option.optionTypes.join(", ")}` : "";
          lines.push(`${option.index}. ${option.name}${priceText}${optionTypeText}`);
        }
        lines.push("Reply with the number (for example, 1 or 2).");
        const prompt = lines.join("\n");
        streamTextAsDeltas(res, prompt, 1);
        writeSse(res, "assistant", { text: prompt, round: 1 });
        writeSse(res, "done", {
          ok: true,
          message: prompt,
          cart_actions: [],
          pending,
          ...(firstConvo ? { catalogData: effectiveCatalog } : {})
        });
        res.end();
        return;
      }

      const action = buildCartAction(best, quantity);
      if (action) {
        const confirmation = `Added ${best.name} to your cart.`;
        streamTextAsDeltas(res, confirmation, 1);
        writeSse(res, "assistant", { text: confirmation, round: 1 });
        writeSse(res, "done", {
          ok: true,
          message: confirmation,
          cart_actions: [action],
          pending: null,
          ...(firstConvo ? { catalogData: effectiveCatalog } : {})
        });
        res.end();
        return;
      }
    }

    if (effectiveCatalog && !allowProductTool && isShoppingBrowseIntent(latestUserText)) {
      const deterministic = formatCatalogRecommendation(latestUserText, catalogProducts);
      streamTextAsDeltas(res, deterministic, 1);
      writeSse(res, "assistant", { text: deterministic, round: 1 });
      writeSse(res, "done", {
        ok: true,
        message: deterministic,
        cart_actions: [],
        pending: null,
        ...(firstConvo ? { catalogData: effectiveCatalog } : {})
      });
      res.end();
      return;
    }

    let finalText = "";

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

      if (effectiveCatalog && !allowProductTool && hasCatalogHallucination(assistantText, catalogProducts)) {
        assistantText = formatCatalogRecommendation(latestUserText || assistantText, catalogProducts);
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
      cart_actions: [],
      pending: null,
      ...(firstConvo && effectiveCatalog ? { catalogData: effectiveCatalog } : {})
    });
    res.end();
  } catch (error) {
    writeSse(res, "error", { message: error.message || "Unexpected server error." });
    writeSse(res, "done", { ok: false });
    res.end();
  }
}
