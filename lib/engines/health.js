import { EngineError, guardedRequest, parseEngineUrl, defaultPolicy } from "./net-guard.js";
import { listEngineModels } from "./chat-adapter.js";

const FAILURE_THRESHOLD = 3;
const OPEN_MS = 30_000;
const MAX_TRACKED = 500;

export class CircuitBreaker {
  constructor({ threshold = FAILURE_THRESHOLD, openMs = OPEN_MS, now = () => Date.now() } = {}) {
    this.threshold = threshold; this.openMs = openMs; this.now = now; this.state = new Map();
  }
  isOpen(key) {
    const entry = this.state.get(key);
    if (!entry || entry.failures < this.threshold) return false;
    if (this.now() - entry.openedAt >= this.openMs) return false;
    return true;
  }
  retryInMs(key) {
    const entry = this.state.get(key);
    return entry ? Math.max(0, this.openMs - (this.now() - entry.openedAt)) : 0;
  }
  success(key) { this.state.delete(key); }
  failure(key) {
    const entry = this.state.get(key) || { failures: 0, openedAt: 0 };
    entry.failures += 1;
    if (entry.failures >= this.threshold) entry.openedAt = this.now();
    this.state.set(key, entry);
    if (this.state.size > MAX_TRACKED) this.state.delete(this.state.keys().next().value);
  }
}

export const chatBreaker = new CircuitBreaker();

export function breakerError(breaker, key) {
  return new EngineError("This engine has failed several times in a row. Retrying in " + Math.ceil(breaker.retryInMs(key) / 1000) + " seconds.", { code: "circuit_open", status: 503 });
}

function classify(error) {
  if (error?.code === "unauthorized") return "unauthorized";
  if (error instanceof EngineError) return ["not_found", "bad_response", "upstream_error", "unavailable", "rate_limited", "bad_request", "empty_response"].includes(error.code) ? "degraded" : "unreachable";
  return "unreachable";
}

export async function checkChatHealth(profile, token, policy = defaultPolicy()) {
  const checkedAt = new Date().toISOString();
  if (!profile.chatUrl) return { adapter: "chat", status: "unconfigured", message: "No chat URL is set.", checkedAt };
  const started = Date.now();
  try {
    const result = await listEngineModels(profile, token, policy);
    const latencyMs = Date.now() - started;
    if (!result.models.length) return { adapter: "chat", status: "degraded", latencyMs, modelCount: 0, message: "Connected, but no model is loaded in the engine.", checkedAt };
    return { adapter: "chat", status: "ok", latencyMs, modelCount: result.models.length, message: "Connected.", checkedAt };
  } catch (error) {
    return { adapter: "chat", status: classify(error), latencyMs: Date.now() - started, message: error.message, code: error.code || "error", checkedAt };
  }
}

// ComfyUI exposes GET /system_stats. Image and video adapters (later phases) build on this probe.
export async function checkComfyHealth(profile, token, policy = defaultPolicy()) {
  const checkedAt = new Date().toISOString();
  if (!profile.comfyUrl) return { adapter: "comfy", status: "unconfigured", message: "No ComfyUI URL is set.", checkedAt };
  const started = Date.now();
  try {
    const base = parseEngineUrl(profile.comfyUrl, policy);
    const url = new URL(base.origin + base.pathname.replace(/\/+$/, "") + "/system_stats");
    const headers = { Accept: "application/json" };
    if (profile.comfyAuthScheme !== "none" && token) headers.Authorization = "Bearer " + token;
    const result = await guardedRequest({ url, method: "GET", headers, timeoutMs: Math.min(profile.comfyTimeoutMs, 20_000), maxBytes: 1024 * 1024, policy });
    const latencyMs = Date.now() - started;
    if (result.status === 401 || result.status === 403) return { adapter: "comfy", status: "unauthorized", latencyMs, message: "ComfyUI rejected the credentials.", checkedAt };
    if (result.status < 200 || result.status >= 300) return { adapter: "comfy", status: "degraded", latencyMs, message: "ComfyUI returned HTTP " + result.status + ".", checkedAt };
    let devices = null;
    try { devices = JSON.parse(result.body.toString("utf8"))?.devices?.length ?? null; } catch {}
    return { adapter: "comfy", status: "ok", latencyMs, deviceCount: devices, message: "Connected.", checkedAt };
  } catch (error) {
    return { adapter: "comfy", status: "unreachable", latencyMs: Date.now() - started, message: error.message, code: error.code || "error", checkedAt };
  }
}
