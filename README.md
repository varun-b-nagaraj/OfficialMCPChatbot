# MCP Ecommerce Chatbot API (Vercel)

Single serverless endpoint (`POST /api/chat`) that:
- Uses Ollama as the LLM
- Discovers/calls Zapier MCP tools (Create Order, Find Product, Find Customer, Find Order)
- Streams assistant + tool events via SSE

## 1) Environment Variables

Copy `.env.example` to `.env` and fill values:

- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL`
- `OLLAMA_API_KEY` (only needed when required by your Ollama endpoint)
- `MCP_CONNECT_URL` (optional full URL including `?token=...`)
- `MCP_SERVER_URL` (use `https://mcp.zapier.com/api/v1/connect` if not using `MCP_CONNECT_URL`)
- `MCP_TOKEN` (your Zapier MCP token if not embedded in `MCP_CONNECT_URL`)
- `CORS_ALLOW_ORIGINS` (comma-separated origins allowed to call `/api/chat` from browsers)

## 2) Install + Run

```bash
npm install
vercel dev
```

## 3) API Contract

### Endpoint

`POST /api/chat`

### Request Body

```json
{
  "messages": [
    { "role": "user", "content": "I need a running shoe under $120" }
  ]
}
```

### Response

`text/event-stream` with events:
- `meta`: model + discovered tool names
- `assistant`: assistant response for the current round
- `tool_call`: tool invocation payload
- `tool_result`: tool output text
- `error`: error message
- `done`: completion status

## 4) Frontend Consumption Example

```js
const res = await fetch('/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages })
});

const reader = res.body.getReader();
const decoder = new TextDecoder();

let buffer = '';
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  const chunks = buffer.split('\n\n');
  buffer = chunks.pop() || '';

  for (const chunk of chunks) {
    const eventMatch = chunk.match(/event:\s*(.+)/);
    const dataMatch = chunk.match(/data:\s*(.+)/);
    if (!eventMatch || !dataMatch) continue;

    const event = eventMatch[1].trim();
    const data = JSON.parse(dataMatch[1]);
    console.log(event, data);
  }
}
```

## 5) Deploy To Vercel

- Push repo to GitHub
- Import into Vercel
- Add all env vars in Vercel Project Settings
- Deploy

The endpoint is compatible with Vercel serverless functions and keeps the architecture to one REST API route.
