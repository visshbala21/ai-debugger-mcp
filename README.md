AI-Driven Code Debugger MCP Server

- Tools:
  - debug: run Node/Python entry, capture stdout/stderr, exit code, and parse stack traces
  - debug_suggest_fix: summarize a stack trace and list likely files

Usage
- Install: npm install
- Build: npm run build
- Start (stdio): npm start

Cursor config (.cursor/mcp.json)
```
{
  "mcpServers": {
    "ai-debugger": {
      "command": "node",
      "args": ["/Users/visshwabalasubramanian/MCPexp/dist/server.js"]
    }
  }
}
```

Security: Uses child processes with a timeout; not a full sandbox. Avoid untrusted code.


