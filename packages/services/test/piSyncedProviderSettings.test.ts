import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Emitter } from "@zcode/rpc";
import type { ProviderSettingsView } from "@zcode/provider";
import { completeModelConfigDataSchema } from "@zcode/shared/model-config";
import type { IProviderSettingsService } from "../src/model-provider/providerFacadeServices.js";
import { createPiSyncedProviderSettingsService } from "../src/pi-config/adapters/piSyncedProviderSettings.js";
import { convertZCodeModelConfigToPiModelEntry } from "../src/pi-config/domain/piModelsJsonCodec.js";

function createStubBaseService(
  onLegacyTest?: (providerId: string, modelId: string) => void,
): IProviderSettingsService {
  const emitter = new Emitter<ProviderSettingsView>();
  const emptyView: ProviderSettingsView = {
    revision: 1,
    providerOrder: [],
    providers: [],
    providerTemplates: [],
  };
  return {
    onDidChange: emitter.event,
    getView: async () => emptyView,
    refresh: async () => emptyView,
    createPersonalProvider: async () => ({ providerId: "stub", view: emptyView }),
    resolveModelConfig: async () => ({ inheritedConfig: {}, effectiveConfig: {}, issues: [] }),
    fetchRemoteModels: async () => ({ endpointUrl: "", models: [] }),
    reorderPersonalProviders: async () => emptyView,
    testModelConnectivity: async (arg) => {
      onLegacyTest?.(arg.providerId, arg.modelId);
      return {
        success: false,
        error: {
          code: "provider-unavailable",
          message: "Legacy registry fallback invoked.",
        },
      };
    },
    savePersonalProviderOverlay: async () => emptyView,
    deletePersonalProvider: async () => emptyView,
    reorderPersonalModels: async () => emptyView,
    addPersonalModel: async () => emptyView,
    addPersonalModels: async () => emptyView,
    renamePersonalModel: async () => emptyView,
    deletePersonalModel: async () => emptyView,
    savePersonalModelDraft: async () => emptyView,
    setPersonalModelEnabled: async () => emptyView,
  };
}

async function readBodyJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

describe("piSyncedProviderSettings — completeness & host-side connectivity", () => {
  let tempDir: string;
  let serverUrl: string;
  let closeServer: () => Promise<void>;
  const recordedRequests: Array<{
    path: string;
    headers: IncomingMessage["headers"];
    body: Record<string, unknown>;
  }> = [];

  before(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-zero-provider-test-"));

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const body = await readBodyJson(req);
        const urlPath = req.url ?? "/";
        recordedRequests.push({ path: urlPath, headers: req.headers, body });

        // 1) OpenAI Responses (SSE success, 400 fallback, 200 SSE error, 401 echo-secret error)
        if (urlPath === "/v1/responses") {
          const auth = req.headers.authorization;
          if (auth === "Bearer sk-live-super-secret-1234567890") {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: {
                  message:
                    "Invalid API key provided: sk-live-super-secret-1234567890 (Bearer sk-live-super-secret-1234567890)",
                },
              }),
            );
            return;
          }
          if (auth !== "Bearer sk-yunxiang-secret-9876543210") {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Unauthorized" } }));
            return;
          }
          if (body["model"] === "gpt-6.1-codex-fallback" && "max_output_tokens" in body) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ error: { message: "Unsupported parameter: max_output_tokens" } }),
            );
            return;
          }
          if (body["model"] === "gpt-6.1-sse-fail") {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.end(
              'event: error\ndata: {"type":"error","error":{"message":"Quota exceeded for sk-yunxiang-secret-9876543210"}}\n\n',
            );
            return;
          }
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end('event: response.created\ndata: {"type":"response.created"}\n\n');
          return;
        }

        // 2) OpenAI Chat Completions (.env key + max_completion_tokens fallback)
        if (urlPath === "/v1/chat/completions") {
          if (req.headers.authorization !== "Bearer sk-dotenv-secret-5555555555") {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Invalid bearer token" } }));
            return;
          }
          if (body["model"] === "o3-reasoning" && "max_tokens" in body) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: {
                  message:
                    "Unsupported parameter: 'max_tokens' is not supported. Use 'max_completion_tokens' instead.",
                },
              }),
            );
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "chatcmpl-1", choices: [] }));
          return;
        }

        // 3) Anthropic Messages
        if (urlPath === "/v1/messages") {
          if (
            req.headers["x-api-key"] !== "sk-ant-env-secret-7777777777" ||
            req.headers["anthropic-version"] !== "2023-06-01"
          ) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Invalid Anthropic headers" } }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "msg_1", content: [{ type: "text", text: "ok" }] }));
          return;
        }

        // 4) Google Generative AI
        if (urlPath === "/v1beta/models/gemini-2.5-pro:generateContent") {
          if (req.headers["x-goog-api-key"] !== "AIzaSyTestSecretKey999999") {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Forbidden" } }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ candidates: [] }));
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Unhandled path: ${urlPath}` } }));
      })();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}`;
    closeServer = () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });

    await writeFile(
      path.join(tempDir, ".env"),
      'export OPENAI_COMPAT_KEY="sk-dotenv-secret-5555555555"\n',
      "utf8",
    );
    await writeFile(
      path.join(tempDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            yunxiang: {
              baseUrl: `${serverUrl}/v1`,
              api: "openai-responses",
              apiKey: "sk-yunxiang-secret-9876543210",
              models: [
                {
                  id: "gpt-6.1-sol",
                  name: "gpt-6.1-sol",
                  reasoning: true,
                  input: ["text", "image"],
                  contextWindow: 200000,
                  maxTokens: 32768,
                  thinkingLevelMap: {
                    off: null,
                    minimal: null,
                    low: "low",
                    medium: "medium",
                    high: "high",
                    xhigh: "xhigh",
                    max: "max",
                  },
                },
                {
                  id: "gpt-6.1-terra",
                },
                {
                  id: "gpt-6.1-codex-fallback",
                },
                {
                  id: "gpt-6.1-sse-fail",
                },
              ],
            },
            "yunxiang-bad-key": {
              baseUrl: `${serverUrl}/v1`,
              api: "openai-responses",
              apiKey: "sk-live-super-secret-1234567890",
              models: [{ id: "gpt-6.1-sol" }],
            },
            "openai-compat": {
              baseUrl: `${serverUrl}/v1`,
              api: "openai-completions",
              apiKey: "$OPENAI_COMPAT_KEY",
              models: [{ id: "gpt-4o" }, { id: "o3-reasoning", reasoning: true }],
            },
            "anthropic-relay": {
              baseUrl: serverUrl,
              api: "anthropic-messages",
              apiKey: "$ANTHROPIC_TEST_KEY",
              models: [{ id: "claude-sonnet-4-5", reasoning: true }],
            },
            "gemini-relay": {
              baseUrl: serverUrl,
              api: "google-generative-ai",
              apiKey: "AIzaSyTestSecretKey999999",
              models: [{ id: "gemini-2.5-pro" }],
            },
            "missing-env-provider": {
              baseUrl: `${serverUrl}/v1`,
              api: "openai-completions",
              apiKey: "$UNSET_PROVIDER_SECRET",
              models: [{ id: "m1" }],
            },
            "cmd-key-provider": {
              baseUrl: `${serverUrl}/v1`,
              api: "openai-completions",
              apiKey: "!echo secret",
              models: [{ id: "m1" }],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  });

  after(async () => {
    await closeServer();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("projects Pi models.json models with complete properties, valid optionSpecs, zero issues, and write-only key handling", async () => {
    const service = createPiSyncedProviderSettingsService({
      base: createStubBaseService(),
      agentDir: tempDir,
      env: { ANTHROPIC_TEST_KEY: "sk-ant-env-secret-7777777777" },
    });

    const view = await service.getView();
    const yunxiang = view.providers.find((p) => p.providerId === "yunxiang");
    assert.ok(yunxiang, "expected yunxiang provider to be projected");
    assert.equal(yunxiang.enabled, true);
    assert.equal(yunxiang.executable, true);
    assert.deepEqual(yunxiang.issues, []);
    // 严格只写凭据：字面量 API Key 绝不回传给 UI
    assert.equal(
      yunxiang.effectiveConfig.access?.type === "api-key"
        ? yunxiang.effectiveConfig.access.apiKey
        : null,
      "",
    );

    for (const model of yunxiang.models) {
      assert.equal(model.executable, true);
      assert.equal(model.selectable, true);
      assert.deepEqual(model.issues, []);

      // 完整满足 ProviderCardSections.tsx 的 completeProperties 检查
      const props = model.effectiveConfig.properties;
      assert.ok((props?.contextWindow ?? 0) > 0, `${model.modelId} missing contextWindow`);
      assert.equal(props?.inputFormat?.supportsText, true);
      assert.equal(typeof props?.inputFormat?.supportsImage, "boolean");
      assert.equal(typeof props?.inputFormat?.supportsVideo, "boolean");
      assert.equal(typeof props?.inputFormat?.supportsAudio, "boolean");
      assert.equal(typeof props?.inputFormat?.supportsPdf, "boolean");
      assert.equal(props?.outputFormat?.supportsText, true);

      // 完整满足 @zcode/shared/model-config 的 completeModelConfigDataSchema（含 CEL 编译校验）
      const parsed = completeModelConfigDataSchema.safeParse(model.effectiveConfig);
      assert.equal(parsed.success, true, `model ${model.modelId} failed schema validation`);
    }

    const sol = yunxiang.models.find((m) => m.modelId === "gpt-6.1-sol");
    assert.ok(sol);
    assert.equal(sol.effectiveConfig.properties?.contextWindow, 200000);
    assert.equal(sol.effectiveConfig.properties?.inputFormat?.supportsImage, true);
    assert.equal(sol.effectiveConfig.optionSpecs?.maxOutputTokens?.max, 32768);
    assert.deepEqual(sol.effectiveConfig.optionSpecs?.reasoningLevel?.values, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    const terra = yunxiang.models.find((m) => m.modelId === "gpt-6.1-terra");
    assert.ok(terra);
    assert.equal(terra.effectiveConfig.properties?.contextWindow, 128000);
    assert.equal(terra.effectiveConfig.optionSpecs?.maxOutputTokens?.max, 16384);
    assert.deepEqual(terra.effectiveConfig.optionSpecs?.reasoningLevel?.values, ["off"]);

    // resolveModelConfig 对已有模型和新增模型均返回完整且无 issue 的配置
    const resolvedNew = await service.resolveModelConfig({
      providerId: "yunxiang",
      modelId: "brand-new-model",
    });
    assert.deepEqual(resolvedNew.issues, []);
    assert.equal(
      completeModelConfigDataSchema.safeParse(resolvedNew.inheritedConfig).success,
      true,
    );
    assert.equal(
      completeModelConfigDataSchema.safeParse(resolvedNew.effectiveConfig).success,
      true,
    );

    // 非思考模型回写不污染 thinkingLevelMap
    const roundTrippedNonReasoning = convertZCodeModelConfigToPiModelEntry(
      "gpt-6.1-terra",
      terra.effectiveConfig,
    );
    assert.equal(roundTrippedNonReasoning.reasoning, false);
    assert.equal(roundTrippedNonReasoning.thinkingLevelMap, null);
  });

  it("tests connectivity host-side for openai-responses, openai-completions, anthropic-messages, and google-generative-ai", async () => {
    const legacyCalls: string[] = [];
    const service = createPiSyncedProviderSettingsService({
      base: createStubBaseService((p, m) => legacyCalls.push(`${p}/${m}`)),
      agentDir: tempDir,
      env: { ANTHROPIC_TEST_KEY: "sk-ant-env-secret-7777777777" },
    });

    // openai-responses (write-only literal key from models.json + SSE stream)
    const responsesRes = await service.testModelConnectivity({
      workspacePath: tempDir,
      providerId: "yunxiang",
      modelId: "gpt-6.1-sol",
    });
    assert.deepEqual(responsesRes, { success: true });

    // openai-responses 400 fallback (retry without max_output_tokens)
    const fallbackRes = await service.testModelConnectivity({
      workspacePath: tempDir,
      providerId: "yunxiang",
      modelId: "gpt-6.1-codex-fallback",
    });
    assert.deepEqual(fallbackRes, { success: true });

    // openai-completions (key resolved from temp .env with `export` prefix)
    const completionsRes = await service.testModelConnectivity({
      workspacePath: tempDir,
      providerId: "openai-compat",
      modelId: "gpt-4o",
    });
    assert.deepEqual(completionsRes, { success: true });

    // openai-completions 400 fallback (max_tokens -> max_completion_tokens)
    const reasoningFallbackRes = await service.testModelConnectivity({
      workspacePath: tempDir,
      providerId: "openai-compat",
      modelId: "o3-reasoning",
    });
    assert.deepEqual(reasoningFallbackRes, { success: true });

    // anthropic-messages (key resolved from env + x-api-key + anthropic-version)
    const anthropicRes = await service.testModelConnectivity({
      workspacePath: tempDir,
      providerId: "anthropic-relay",
      modelId: "claude-sonnet-4-5",
    });
    assert.deepEqual(anthropicRes, { success: true });

    // google-generative-ai (x-goog-api-key header, never in URL)
    const geminiRes = await service.testModelConnectivity({
      workspacePath: tempDir,
      providerId: "gemini-relay",
      modelId: "gemini-2.5-pro",
    });
    assert.deepEqual(geminiRes, { success: true });
    const geminiReq = recordedRequests.find((r) => r.path.includes("gemini-2.5-pro"));
    assert.ok(geminiReq);
    assert.ok(!geminiReq.path.includes("AIzaSyTestSecretKey999999"));

    // Providers in models.json never fall through to legacy registry
    assert.deepEqual(legacyCalls, []);

    // Non-models.json provider still delegates to base
    const legacyRes = await service.testModelConnectivity({
      workspacePath: tempDir,
      providerId: "non-pi-provider",
      modelId: "some-model",
    });
    assert.equal(legacyRes.success, false);
    assert.deepEqual(legacyCalls, ["non-pi-provider/some-model"]);
  });

  it("reports clear redacted errors on HTTP failure, SSE error events, missing env vars, and !command keys", async () => {
    const service = createPiSyncedProviderSettingsService({
      base: createStubBaseService(),
      agentDir: tempDir,
      env: {},
    });

    // HTTP 401 echoing literal key -> must be redacted
    const authFail = await service.testModelConnectivity({
      workspacePath: tempDir,
      providerId: "yunxiang-bad-key",
      modelId: "gpt-6.1-sol",
    });
    assert.equal(authFail.success, false);
    if (!authFail.success) {
      assert.match(authFail.error.message, /HTTP 401/);
      assert.match(authFail.error.message, /\[REDACTED\]/);
      assert.ok(!authFail.error.message.includes("sk-live-super-secret-1234567890"));
      assert.equal(authFail.error.code, undefined);
    }

    // HTTP 200 with SSE error event echoing key -> must fail & redact key
    const sseFail = await service.testModelConnectivity({
      workspacePath: tempDir,
      providerId: "yunxiang",
      modelId: "gpt-6.1-sse-fail",
    });
    assert.equal(sseFail.success, false);
    if (!sseFail.success) {
      assert.match(sseFail.error.message, /Quota exceeded/);
      assert.match(sseFail.error.message, /\[REDACTED\]/);
      assert.ok(!sseFail.error.message.includes("sk-yunxiang-secret-9876543210"));
    }

    // Missing env var -> clear actionable error
    const missingEnv = await service.testModelConnectivity({
      workspacePath: tempDir,
      providerId: "missing-env-provider",
      modelId: "m1",
    });
    assert.equal(missingEnv.success, false);
    if (!missingEnv.success) {
      assert.match(missingEnv.error.message, /\$UNSET_PROVIDER_SECRET/);
    }

    // Command key (!...) -> refuses shell execution and reports clear error
    const cmdKey = await service.testModelConnectivity({
      workspacePath: tempDir,
      providerId: "cmd-key-provider",
      modelId: "m1",
    });
    assert.equal(cmdKey.success, false);
    if (!cmdKey.success) {
      assert.match(cmdKey.error.message, /!command/);
    }
  });
});
