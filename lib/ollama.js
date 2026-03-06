export async function ollamaChat({ baseUrl, model, apiKey, messages, tools, stream = false }) {
  const endpoint = `${baseUrl}/api/chat`;
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
    throw new Error(`Ollama error (${response.status}): ${text}`);
  }

  return response.json();
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
