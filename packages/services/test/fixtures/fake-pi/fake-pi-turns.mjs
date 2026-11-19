// Deterministic fake Pi v1.5.2 turn executor for M1-M4 verification.
import { shortId } from "./fake-pi-session.mjs";
import { buildToolScenarios, runExtensionUiScenario } from "./fake-pi-tools.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function finishAbortedTurn(partialAssistant, assistantContent, toolResultsForTurn, ctx) {
  const abortedAsst = {
    ...partialAssistant,
    content: assistantContent,
    stopReason: "aborted",
    usage: {
      input: 30,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 40,
      cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 },
    },
    timestamp: Date.now(),
  };
  ctx.appendEntry({ type: "message", message: abortedAsst });
  ctx.sendJson({ type: "message_end", message: abortedAsst });
  ctx.sendJson({ type: "turn_end", message: abortedAsst, toolResults: toolResultsForTurn });
  return [abortedAsst];
}

export async function executeTurn(promptText, images, ctx) {
  if (promptText.includes("[crlf]")) {
    ctx.setUseCrlf(true);
  }

  const userContent = [{ type: "text", text: promptText }];
  for (const img of images) {
    if (img && img.type === "image") {
      userContent.push(img);
    }
  }
  const userMsg = {
    role: "user",
    content: userContent,
    timestamp: Date.now(),
  };
  ctx.appendEntry({ type: "message", message: userMsg });

  ctx.sendJson({ type: "turn_start" });
  ctx.sendJson({ type: "message_start", message: userMsg });
  ctx.sendJson({ type: "message_end", message: userMsg });

  const activeModel = ctx.getActiveModel();
  const thinkingLevel = ctx.getThinkingLevel();

  const assistantContent = [];
  const partialAssistant = {
    role: "assistant",
    content: assistantContent,
    api: activeModel.api,
    provider: activeModel.provider,
    model: activeModel.id,
    stopReason: "pending",
    timestamp: Date.now(),
  };
  ctx.sendJson({ type: "message_start", message: partialAssistant });

  let contentIdx = 0;

  // 1. Optional thinking stream (supports [slow:thinking] for >= 1s duration verification)
  if (thinkingLevel !== "off" || promptText.includes("[slow:thinking]")) {
    ctx.sendJson({
      type: "message_update",
      message: partialAssistant,
      assistantMessageEvent: { type: "thinking_start", contentIndex: contentIdx },
    });

    let thought = `Analyzing prompt (${thinkingLevel}): ${promptText.slice(0, 48)}`;
    if (promptText.includes("[slow:thinking]")) {
      const steps = [
        "Step 1: inspecting workspace context. ",
        "Step 2: checking Pi RPC protocol framing. ",
        "Step 3: validating ZCode native render blocks. ",
        "Step 4: preparing concise final answer.",
      ];
      let built = "";
      for (const piece of steps) {
        if (ctx.isAborted()) {
          assistantContent.push({ type: "thinking", thinking: built });
          return finishAbortedTurn(partialAssistant, assistantContent, [], ctx);
        }
        built += piece;
        ctx.sendJson({
          type: "message_update",
          message: partialAssistant,
          assistantMessageEvent: { type: "thinking_delta", contentIndex: contentIdx, delta: piece },
        });
        await sleep(320);
      }
      thought = built;
    } else {
      ctx.sendJson({
        type: "message_update",
        message: partialAssistant,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: contentIdx, delta: thought },
      });
    }

    ctx.sendJson({
      type: "message_update",
      message: partialAssistant,
      assistantMessageEvent: { type: "thinking_end", contentIndex: contentIdx, content: thought },
    });
    assistantContent.push({ type: "thinking", thinking: thought });
    contentIdx += 1;
  }

  // 2. Optional extension UI request trigger
  const uiOutcome = await runExtensionUiScenario(promptText, ctx);
  if (uiOutcome.aborted) {
    return finishAbortedTurn(partialAssistant, assistantContent, [], ctx);
  }
  const uiNote = uiOutcome.uiNote;

  // 3. Optional automatic threshold compaction trigger
  if (promptText.includes("[compact]")) {
    ctx.setCompacting(true);
    ctx.sendJson({ type: "compaction_start", reason: "threshold" });
    const summary = "Compacted earlier conversation context automatically at threshold.";
    const firstKeptEntryId = ctx.getLeafId() ?? shortId();
    const tokensBefore = 120000;
    ctx.appendEntry({ type: "compaction", summary, firstKeptEntryId, tokensBefore });
    const compactResult = { summary, firstKeptEntryId, tokensBefore };
    ctx.setCompacting(false);
    ctx.sendJson({
      type: "compaction_end",
      reason: "threshold",
      result: compactResult,
      aborted: false,
      willRetry: false,
    });
  }

  // 4. Optional single or batch tool execution triggers (matches Pi v1.5.2 JSONL ordering:
  // assistant(stopReason:"toolUse", [thinking?, toolCall...]) -> toolResult[] -> assistant(text)).
  const toolResultsForTurn = [];
  const emittedMessages = [userMsg];
  const toolSpecs = buildToolScenarios(promptText);
  if (toolSpecs.length > 0) {
    const plannedTools = [];
    for (const spec of toolSpecs) {
      if (ctx.isAborted()) {
        return finishAbortedTurn(partialAssistant, assistantContent, toolResultsForTurn, ctx);
      }
      const toolCallId = `call_${shortId()}`;
      const toolCallBlock = {
        type: "toolCall",
        id: toolCallId,
        name: spec.toolName,
        arguments: spec.args,
      };
      ctx.sendJson({
        type: "message_update",
        message: partialAssistant,
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: contentIdx,
          id: toolCallId,
          toolName: spec.toolName,
        },
      });
      const argsJson = JSON.stringify(spec.args);
      const argsMid = Math.max(1, Math.floor(argsJson.length / 2));
      ctx.sendJson({
        type: "message_update",
        message: partialAssistant,
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: contentIdx,
          delta: argsJson.slice(0, argsMid),
        },
      });
      ctx.sendJson({
        type: "message_update",
        message: partialAssistant,
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: contentIdx,
          delta: argsJson.slice(argsMid),
        },
      });
      ctx.sendJson({
        type: "message_update",
        message: partialAssistant,
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: contentIdx,
          toolCall: toolCallBlock,
        },
      });
      assistantContent.push(toolCallBlock);
      contentIdx += 1;
      plannedTools.push({ spec, toolCallId });
    }

    const toolUseAsst = {
      ...partialAssistant,
      content: [...assistantContent],
      stopReason: "toolUse",
      usage: {
        input: 120,
        output: 40,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 160,
        cost: { input: 0.00036, output: 0.0006, cacheRead: 0, cacheWrite: 0, total: 0.00096 },
      },
      timestamp: Date.now(),
    };
    ctx.appendEntry({ type: "message", message: toolUseAsst });
    ctx.sendJson({ type: "message_end", message: toolUseAsst });
    emittedMessages.push(toolUseAsst);

    for (const { spec, toolCallId } of plannedTools) {
      if (ctx.isAborted()) {
        return finishAbortedTurn(partialAssistant, [], toolResultsForTurn, ctx);
      }
      ctx.sendJson({
        type: "tool_execution_start",
        toolCallId,
        toolName: spec.toolName,
        args: spec.args,
      });
      ctx.sendJson({
        type: "tool_execution_update",
        toolCallId,
        toolName: spec.toolName,
        args: spec.args,
        partialResult: { content: [{ type: "text", text: spec.partialOut }], details: {} },
      });
      ctx.sendJson({
        type: "tool_execution_end",
        toolCallId,
        toolName: spec.toolName,
        result: { content: [{ type: "text", text: spec.finalOut }], details: spec.details },
        isError: spec.isError,
        durationMs: spec.durationMs,
      });

      const trMsg = {
        role: "toolResult",
        toolCallId,
        toolName: spec.toolName,
        content: [{ type: "text", text: spec.finalOut }],
        details: spec.details,
        isError: spec.isError,
        timestamp: Date.now(),
      };
      ctx.appendEntry({ type: "message", message: trMsg });
      toolResultsForTurn.push(trMsg);
      emittedMessages.push(trMsg);
    }

    // Start the follow-up assistant text message after tool results complete.
    assistantContent.length = 0;
    contentIdx = 0;
    partialAssistant.timestamp = Date.now();
    ctx.sendJson({ type: "message_start", message: partialAssistant });
  }

  // 5. Error trigger
  if (promptText.includes("[error]")) {
    const errAsst = {
      ...partialAssistant,
      content: assistantContent,
      stopReason: "error",
      errorMessage: "Simulated model error",
      usage: {
        input: 20,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 25,
        cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 },
      },
      timestamp: Date.now(),
    };
    ctx.appendEntry({ type: "message", message: errAsst });
    ctx.sendJson({ type: "message_end", message: errAsst });
    ctx.sendJson({ type: "turn_end", message: errAsst, toolResults: toolResultsForTurn });
    return [...emittedMessages, errAsst];
  }

  // 6. Slow streaming or normal text streaming
  let replyText = `Fake Pi reply to: ${promptText}${uiNote}`;
  if (promptText.includes("[render:svg-html]")) {
    replyText = [
      "下面是一张结构图、流程图与交互网页示例：",
      "",
      "```svg",
      '<svg viewBox="0 0 180 48"><rect width="180" height="48" rx="8" fill="var(--accent)"/><text x="16" y="29" fill="var(--fg)">流程图</text></svg>',
      "```",
      "",
      "```mermaid",
      "flowchart LR",
      "  A[开始] --> B[完成]",
      "```",
      "",
      "```html",
      "<!DOCTYPE html><html><head><title>交互式演示页</title></head><body><h1>Hello Artifact</h1></body></html>",
      "```",
    ].join("\n");
  } else if (promptText.includes("[unicode]")) {
    replyText += " \u2028line-sep\u2029para-sep";
  }

  ctx.sendJson({
    type: "message_update",
    message: partialAssistant,
    assistantMessageEvent: { type: "text_start", contentIndex: contentIdx },
  });

  if (promptText.includes("[slow]") && !promptText.includes("[slow:thinking]")) {
    let accumulated = "";
    for (let step = 1; step <= 10; step += 1) {
      if (ctx.isAborted()) {
        assistantContent.push({ type: "text", text: accumulated });
        return finishAbortedTurn(partialAssistant, assistantContent, toolResultsForTurn, ctx);
      }
      const chunk = `chunk-${step} `;
      accumulated += chunk;
      ctx.sendJson({
        type: "message_update",
        message: partialAssistant,
        assistantMessageEvent: { type: "text_delta", contentIndex: contentIdx, delta: chunk },
      });
      await sleep(200);
    }
    replyText = accumulated.trim();
  } else {
    const mid = Math.max(1, Math.floor(replyText.length / 2));
    const d1 = replyText.slice(0, mid);
    const d2 = replyText.slice(mid);
    ctx.sendJson({
      type: "message_update",
      message: partialAssistant,
      assistantMessageEvent: { type: "text_delta", contentIndex: contentIdx, delta: d1 },
    });
    if (d2) {
      ctx.sendJson({
        type: "message_update",
        message: partialAssistant,
        assistantMessageEvent: { type: "text_delta", contentIndex: contentIdx, delta: d2 },
      });
    }
  }

  ctx.sendJson({
    type: "message_update",
    message: partialAssistant,
    assistantMessageEvent: { type: "text_end", contentIndex: contentIdx, content: replyText },
  });
  assistantContent.push({ type: "text", text: replyText });

  const finalAsst = {
    ...partialAssistant,
    content: assistantContent,
    stopReason: "stop",
    usage: {
      input: 220,
      output: 80,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 300,
      cost: { input: 0.00066, output: 0.0012, cacheRead: 0, cacheWrite: 0, total: 0.00186 },
    },
    timestamp: Date.now(),
  };
  ctx.appendEntry({ type: "message", message: finalAsst });
  ctx.sendJson({ type: "message_end", message: finalAsst });
  ctx.sendJson({ type: "turn_end", message: finalAsst, toolResults: toolResultsForTurn });
  return [...emittedMessages, finalAsst];
}
