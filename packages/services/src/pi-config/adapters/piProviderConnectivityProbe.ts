/**
 * Pi `models.json` 自定义 Provider 宿主机侧连通性探测（adapters 层）：
 * - 严格仅在宿主机/主进程内部读取真实密钥并直连目标端点；
 * - 适配 `openai-responses`、`azure-openai-responses`、`openai-completions`、
 *   `anthropic-messages` 与 `google-generative-ai`；
 * - 所有错误信息强制脱敏并截断，绝不泄漏明文 API Key、Bearer Token 或敏感自定义请求头。
 */
import type { ModelConnectivityResult } from "@zcode/shared";
import { isPlainRecord } from "../domain/piConfigHelpers.js";
import type { PiResolvedProviderConnectivityTarget } from "../domain/piModelsJsonCodec.js";

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const ANTHROPIC_VERSION_HEADER = "2023-06-01";
const ACCIDENTAL_ENDPOINT_SUFFIX_RE = /\/(?:chat\/completions|responses|messages|models)$/iu;
const VERSIONED_GEMINI_PATH_RE = /\/v\d+(?:alpha|beta)?$/iu;
const SENSITIVE_HEADER_KEY_RE = /auth|key|token|secret|cookie/iu;
const MAX_ERROR_MESSAGE_LENGTH = 240;
const MAX_JSON_BODY_BYTES = 16_384;
const MAX_SSE_PEEK_BYTES = 4_096;

interface ProbeRequestSpec {
  readonly urls: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
}

function hasHeaderCaseInsensitive(
  headers: Readonly<Record<string, string>>,
  name: string,
): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function collectProbeSecrets(target: PiResolvedProviderConnectivityTarget): string[] {
  const secrets = new Set<string>();
  const add = (val: string | null | undefined) => {
    const trimmed = val?.trim();
    if (!trimmed || trimmed.length < 4) return;
    secrets.add(trimmed);
    const encoded = encodeURIComponent(trimmed);
    if (encoded !== trimmed) secrets.add(encoded);
  };
  add(target.apiKey);
  for (const [key, value] of Object.entries(target.headers)) {
    if (SENSITIVE_HEADER_KEY_RE.test(key)) {
      add(value);
      const bearerMatch = /^Bearer\s+(.+)$/iu.exec(value.trim());
      if (bearerMatch?.[1]) add(bearerMatch[1]);
    }
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

export function redactProbeSecrets(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.length >= 4 && out.includes(secret)) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/giu, "Bearer [REDACTED]");
  out = out.replace(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]");
  out = out.replace(/([?&](?:api_?key|key|token)=)[^&\s]+/giu, "$1[REDACTED]");
  out = out.replace(/\s+/gu, " ").trim();
  if (out.length > MAX_ERROR_MESSAGE_LENGTH) {
    return `${out.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...`;
  }
  return out;
}

export function buildPiConnectivityProbeSpec(
  target: PiResolvedProviderConnectivityTarget,
): ProbeRequestSpec {
  if (!target.baseUrl) {
    throw new Error(`Provider "${target.providerId}" is missing a valid Base URL.`);
  }
  const parsed = new URL(target.baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported Base URL protocol: ${parsed.protocol}`);
  }

  let pathname = parsed.pathname.replace(/\/+$/u, "");
  pathname = pathname.replace(ACCIDENTAL_ENDPOINT_SUFFIX_RE, "");
  const base = `${parsed.origin}${pathname}`;
  const search = parsed.search;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept:
      target.api === "openai-responses" ||
      target.api === "azure-openai-responses" ||
      target.api === "openai-completions"
        ? "application/json, text/event-stream"
        : "application/json",
  };
  for (const [key, value] of Object.entries(target.headers)) {
    if (key.trim() && value !== undefined) {
      headers[key] = value;
    }
  }

  const trimmedKey = target.apiKey?.trim();
  const api = target.api;

  if (api === "anthropic-messages") {
    if (trimmedKey) {
      if (target.authHeader === true) {
        if (!hasHeaderCaseInsensitive(headers, "authorization")) {
          headers["Authorization"] = `Bearer ${trimmedKey}`;
        }
      } else if (
        !hasHeaderCaseInsensitive(headers, "x-api-key") &&
        !hasHeaderCaseInsensitive(headers, "authorization")
      ) {
        headers["x-api-key"] = trimmedKey;
      }
    }
    if (!hasHeaderCaseInsensitive(headers, "anthropic-version")) {
      headers["anthropic-version"] = ANTHROPIC_VERSION_HEADER;
    }
    const urls = pathname.toLowerCase().endsWith("/v1")
      ? [`${base}/messages${search}`]
      : [`${base}/v1/messages${search}`, `${base}/messages${search}`];
    return {
      urls: [...new Set(urls)],
      headers,
      body: {
        model: target.modelId,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      },
    };
  }

  if (api === "google-generative-ai") {
    if (
      trimmedKey &&
      !hasHeaderCaseInsensitive(headers, "x-goog-api-key") &&
      !hasHeaderCaseInsensitive(headers, "authorization")
    ) {
      headers["x-goog-api-key"] = trimmedKey;
    }
    const bareModelId = target.modelId.replace(/^models\//u, "");
    const encodedModel = encodeURIComponent(bareModelId);
    const urls =
      pathname === "" || !VERSIONED_GEMINI_PATH_RE.test(pathname)
        ? [
            `${base}/v1beta/models/${encodedModel}:generateContent${search}`,
            `${base}/models/${encodedModel}:generateContent${search}`,
          ]
        : [`${base}/models/${encodedModel}:generateContent${search}`];
    return {
      urls: [...new Set(urls)],
      headers,
      body: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 16 },
      },
    };
  }

  if (api === "openai-responses" || api === "azure-openai-responses") {
    if (trimmedKey) {
      if (api === "azure-openai-responses" && target.authHeader === false) {
        if (!hasHeaderCaseInsensitive(headers, "api-key")) {
          headers["api-key"] = trimmedKey;
        }
      } else if (
        !hasHeaderCaseInsensitive(headers, "authorization") &&
        !(api === "azure-openai-responses" && hasHeaderCaseInsensitive(headers, "api-key"))
      ) {
        headers["Authorization"] = `Bearer ${trimmedKey}`;
      }
    }
    const urls =
      pathname === ""
        ? [`${base}/v1/responses${search}`, `${base}/responses${search}`]
        : [`${base}/responses${search}`];
    return {
      urls: [...new Set(urls)],
      headers,
      body: {
        model: target.modelId,
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        max_output_tokens: 16,
        stream: true,
      },
    };
  }

  // openai-completions 及 OpenAI 兼容默认
  if (trimmedKey && !hasHeaderCaseInsensitive(headers, "authorization")) {
    headers["Authorization"] = `Bearer ${trimmedKey}`;
  }
  const urls =
    pathname === ""
      ? [`${base}/v1/chat/completions${search}`, `${base}/chat/completions${search}`]
      : [`${base}/chat/completions${search}`];
  return {
    urls: [...new Set(urls)],
    headers,
    body: {
      model: target.modelId,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16,
      stream: false,
    },
  };
}

function extractStructuredErrorMessage(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const extracted = extractErrorFromJsonRecord(parsed);
    if (extracted) return extracted;
  } catch {
    // 非 JSON 文本直接回落截断
  }
  return trimmed.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${trimmed.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...`
    : trimmed;
}

function extractErrorFromJsonRecord(parsed: unknown): string | undefined {
  if (!isPlainRecord(parsed)) return undefined;
  const err = parsed["error"];
  if (typeof err === "string" && err.trim()) return err.trim();
  if (isPlainRecord(err)) {
    if (typeof err["message"] === "string" && err["message"].trim()) {
      return err["message"].trim();
    }
    if (typeof err["type"] === "string" && err["type"].trim()) {
      return err["type"].trim();
    }
  }
  if (typeof parsed["message"] === "string" && parsed["message"].trim()) {
    return parsed["message"].trim();
  }
  if (typeof parsed["detail"] === "string" && parsed["detail"].trim()) {
    return parsed["detail"].trim();
  }
  return undefined;
}

function extractSseErrorMessage(sseChunk: string): string | undefined {
  for (const rawLine of sseChunk.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (!isPlainRecord(parsed)) continue;
      if (parsed["type"] === "error" || parsed["type"] === "response.failed") {
        const resp = isPlainRecord(parsed["response"]) ? parsed["response"] : parsed;
        return (
          extractErrorFromJsonRecord(resp) ??
          extractErrorFromJsonRecord(parsed) ??
          "Upstream stream returned an error event."
        );
      }
      if (parsed["error"]) {
        return extractErrorFromJsonRecord(parsed) ?? "Upstream stream returned an error.";
      }
    } catch {
      // 截断的 SSE 帧忽略，不误判为错误
    }
  }
  return undefined;
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  stopAfterFirstSseData = false,
): Promise<string> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    return text.slice(0, maxBytes);
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  try {
    while (totalBytes < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (stopAfterFirstSseData && /\bdata:\s*\S/u.test(text)) {
          break;
        }
      }
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

function resolveBodyFallback(
  api: string,
  body: Record<string, unknown>,
  status: number,
  detail: string | undefined,
): Record<string, unknown> | null {
  if (status !== 400 || !detail) return null;
  const lower = detail.toLowerCase();

  if (api === "openai-responses" || api === "azure-openai-responses") {
    if ("max_output_tokens" in body && lower.includes("max_output_tokens")) {
      const next = { ...body };
      delete next["max_output_tokens"];
      return next;
    }
    if (body["stream"] === true && lower.includes("stream")) {
      return { ...body, stream: false };
    }
    return null;
  }

  if (api !== "anthropic-messages" && api !== "google-generative-ai") {
    if (
      "max_tokens" in body &&
      (lower.includes("max_completion_tokens") || lower.includes("max_tokens"))
    ) {
      const next = { ...body };
      delete next["max_tokens"];
      next["max_completion_tokens"] = 16;
      return next;
    }
    if (body["stream"] === false && lower.includes("stream")) {
      return { ...body, stream: true };
    }
  }

  return null;
}

function formatNetworkError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return `Request timed out after ${Math.max(1, Math.round(timeoutMs / 1000))}s`;
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && !error.message.includes(cause.message)) {
      return `${error.message}: ${cause.message}`;
    }
    return error.message;
  }
  return String(error);
}

export async function probePiProviderModelConnectivity(
  target: PiResolvedProviderConnectivityTarget,
  options?: {
    readonly fetchImpl?: typeof fetch | undefined;
    readonly timeoutMs?: number | undefined;
  },
): Promise<ModelConnectivityResult> {
  if (!target.modelId.trim()) {
    return {
      success: false,
      error: {
        code: "model-unavailable",
        message: "Model ID is empty.",
      },
    };
  }
  if (target.api === "bedrock-converse-stream") {
    return {
      success: false,
      error: {
        message: "AWS Bedrock connectivity testing is not supported from Settings; verify in chat.",
      },
    };
  }

  const secrets = collectProbeSecrets(target);
  let spec: ProbeRequestSpec;
  try {
    spec = buildPiConnectivityProbeSpec(target);
  } catch (error) {
    return {
      success: false,
      error: {
        message: redactProbeSecrets(
          error instanceof Error ? error.message : String(error),
          secrets,
        ),
      },
    };
  }

  const fetchFn = options?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let lastErrorMessage = "Failed to connect to provider endpoint.";

  for (let urlIndex = 0; urlIndex < spec.urls.length; urlIndex += 1) {
    const url = spec.urls[urlIndex]!;
    const hasFallbackUrl = urlIndex < spec.urls.length - 1;
    let requestBody: Record<string, unknown> = spec.body;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchFn(url, {
          method: "POST",
          headers: spec.headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        if (!response.ok) {
          const rawText = await readBoundedText(response, MAX_JSON_BODY_BYTES);
          const detail = extractStructuredErrorMessage(rawText);
          const statusMsg = detail
            ? `HTTP ${response.status}: ${detail}`
            : `HTTP ${response.status} ${response.statusText}`.trim();
          lastErrorMessage = redactProbeSecrets(statusMsg, secrets);

          if (attempt === 0) {
            const fallbackBody = resolveBodyFallback(
              target.api,
              requestBody,
              response.status,
              detail,
            );
            if (fallbackBody) {
              requestBody = fallbackBody;
              continue;
            }
          }

          if (hasFallbackUrl && (response.status === 404 || response.status === 405)) {
            break;
          }

          return {
            success: false,
            error: { message: lastErrorMessage },
          };
        }

        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (contentType.includes("text/event-stream")) {
          const sseText = await readBoundedText(response, MAX_SSE_PEEK_BYTES, true);
          const sseError = extractSseErrorMessage(sseText);
          if (sseError) {
            return {
              success: false,
              error: { message: redactProbeSecrets(sseError, secrets) },
            };
          }
          return { success: true };
        }

        const bodyText = await readBoundedText(response, MAX_JSON_BODY_BYTES);
        if (bodyText.trim()) {
          try {
            const parsed: unknown = JSON.parse(bodyText);
            if (isPlainRecord(parsed) && parsed["error"]) {
              const bodyError = extractErrorFromJsonRecord(parsed) ?? "Upstream returned an error.";
              return {
                success: false,
                error: { message: redactProbeSecrets(bodyError, secrets) },
              };
            }
          } catch {
            // 非 JSON 成功响应（如部分网关返回 SSE 但未设 content-type）
            const sseError = extractSseErrorMessage(bodyText);
            if (sseError) {
              return {
                success: false,
                error: { message: redactProbeSecrets(sseError, secrets) },
              };
            }
          }
        }

        return { success: true };
      } catch (error) {
        const msg = redactProbeSecrets(formatNetworkError(error, timeoutMs), secrets);
        lastErrorMessage = msg;
        if (error instanceof Error && error.name === "AbortError") {
          return { success: false, error: { message: msg } };
        }
        if (!hasFallbackUrl) {
          return { success: false, error: { message: msg } };
        }
        break;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return {
    success: false,
    error: { message: lastErrorMessage },
  };
}
