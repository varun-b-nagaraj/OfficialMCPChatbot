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
  "6) Be honest about what you know; use tools for product/order/customer lookups or order creation.",
  "7) When creating an order, confirm critical fields before finalizing.",
  "Behavior:",
  "- Default to action over questions. Do not interrogate the shopper.",
  "- For generic shopping intents, call product tools first and present a curated list immediately.",
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
    const incomingMessages = sanitizeIncomingMessages(body.messages);

    if (incomingMessages.length === 0) {
      writeSse(res, "error", { message: "Request must include messages[]." });
      writeSse(res, "done", { ok: false });
      res.end();
      return;
    }

    const mcpTools = await listMcpTools(config);
    const ollamaTools = toOllamaTools(mcpTools);

    const conversation = [
      { role: "system", content: SALES_SYSTEM_PROMPT },
      ...incomingMessages
    ];

    writeSse(res, "meta", {
      model: config.ollamaModel,
      tools: mcpTools.map((t) => t.name)
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
        writeSse(res, "tool_call", { name: call.name, arguments: call.arguments });

        let toolResult;
        try {
          toolResult = await callMcpTool(config, call.name, call.arguments);
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
      message: finalText
    });
    res.end();
  } catch (error) {
    writeSse(res, "error", { message: error.message || "Unexpected server error." });
    writeSse(res, "done", { ok: false });
    res.end();
  }
}
