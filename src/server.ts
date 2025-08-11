import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execa } from "execa";
import path from "node:path";
import fs from "node:fs";

type DebugArgs = {
  language: "node" | "python";
  entry?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
};

const server = new McpServer({
  name: "ai-debugger",
  version: "0.1.0",
});

const debugInputSchema = {
  language: z.enum(["node", "python"]).describe("Runtime to use: node | python"),
  entry: z.string().optional().describe("Entry file path (absolute or relative to cwd)"),
  args: z.array(z.string()).optional().describe("Arguments to pass to the program"),
  cwd: z.string().optional().describe("Working directory to run in; defaults to workspace root"),
  timeoutMs: z.number().int().positive().optional().describe("Max execution time in ms; default 15000")
};

server.registerTool(
  "debug",
  {
    title: "Run code and capture stack traces",
    description:
      "Execute a Node.js or Python entry file in a sandboxed child process, returning stdout, stderr, exit code, and parsed error information.",
    inputSchema: debugInputSchema,
  },
  async ({ language, entry, args, cwd, timeoutMs }: DebugArgs) => {
    const workingDir = cwd ? path.resolve(cwd) : process.cwd();
    const entryPath = entry ? path.resolve(workingDir, entry) : undefined;
    const execTimeout = typeof timeoutMs === "number" ? timeoutMs : 15000;

    if (entryPath && !fs.existsSync(entryPath)) {
      return {
        content: [
          { type: "text", text: `Entry file not found: ${entryPath}` },
        ],
        isError: true,
      } as const;
    }

    const command = language === "node" ? "node" : "python3";
    const childArgs = entryPath ? [entryPath, ...(args ?? [])] : ["-V"]; // sanity default when no entry

    try {
      const subprocess = execa(command, childArgs, {
        cwd: workingDir,
        reject: false,
        timeout: execTimeout,
        env: {
          // Minimize side-effects; prevent prompts
          FORCE_COLOR: "0",
          NODE_ENV: process.env.NODE_ENV ?? "production",
          PYTHONUNBUFFERED: "1",
        },
      });

      const { stdout, stderr, exitCode, timedOut } = await subprocess;

      const errorSummary = parseError(stderr);
      const payload = {
        language,
        command: [command, ...childArgs].join(" "),
        cwd: workingDir,
        exitCode: typeof exitCode === "number" ? exitCode : null,
        timedOut: Boolean(timedOut),
        stdout,
        stderr,
        error: errorSummary ?? undefined,
      };

      const text = renderSummary(payload);

      const content: any[] = [
        { type: "text", text },
        { type: "text", text: JSON.stringify(payload, null, 2) },
      ];

      if (entryPath) {
        content.push({
          type: "resource_link",
          uri: pathToFileUri(entryPath),
          name: path.basename(entryPath) || pathToFileUri(entryPath),
          description: "Program entry file",
          mimeType: guessMime(entryPath),
        });
      }
      if (errorSummary?.file) {
        content.push({
          type: "resource_link",
          uri: pathToFileUri(errorSummary.file),
          name: path.basename(errorSummary.file) || pathToFileUri(errorSummary.file),
          description: "Likely error location",
          mimeType: guessMime(errorSummary.file),
        });
      }

      return {
        content,
        isError: exitCode !== 0,
      } as const;
    } catch (err) {
      const error = err as Error;
      const msg = `Failed to execute: ${error.message}`;
      return {
        content: [{ type: "text", text: msg }],
        isError: true,
      } as const;
    }
  }
);

server.registerTool(
  "debug_suggest_fix",
  {
    title: "Suggest code fix from stack trace",
    description:
      "Given a stack trace and code context, structure a suggested fix plan. Typically used after calling debug.",
    inputSchema: {
      stack: z.string().describe("Full stderr or stack trace"),
      fileHints: z.array(z.string()).optional().describe("Paths that likely contain the bug")
    },
  },
  async ({ stack, fileHints }: { stack: string; fileHints?: string[] }) => {
    // This tool returns structured text; the AI in Cursor uses this as context to propose edits.
    const summary = summarizeStack(stack);
    const hints = (fileHints ?? []).map((p) => `- ${p}`).join("\n");
    const text = [
      `Stack summary:\n${summary}`,
      hints ? `Likely files:\n${hints}` : undefined,
      "Provide a minimal, safe edit that resolves the root cause."
    ]
      .filter(Boolean)
      .join("\n\n");
    return { content: [{ type: "text", text }] } as const;
  }
);

function renderSummary(payload: {
  language: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  error?: ReturnType<typeof parseError>;
}): string {
  const parts: string[] = [];
  parts.push(`Command: ${payload.command}`);
  parts.push(`CWD: ${payload.cwd}`);
  parts.push(`Exit: ${payload.exitCode}${payload.timedOut ? " (timed out)" : ""}`);
  if (payload.error) {
    parts.push(`Error: ${payload.error.type}: ${payload.error.message}`);
    if (payload.error.file) parts.push(`File: ${payload.error.file}:${payload.error.line ?? "?"}`);
  }
  if (payload.stdout?.trim()) parts.push(`STDOUT:\n${truncate(payload.stdout, 4000)}`);
  if (payload.stderr?.trim()) parts.push(`STDERR:\n${truncate(payload.stderr, 4000)}`);
  return parts.join("\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 20) + "\n…[truncated]";
}

function parseError(stderr: string | undefined) {
  if (!stderr) return null;
  // Try Node-style stack traces
  const nodeMatch = /^(?<type>[\w.]*Error):\s*(?<message>[^\n]+)\n(?<stack>[\s\S]+)/m.exec(stderr);
  if (nodeMatch?.groups) {
    const { type, message, stack } = nodeMatch.groups as unknown as {
      type: string; message: string; stack: string
    };
    const loc = /(\/[^:\n]+):(\d+):(\d+)/.exec(stack ?? "");
    return {
      runtime: "node" as const,
      type,
      message,
      file: loc?.[1],
      line: loc ? Number(loc[2]) : undefined,
      column: loc ? Number(loc[3]) : undefined,
      stack
    };
  }

  // Try Python traceback
  // Example lines: File "/path/to/file.py", line 10, in <module>
  const pyFile = /File \"([^\"]+)\", line (\d+)/;
  if (/Traceback \(most recent call last\):/m.test(stderr)) {
    const lines = stderr.split("\n");
    let lastFile: string | undefined;
    let lastLine: number | undefined;
    for (const line of lines) {
      const m = pyFile.exec(line);
      if (m) {
        lastFile = m[1];
        lastLine = Number(m[2]);
      }
    }
    const lastLineText = lines.reverse().find((l) => l.trim().length > 0) ?? "";
    const errTypeMsg = /^(?<type>[A-Za-z_][A-Za-z0-9_]*):\s*(?<message>.*)$/.exec(lastLineText)?.groups as
      | { type: string; message: string }
      | undefined;
    return {
      runtime: "python" as const,
      type: errTypeMsg?.type ?? "Error",
      message: errTypeMsg?.message ?? lastLineText,
      file: lastFile,
      line: lastLine,
      stack: stderr,
    };
  }

  return null;
}

function summarizeStack(stack: string): string {
  const firstLine = stack.split("\n").find((l) => l.trim().length > 0) ?? "";
  const node = /^(?<type>[\w.]*Error):\s*(?<message>.*)$/.exec(firstLine)?.groups;
  const py = /^(?<type>[A-Za-z_][A-Za-z0-9_]*):\s*(?<message>.*)$/.exec(firstLine)?.groups;
  if (node?.type) return `${node.type}: ${node.message}`;
  if (py?.type) return `${py.type}: ${py.message}`;
  return firstLine || stack.slice(0, 200);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

function pathToFileUri(p: string): string {
  const absolute = path.resolve(p);
  const prefix = process.platform === "win32" ? "file:///" : "file://";
  return prefix + absolute;
}

function guessMime(p: string): string | undefined {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".ts") return "text/typescript";
  if (ext === ".tsx") return "text/tsx";
  if (ext === ".js") return "text/javascript";
  if (ext === ".jsx") return "text/jsx";
  if (ext === ".py") return "text/x-python";
  if (ext === ".json") return "application/json";
  if (ext === ".md") return "text/markdown";
  return undefined;
}
