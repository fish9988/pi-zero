// RPC command dispatcher for fake-pi.mjs (Pi v1.5.2 wire parity).
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  FAKE_PI_COMMANDS,
  FAKE_PI_MODELS,
  FAKE_PI_REASONING_LEVELS,
  extractMsgText,
  shortId,
  writeHtmlExport,
} from "./fake-pi-session.mjs";

export function createRpcCommandHandler(runtime) {
  const {
    opts,
    cwd,
    state,
    session,
    sendJson,
    sendResponse,
    emitQueueUpdate,
    runCoalescedPrompt,
    runAgentLoop,
  } = runtime;

  return function handleCommand(cmd) {
    const { id, type } = cmd;

    switch (type) {
      case "get_state": {
        const activeMsgs = session.getActiveMessages();
        sendResponse(id, type, true, {
          model: state.activeModel,
          thinkingLevel: state.thinkingLevel,
          isStreaming: state.isStreaming,
          isCompacting: state.isCompacting,
          steeringMode: state.steeringMode,
          followUpMode: state.followUpMode,
          sessionFile: session.store.sessionFile,
          sessionId: session.store.sessionId,
          ...(session.store.sessionName !== undefined
            ? { sessionName: session.store.sessionName }
            : {}),
          autoCompactionEnabled: state.autoCompactionEnabled,
          messageCount: activeMsgs.length,
          pendingMessageCount: state.steeringQueue.length + state.followUpQueue.length,
        });
        break;
      }

      case "get_messages": {
        sendResponse(id, type, true, { messages: session.getActiveMessages() });
        break;
      }

      case "get_available_models": {
        sendResponse(id, type, true, { models: FAKE_PI_MODELS });
        break;
      }

      case "get_available_thinking_levels": {
        const prov = cmd.provider ?? state.activeModel.provider;
        const modId = cmd.modelId ?? state.activeModel.id;
        const target =
          FAKE_PI_MODELS.find((model) => model.provider === prov && model.id === modId) ??
          state.activeModel;
        const levels = target.reasoning ? FAKE_PI_REASONING_LEVELS : ["off"];
        sendResponse(id, type, true, { provider: target.provider, modelId: target.id, levels });
        break;
      }

      case "set_model": {
        const found = FAKE_PI_MODELS.find(
          (model) => model.provider === cmd.provider && model.id === cmd.modelId,
        );
        if (!found) {
          sendResponse(
            id,
            type,
            false,
            undefined,
            `Model not found: ${String(cmd.provider)}/${String(cmd.modelId)}`,
          );
          return;
        }
        state.activeModel = found;
        if (!state.activeModel.reasoning && state.thinkingLevel !== "off") {
          state.thinkingLevel = "off";
          sendJson({ type: "thinking_level_changed", level: "off" });
        }
        sendResponse(id, type, true, state.activeModel);
        break;
      }

      case "cycle_model": {
        const idx = FAKE_PI_MODELS.findIndex(
          (model) =>
            model.provider === state.activeModel.provider && model.id === state.activeModel.id,
        );
        const step = cmd.direction === "backward" ? -1 : 1;
        const nextIdx =
          ((idx < 0 ? 0 : idx) + step + FAKE_PI_MODELS.length) % FAKE_PI_MODELS.length;
        state.activeModel = FAKE_PI_MODELS[nextIdx];
        if (!state.activeModel.reasoning) state.thinkingLevel = "off";
        sendResponse(id, type, true, {
          model: state.activeModel,
          thinkingLevel: state.thinkingLevel,
          isScoped: false,
        });
        break;
      }

      case "set_thinking_level": {
        const requested = String(cmd.level ?? "off");
        if (!FAKE_PI_REASONING_LEVELS.includes(requested)) {
          sendResponse(id, type, false, undefined, `Invalid thinking level: ${requested}`);
          return;
        }
        state.thinkingLevel = state.activeModel.reasoning ? requested : "off";
        sendJson({ type: "thinking_level_changed", level: state.thinkingLevel });
        sendResponse(id, type, true);
        break;
      }

      case "cycle_thinking_level": {
        const levels = state.activeModel.reasoning ? FAKE_PI_REASONING_LEVELS : ["off"];
        const curIdx = levels.indexOf(state.thinkingLevel);
        state.thinkingLevel = levels[(curIdx + 1) % levels.length];
        sendJson({ type: "thinking_level_changed", level: state.thinkingLevel });
        sendResponse(id, type, true, { level: state.thinkingLevel });
        break;
      }

      case "get_commands": {
        sendResponse(id, type, true, { commands: FAKE_PI_COMMANDS });
        break;
      }

      case "get_session_stats": {
        sendResponse(id, type, true, session.computeStats(state.activeModel));
        break;
      }

      case "set_session_name": {
        const nextName = String(cmd.name ?? "").trim();
        session.store.sessionName = nextName !== "" ? nextName : undefined;
        session.appendEntry({ type: "session_info", name: nextName });
        sendJson({
          type: "session_info_changed",
          ...(session.store.sessionName ? { name: session.store.sessionName } : {}),
        });
        sendResponse(id, type, true, {});
        break;
      }

      case "set_auto_compaction": {
        state.autoCompactionEnabled = Boolean(cmd.enabled);
        sendResponse(id, type, true, {});
        break;
      }

      case "set_steering_mode": {
        state.steeringMode = cmd.mode === "all" ? "all" : "one-at-a-time";
        sendResponse(id, type, true, {});
        break;
      }

      case "set_follow_up_mode": {
        state.followUpMode = cmd.mode === "all" ? "all" : "one-at-a-time";
        sendResponse(id, type, true, {});
        break;
      }

      case "compact": {
        state.isCompacting = true;
        sendJson({ type: "compaction_start", reason: "manual" });
        const summary = cmd.customInstructions
          ? `Compacted context (${String(cmd.customInstructions)})`
          : "Compacted earlier conversation context.";
        const firstKeptEntryId = session.store.leafId ?? shortId();
        const tokensBefore = Math.max(1024, session.computeStats(state.activeModel).tokens.total);
        session.appendEntry({ type: "compaction", summary, firstKeptEntryId, tokensBefore });
        state.isCompacting = false;
        const result = { summary, firstKeptEntryId, tokensBefore };
        sendJson({
          type: "compaction_end",
          reason: "manual",
          result,
          aborted: false,
          willRetry: false,
        });
        sendResponse(id, type, true, result);
        break;
      }

      case "new_session": {
        if (!opts.noSession) {
          session.createFreshSessionFile(cmd.parentSession);
        } else {
          session.store.sessionId = randomUUID();
          session.store.entries = [];
          session.store.leafId = null;
        }
        session.store.sessionName = undefined;
        sendResponse(id, type, true, { cancelled: false });
        break;
      }

      case "switch_session": {
        const targetPath = String(cmd.sessionPath ?? "");
        if (!targetPath) {
          sendResponse(id, type, false, undefined, "sessionPath is required");
          return;
        }
        const shutdown = session.shutdownEntry();
        if (existsSync(targetPath)) {
          session.loadSessionFromDisk(targetPath);
        } else {
          mkdirSync(path.dirname(path.resolve(targetPath)), { recursive: true });
          session.store.sessionFile = path.resolve(targetPath);
          session.store.sessionId = randomUUID();
          session.store.entries = [];
          session.store.leafId = null;
          const header = {
            type: "session",
            version: 3,
            id: session.store.sessionId,
            timestamp: new Date().toISOString(),
            cwd,
          };
          writeFileSync(session.store.sessionFile, `${JSON.stringify(header)}\n`, "utf8");
        }
        if (shutdown) appendFileSync(shutdown.file, `${JSON.stringify(shutdown.entry)}\n`, "utf8");
        sendResponse(id, type, true, { cancelled: false });
        break;
      }

      case "fork": {
        const targetId = String(cmd.entryId ?? "");
        const byId = new Map(session.store.entries.map((entry) => [entry.id, entry]));
        const targetEntry = byId.get(targetId);
        if (
          !targetEntry ||
          targetEntry.type !== "message" ||
          targetEntry.message?.role !== "user"
        ) {
          sendResponse(id, type, false, undefined, `Invalid fork entryId: ${targetId}`);
          return;
        }
        const selectedText = extractMsgText(targetEntry.message.content);
        const kept = [];
        let cur = targetEntry.parentId ?? null;
        while (cur) {
          const item = byId.get(cur);
          if (!item) break;
          kept.push(item);
          cur = item.parentId ?? null;
        }
        kept.reverse();

        const oldFile = session.store.sessionFile;
        if (!opts.noSession) {
          session.createFreshSessionFile(oldFile);
          for (const item of kept) {
            session.store.entries.push(item);
            appendFileSync(session.store.sessionFile, `${JSON.stringify(item)}\n`, "utf8");
          }
        } else {
          session.store.entries = [...kept];
        }
        session.store.leafId = kept.length > 0 ? kept[kept.length - 1].id : null;
        sendResponse(id, type, true, { text: selectedText, cancelled: false });
        break;
      }

      case "clone": {
        const snapshotEntries = session.getActiveBranchEntries();
        const oldFile = session.store.sessionFile;
        if (!opts.noSession) {
          session.createFreshSessionFile(oldFile);
          for (const item of snapshotEntries) {
            session.store.entries.push(item);
            appendFileSync(session.store.sessionFile, `${JSON.stringify(item)}\n`, "utf8");
          }
        }
        session.store.leafId =
          snapshotEntries.length > 0 ? snapshotEntries[snapshotEntries.length - 1].id : null;
        sendResponse(id, type, true, { cancelled: false });
        break;
      }

      case "get_fork_messages": {
        const userForks = session
          .getActiveBranchEntries()
          .filter((entry) => entry.type === "message" && entry.message?.role === "user")
          .map((entry) => ({
            entryId: entry.id,
            text: extractMsgText(entry.message.content),
          }));
        sendResponse(id, type, true, { messages: userForks });
        break;
      }

      case "get_tree": {
        sendResponse(id, type, true, {
          tree: session.buildTreeNodes(),
          leafId: session.store.leafId,
        });
        break;
      }

      case "get_entries": {
        const sinceId = typeof cmd.since === "string" ? cmd.since : undefined;
        sendResponse(id, type, true, {
          entries: session.getEntriesSince(sinceId),
          leafId: session.store.leafId,
        });
        break;
      }

      case "get_last_assistant_text": {
        const msgs = session.getActiveMessages();
        let lastText = null;
        for (let i = msgs.length - 1; i >= 0; i -= 1) {
          if (msgs[i].role === "assistant") {
            lastText = extractMsgText(msgs[i].content);
            break;
          }
        }
        sendResponse(id, type, true, { text: lastText });
        break;
      }

      case "export_html": {
        const defaultOut = path.join(
          session.ensureSessionDir(),
          `export_${session.store.sessionId}.html`,
        );
        const outPath = writeHtmlExport(session.store.sessionFile, cmd.outputPath ?? defaultOut);
        sendResponse(id, type, true, { path: outPath });
        break;
      }

      case "bash": {
        const commandStr = String(cmd.command ?? "");
        sendResponse(id, type, true, {
          output: `simulated: ${commandStr}\n`,
          exitCode: 0,
          cancelled: false,
          truncated: false,
        });
        break;
      }

      case "abort_bash": {
        sendResponse(id, type, true, {});
        break;
      }

      case "steer": {
        const msg = String(cmd.message ?? "");
        if (state.isStreaming) {
          state.steeringQueue.push(msg);
          emitQueueUpdate();
          sendResponse(id, type, true, { disposition: "queued" });
        } else {
          sendResponse(id, type, true, { disposition: "queued" });
          void runAgentLoop(msg, cmd.images ?? []);
        }
        break;
      }

      case "follow_up": {
        const msg = String(cmd.message ?? "");
        if (state.isStreaming) {
          state.followUpQueue.push(msg);
          emitQueueUpdate();
          sendResponse(id, type, true, { disposition: "queued" });
        } else {
          sendResponse(id, type, true, { disposition: "queued" });
          void runAgentLoop(msg, cmd.images ?? []);
        }
        break;
      }

      case "clear_queue": {
        const cleared = {
          steering: [...state.steeringQueue],
          followUp: [...state.followUpQueue],
        };
        state.steeringQueue = [];
        state.followUpQueue = [];
        emitQueueUpdate();
        sendResponse(id, type, true, cleared);
        break;
      }

      case "abort": {
        state.abortCurrentRun = true;
        for (const [reqId, resolver] of state.pendingUiResolvers) {
          state.pendingUiResolvers.delete(reqId);
          resolver({ id: reqId, cancelled: true });
        }
        sendResponse(id, type, true, {});
        break;
      }

      case "extension_ui_response": {
        const resolver = state.pendingUiResolvers.get(cmd.id);
        if (resolver) {
          state.pendingUiResolvers.delete(cmd.id);
          resolver(cmd);
        }
        break;
      }

      case "prompt": {
        const messageText = String(cmd.message ?? "");
        const images = Array.isArray(cmd.images) ? cmd.images : [];
        if (state.isStreaming) {
          const behavior = cmd.streamingBehavior;
          if (behavior === "steer") {
            state.steeringQueue.push(messageText);
            emitQueueUpdate();
            sendResponse(id, type, true, { disposition: "queued" });
          } else if (behavior === "followUp") {
            state.followUpQueue.push(messageText);
            emitQueueUpdate();
            sendResponse(id, type, true, { disposition: "queued" });
          } else {
            sendResponse(
              id,
              type,
              false,
              undefined,
              "Agent is currently streaming; specify streamingBehavior",
            );
          }
          return;
        }
        if (messageText.includes("[coalesced]")) {
          runCoalescedPrompt(id, messageText, images);
          return;
        }
        sendResponse(id, type, true, { disposition: "started" });
        void runAgentLoop(messageText, images);
        break;
      }

      default: {
        sendResponse(
          id,
          type ?? "unknown",
          false,
          undefined,
          `Unknown RPC command: ${String(type)}`,
        );
        break;
      }
    }
  };
}
