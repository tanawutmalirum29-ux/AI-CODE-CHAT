import { EngineError, openRequest, readBody, guardedRequest, parseEngineUrl, defaultPolicy } from "./net-guard.js";

function joinUrl(baseUrl, route, policy) {
  const base = parseEngineUrl(baseUrl, policy);
  return new URL(base.origin + base.pathname.replace(/\/+$/, "") + route);
}

function authHeaders(profile, token) {
  const headers = {};
  if (profile.authScheme !== "none" && token) headers.Authorization = "Bearer " + token;
  return headers;
}

function errorFromStatus(status, payload) {
  const upstream = payload?.error?.message || payload?.message || (typeof payload?.error === "string" ? payload.error : "");
  const detail = upstream ? " (" + String(upstream).slice(0, 300) + ")" : "";
  if (status === 401 || status === 403) return new EngineError("The engine rejected the token. Check the token saved for this engine." + detail, { code: "unauthorized", status: 401 });
  if (status === 404) return new EngineError("The engine does not expose this route. Check the base URL (it usually ends in /v1) and that the engine's local API is enabled." + detail, { code: "not_found", status: 502 });
  if (status === 429) return new EngineError("The engine is busy or rate-limited. Try again shortly." + detail, { code: "rate_limited", status: 429 });
  if (status === 400 || status === 422) return new EngineError("The engine rejected the request." + (detail || " Check the model and settings."), { code: "bad_request", status: 502 });
  if (status === 503) return new EngineError("The engine is not ready (no model loaded or it is still starting)." + detail, { code: "unavailable", status: 503 });
  return new EngineError("The engine returned HTTP " + status + "." + detail, { code: "upstream_error", status: 502 });
}

function parseJson(buffer) {
  try { return JSON.parse(buffer.toString("utf8")); } catch { return null; }
}

function jsonHeaders(profile, token, extra = {}) {
  return { "Content-Type": "application/json", Accept: "application/json", ...authHeaders(profile, token), ...extra };
}

export async function listEngineModels(profile, token, policy = defaultPolicy()) {
  const url = joinUrl(profile.chatUrl, "/models", policy);
  const result = await guardedRequest({ url, method: "GET", headers: jsonHeaders(profile, token), timeoutMs: Math.min(profile.chatTimeoutMs, 20_000), maxBytes: 2 * 1024 * 1024, policy });
  const payload = parseJson(result.body);
  if (result.status < 200 || result.status >= 300) throw errorFromStatus(result.status, payload);
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : null;
  if (!rows) throw new EngineError("The engine returned an unrecognised model list.", { code: "bad_response" });
  const models = rows
    .map(row => typeof row === "string" ? { id: row } : row)
    .filter(row => typeof row?.id === "string" && row.id)
    .map(row => ({ id: row.id, name: row.name || row.id, description: row.description || "", modality: row.modality || "text" }));
  return { models, defaultModel: models[0]?.id || null, source: "live" };
}

function chatBody({ model, messages, temperature, maxTokens, stream }) {
  return JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream });
}

export async function completeWithEngine({ profile, token, model, messages, temperature = 0.7, maxTokens = 2048, policy = defaultPolicy() }) {
  const url = joinUrl(profile.chatUrl, "/chat/completions", policy);
  const result = await guardedRequest({
    url, method: "POST", headers: jsonHeaders(profile, token),
    body: chatBody({ model, messages, temperature, maxTokens, stream: false }),
    timeoutMs: profile.chatTimeoutMs, maxBytes: 8 * 1024 * 1024, policy
  });
  const payload = parseJson(result.body);
  if (result.status < 200 || result.status >= 300) throw errorFromStatus(result.status, payload);
  const content = payload?.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map(part => part?.text || "").join("") : typeof content === "string" ? content : "";
  if (!text) throw new EngineError("The engine returned an empty response.", { code: "empty_response" });
  return { text, model: payload.model || model, usage: payload.usage || null, provider: profile.name, costUsd: null, requestId: null };
}

export async function* streamFromEngine({ profile, token, model, messages, temperature = 0.7, maxTokens = 2048, signal, policy = defaultPolicy() }) {
  const url = joinUrl(profile.chatUrl, "/chat/completions", policy);
  const { response, abort } = await openRequest({
    url, method: "POST",
    headers: jsonHeaders(profile, token, { Accept: "text/event-stream" }),
    body: chatBody({ model, messages, temperature, maxTokens, stream: true }),
    timeoutMs: profile.chatTimeoutMs, policy
  });
  const onAbort = () => abort();
  if (signal) { if (signal.aborted) abort(); else signal.addEventListener("abort", onAbort, { once: true }); }
  try {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const body = await readBody(response, 64 * 1024, 15_000);
      throw errorFromStatus(response.statusCode, parseJson(body));
    }
    const type = String(response.headers["content-type"] || "");
    if (!type.includes("text/event-stream")) {
      const body = await readBody(response, 8 * 1024 * 1024, profile.chatTimeoutMs);
      const payload = parseJson(body);
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content === "string" && content) { yield { delta: content, model: payload.model || model }; return; }
      throw new EngineError("The engine did not stream a response.", { code: "bad_response" });
    }
    response.setEncoding("utf8");
    let buffer = "";
    let received = false;
    let idle = null;
    const idleMs = profile.chatTimeoutMs;
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => abort(), idleMs); };
    touch();
    try {
      for await (const chunk of response) {
        touch();
        buffer += chunk;
        if (buffer.length > 2 * 1024 * 1024) throw new EngineError("The engine stream was malformed.", { code: "bad_response" });
        let index;
        while ((index = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, index).replace(/\r$/, "");
          buffer = buffer.slice(index + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") { if (!received) throw new EngineError("The engine returned an empty response.", { code: "empty_response" }); return; }
          const payload = parseJson(Buffer.from(data));
          if (!payload) continue;
          if (payload.error) throw new EngineError(String(payload.error.message || payload.error).slice(0, 300), { code: "upstream_error" });
          const delta = payload.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) { received = true; yield { delta, model: payload.model || model }; }
        }
      }
    } finally { clearTimeout(idle); }
    if (!received) throw new EngineError("The engine returned an empty response.", { code: "empty_response" });
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    abort();
  }
}
