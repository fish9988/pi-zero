// Deterministic tool & extension UI scenario builders for fake-pi.mjs.
import { shortId } from "./fake-pi-session.mjs";

const EDIT_SAMPLE_DIFF = ["1 - const a = 1;", "1 + const a = 2;", "2 + const b = 3;"].join("\n");

const EDIT_SAMPLE_PATCH = [
  "@@ -1,1 +1,2 @@",
  "-const a = 1;",
  "+const a = 2;",
  "+const b = 3;",
].join("\n");

export function buildToolScenarios(promptText) {
  const lowerPrompt = promptText.toLowerCase();

  if (promptText.includes("[tools:all]") || promptText.includes("[tools:batch]")) {
    return [
      {
        toolName: "read",
        args: { path: "src/agent-runtime.ts", offset: 1, limit: 80 },
        partialOut: "export const runtime = 'pi';\n",
        finalOut: "export const runtime = 'pi';\nexport const version = '1.5.2';\n",
        details: {},
        isError: false,
        durationMs: 18,
      },
      {
        toolName: "read",
        args: { path: "package.json" },
        partialOut: '{ "name": "zcode" }\n',
        finalOut: '{ "name": "zcode", "version": "3.18.8" }\n',
        details: {},
        isError: false,
        durationMs: 12,
      },
      {
        toolName: "grep",
        args: { pattern: "PiRpcClient", path: "src" },
        partialOut: "src/pi-runtime/adapters/piRpcClient.ts:42\n",
        finalOut: "src/pi-runtime/adapters/piRpcClient.ts:42:export class PiRpcClient\n",
        details: {},
        isError: false,
        durationMs: 24,
      },
      {
        toolName: "find",
        args: { pattern: "*.ts", path: "src" },
        partialOut: "src/agent-runtime.ts\n",
        finalOut: "src/agent-runtime.ts\nsrc/app.ts\n",
        details: {},
        isError: false,
        durationMs: 15,
      },
      {
        toolName: "ls",
        args: { path: "src" },
        partialOut: "agent-runtime.ts\napp.ts\n",
        finalOut: "agent-runtime.ts\napp.ts\npi-runtime/\n",
        details: {},
        isError: false,
        durationMs: 9,
      },
      {
        toolName: "write",
        args: { path: "src/new-file.ts", content: "export const created = true;\n" },
        partialOut: "Writing src/new-file.ts...",
        finalOut: "Successfully wrote 29 bytes to src/new-file.ts",
        details: {},
        isError: false,
        durationMs: 21,
      },
      {
        toolName: "edit",
        args: {
          path: "src/app.ts",
          edits: [{ oldText: "const a = 1;\n", newText: "const a = 2;\nconst b = 3;\n" }],
        },
        partialOut: "Applying edit...",
        finalOut: "Successfully replaced text in src/app.ts.",
        details: {
          diff: EDIT_SAMPLE_DIFF,
          patch: EDIT_SAMPLE_PATCH,
          firstChangedLine: 1,
        },
        isError: false,
        durationMs: 28,
      },
      {
        toolName: "bash",
        args: { command: "pnpm typecheck" },
        partialOut: "Running tsc -b...\n",
        finalOut: "Running tsc -b...\nDone in 1.2s\n",
        details: { exitCode: 0 },
        isError: false,
        durationMs: 64,
      },
      {
        toolName: "bash",
        args: { command: "git status" },
        partialOut: "On branch feat/pi-runtime\n",
        finalOut: "On branch feat/pi-runtime\nnothing to commit, working tree clean\n",
        details: { exitCode: 0 },
        isError: false,
        durationMs: 31,
      },
    ];
  }

  if (promptText.includes("[mcp]")) {
    return [
      {
        toolName: "mcp__exa__web_search_exa",
        args: { query: "Pi coding agent RPC protocol v1.5.2", numResults: 2 },
        partialOut: "Searching Exa web index...",
        finalOut: JSON.stringify(
          {
            results: [
              {
                title: "Pi Coding Agent v1.5.2 RPC Protocol",
                url: "https://example.com/pi-rpc",
                snippet: "JSONL RPC protocol with streaming tool execution and extension UI.",
              },
            ],
          },
          null,
          2,
        ),
        details: {},
        isError: false,
        durationMs: 48,
      },
    ];
  }

  if (promptText.includes("[tool:error]")) {
    return [
      {
        toolName: "bash",
        args: { command: "false" },
        partialOut: "Running failing command...\n",
        finalOut: "Command exited with code 1\n",
        details: { exitCode: 1 },
        isError: true,
        durationMs: 35,
      },
    ];
  }

  if (promptText.includes("[edit:legacy]")) {
    return [
      {
        toolName: "edit",
        args: {
          path: "src/app.ts",
          oldText: "const a = 1;\n",
          newText: "const a = 2;\nconst b = 3;\n",
        },
        partialOut: "Applying edit...",
        finalOut: "Updated src/app.ts",
        details: { diff: EDIT_SAMPLE_DIFF, patch: EDIT_SAMPLE_PATCH, firstChangedLine: 1 },
        isError: false,
        durationMs: 42,
      },
    ];
  }

  if (promptText.includes("[edit]")) {
    return [
      {
        toolName: "edit",
        args: {
          path: "src/app.ts",
          edits: [{ oldText: "const a = 1;\n", newText: "const a = 2;\nconst b = 3;\n" }],
        },
        partialOut: "Applying edit...",
        finalOut: "Successfully replaced text in src/app.ts.",
        details: { diff: EDIT_SAMPLE_DIFF, patch: EDIT_SAMPLE_PATCH, firstChangedLine: 1 },
        isError: false,
        durationMs: 42,
      },
    ];
  }

  if (promptText.includes("[bash]")) {
    return [
      {
        toolName: "bash",
        args: { command: "echo hello" },
        partialOut: "hel",
        finalOut: "hello\n",
        details: { exitCode: 0 },
        isError: false,
        durationMs: 42,
      },
    ];
  }

  if (promptText.includes("[tool]") || lowerPrompt.includes("read file")) {
    return [
      {
        toolName: "read",
        args: { path: "README.md" },
        partialOut: "# Project\n",
        finalOut: "# Project\nLine 2\n",
        details: {},
        isError: false,
        durationMs: 42,
      },
    ];
  }

  return [];
}

export async function runExtensionUiScenario(promptText, ctx) {
  if (!promptText.includes("[ask") && !promptText.includes("[confirm]")) {
    return { aborted: false, uiNote: "" };
  }

  const reqId = `ui_${shortId()}`;
  if (promptText.includes("[ask:plan]")) {
    ctx.sendJson({
      type: "extension_ui_request",
      id: reqId,
      method: "select",
      title: "方案选择: 请选择实现方式",
      options: ["1. 方案 A — 保持现状", "2. 方案 B — 精简重构", "3. Other (free-form)"],
    });
  } else if (promptText.includes("[ask:select]")) {
    ctx.sendJson({
      type: "extension_ui_request",
      id: reqId,
      method: "select",
      title: "Pick target",
      options: ["Option A", "Option B"],
    });
  } else if (promptText.includes("[ask:input]")) {
    ctx.sendJson({
      type: "extension_ui_request",
      id: reqId,
      method: "input",
      title: "Enter name",
      placeholder: "Type here",
    });
  } else if (promptText.includes("[ask:editor]")) {
    ctx.sendJson({
      type: "extension_ui_request",
      id: reqId,
      method: "editor",
      title: "Edit note",
      prefill: "initial",
    });
  } else {
    ctx.sendJson({
      type: "extension_ui_request",
      id: reqId,
      method: "confirm",
      title: "Confirm action",
      message: "Proceed?",
    });
  }

  const uiResp = await ctx.waitForExtensionUiResponse(reqId);
  if (ctx.isAborted()) {
    return { aborted: true, uiNote: "" };
  }
  if (uiResp.cancelled) {
    return { aborted: false, uiNote: " [UI cancelled]" };
  }
  if (typeof uiResp.confirmed === "boolean") {
    return { aborted: false, uiNote: uiResp.confirmed ? " [UI confirmed]" : " [UI denied]" };
  }
  if (typeof uiResp.value === "string") {
    if (promptText.includes("[ask:plan]") && uiResp.value === "3. Other (free-form)") {
      const edReqId = `ui_${shortId()}`;
      ctx.sendJson({
        type: "extension_ui_request",
        id: edReqId,
        method: "editor",
        title: "请选择实现方式",
        placeholder: "请输入自定义方案",
      });
      const edResp = await ctx.waitForExtensionUiResponse(edReqId);
      if (ctx.isAborted()) return { aborted: true, uiNote: "" };
      if (edResp.cancelled) return { aborted: false, uiNote: " [UI cancelled]" };
      if (typeof edResp.value === "string") {
        return { aborted: false, uiNote: ` [UI value: ${edResp.value}]` };
      }
    }
    return { aborted: false, uiNote: ` [UI value: ${uiResp.value}]` };
  }
  return { aborted: false, uiNote: "" };
}
