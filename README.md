# MCP Ecommerce Chatbot API (Vercel)

Single serverless endpoint (`POST /api/chat`) that:
- Uses Ollama as the LLM
- Discovers/calls MCP tools via:
  - Zapier Streamable HTTP MCP, or
  - Local/remote stdio MCP server definitions from `mcp.servers.json`
- Streams assistant + tool events via SSE

## 1) Environment Variables

Copy `.env.example` to `.env` and fill values:

- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL`
- `OLLAMA_API_KEY` (only needed when required by your Ollama endpoint)
- `MCP_CONNECT_URL` (optional full URL including `?token=...`)
- `MCP_SERVER_URL` (use `https://mcp.zapier.com/api/v1/connect` if not using `MCP_CONNECT_URL`)
- `MCP_TOKEN` (your Zapier MCP token if not embedded in `MCP_CONNECT_URL`)
- `MCP_SERVER_CONFIG_PATH` (optional, defaults to `./mcp.servers.json`)
- `MCP_SERVER_NAME` (optional; if set, uses named server from config through stdio transport)

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

## 6) Test With Your `mcpServers` Setup

1. Keep your server config in [mcp.servers.json](/Users/varunbhadurgattenagaraj/Downloads/OfficialMCPChatbot/mcp.servers.json).
2. In `.env`, set:

```env
MCP_SERVER_CONFIG_PATH=./mcp.servers.json
MCP_SERVER_NAME=everything
```

3. Start local server:

```bash
vercel dev
```

4. Send a request:

```bash
curl -N -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"List available tools and help me shop."}]}'
```

To switch MCP backends, only change `MCP_SERVER_NAME` (for local testing) or clear it to use Zapier MCP URL/token mode.
