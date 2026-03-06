export async function ollamaChat({ baseUrl, model, apiKey, messages, tools, stream = false }) {
  const normalizedBase = normalizeOllamaBaseUrl(baseUrl);
  const endpoint = `${normalizedBase}/api/chat`;
  const headers = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream,
      options: {
        temperature: 0.2
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401) {
      const keyTail = apiKey ? apiKey.slice(-4) : "none";
      const keyLen = apiKey ? apiKey.length : 0;
      throw new Error(
        `Ollama error (401): unauthorized | endpoint=${endpoint} model=${model} key_len=${keyLen} key_tail=${keyTail}`
      );
    }
    throw new Error(`Ollama error (${response.status}): ${text} | endpoint=${endpoint} model=${model}`);
  }

  return response.json();
}

export async function ollamaChatStream({ baseUrl, model, apiKey, messages, tools, onToken }) {
  const normalizedBase = normalizeOllamaBaseUrl(baseUrl);
  const endpoint = `${normalizedBase}/api/chat`;
  const headers = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream: true,
      options: {
        temperature: 0.2
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401) {
      const keyTail = apiKey ? apiKey.slice(-4) : "none";
      const keyLen = apiKey ? apiKey.length : 0;
      throw new Error(
        `Ollama error (401): unauthorized | endpoint=${endpoint} model=${model} key_len=${keyLen} key_tail=${keyTail}`
      );
    }
    throw new Error(`Ollama error (${response.status}): ${text} | endpoint=${endpoint} model=${model}`);
  }

  if (!response.body) {
    throw new Error("Ollama stream error: empty response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let toolCalls = [];
  let role = "assistant";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      let chunk;
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }

      const msg = chunk?.message || {};
      if (typeof msg.role === "string") role = msg.role;

      const delta = typeof msg.content === "string" ? msg.content : "";
      if (delta) {
        content += delta;
        if (typeof onToken === "function") onToken(delta);
      }

      if (Array.isArray(msg.tool_calls)) {
        toolCalls = msg.tool_calls;
      }
    }
  }

  return {
    message: {
      role,
      content,
      tool_calls: toolCalls
    }
  };
}

function normalizeOllamaBaseUrl(baseUrl) {
  const cleaned = String(baseUrl || "").trim().replace(/\/$/, "");
  if (cleaned === "http://ollama.com") {
    return "https://ollama.com";
  }
  return cleaned;
}

export function normalizeToolCalls(message) {
  if (!message || !Array.isArray(message.tool_calls)) return [];

  return message.tool_calls
    .map((call, index) => {
      const fn = call.function || {};
      let args = fn.arguments;

      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = { raw: args };
        }
      }

      if (!args || typeof args !== "object" || Array.isArray(args)) {
        args = {};
      }

      return {
        id: call.id || `tool_${index + 1}`,
        name: fn.name,
        arguments: args
      };
    })
    .filter((call) => Boolean(call.name));
}
