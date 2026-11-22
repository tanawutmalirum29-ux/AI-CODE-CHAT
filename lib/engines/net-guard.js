import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export class EngineError extends Error {
  constructor(message, { code = "engine_error", status = 502, cause } = {}) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

function parseIPv4(ip) {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

function blockedIPv4(parts) {
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function expandIPv6(ip) {
  let address = ip.toLowerCase().split("%")[0];
  const tail = address.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = parseIPv4(tail[1]);
    if (!v4) return null;
    address = address.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array(missing).fill("0"), ...rest];
  const numbers = groups.map(group => parseInt(group || "0", 16));
  return numbers.length === 8 && numbers.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? numbers : null;
}

export function isBlockedAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = parseIPv4(ip);
    return !parts || blockedIPv4(parts);
  }
  if (family === 6) {
    const g = expandIPv6(ip);
    if (!g) return true;
    if (g.every(n => n === 0)) return true;
    if (g.slice(0, 7).every(n => n === 0) && g[7] === 1) return true;
    if ((g[0] & 0xfe00) === 0xfc00) return true;
    if ((g[0] & 0xffc0) === 0xfe80) return true;
    if ((g[0] & 0xff00) === 0xff00) return true;
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
    if (g[0] === 0x0064 && g[1] === 0xff9b) return true;
    if (g.slice(0, 5).every(n => n === 0) && g[5] === 0xffff) {
      return blockedIPv4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
    }
    if (g.slice(0, 6).every(n => n === 0)) return true;
    return false;
  }
  return true;
}

export function engineHostAllowlist(env = process.env) {
  return new Set(String(env.ENGINE_HOST_ALLOWLIST || "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean));
}

export function defaultPolicy(env = process.env) {
  return {
    allowHttp: env.ENGINE_ALLOW_HTTP === "true",
    allowedHosts: engineHostAllowlist(env)
  };
}

export function parseEngineUrl(raw, policy = defaultPolicy()) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 500) {
    throw new EngineError("Enter a valid engine URL.", { code: "invalid_url", status: 400 });
  }
  let url;
  try { url = new URL(raw.trim()); } catch {
    throw new EngineError("Enter a valid engine URL (for example https://engine.example.com/v1).", { code: "invalid_url", status: 400 });
  }
  const host = url.hostname.toLowerCase();
  const allowlisted = policy.allowedHosts?.has(host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (policy.allowHttp || allowlisted))) {
    throw new EngineError("Engine URLs must use HTTPS.", { code: "https_required", status: 400 });
  }
  if (url.username || url.password) throw new EngineError("Do not put credentials in the URL. Use the token field.", { code: "invalid_url", status: 400 });
  if (url.search || url.hash) throw new EngineError("Engine URL must not contain a query string or fragment.", { code: "invalid_url", status: 400 });
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) throw new EngineError("Invalid port.", { code: "invalid_url", status: 400 });
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  if (net.isIP(bare) && isBlockedAddress(bare) && !allowlisted) {
    throw new EngineError("This address is private or reserved and is not allowed. Use a public HTTPS endpoint or tunnel.", { code: "address_blocked", status: 400 });
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function guardedLookup(allowlisted) {
  return (hostname, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses?.length) return callback(new EngineError("Host did not resolve.", { code: "dns_failed" }));
      if (!allowlisted && addresses.some(entry => isBlockedAddress(entry.address))) {
        return callback(new EngineError("Host resolves to a private or reserved address.", { code: "address_blocked", status: 400 }));
      }
      if (options && options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export function openRequest({ url, method = "GET", headers = {}, body, timeoutMs = 30_000, policy = defaultPolicy() }) {
  const target = url instanceof URL ? url : parseEngineUrl(url, policy);
  const host = target.hostname.toLowerCase();
  const allowlisted = Boolean(policy.allowedHosts?.has(host));
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = client.request(target, {
      method,
      headers: { "User-Agent": "ai-code-chat-engine/1.0", ...headers },
      lookup: guardedLookup(allowlisted),
      agent: false
    }, response => {
      if (settled) return response.destroy();
      settled = true;
      clearTimeout(timer);
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy();
        return reject(new EngineError("The engine tried to redirect the request, which is not allowed.", { code: "redirect_blocked" }));
      }
      resolve({ request, response, abort: () => request.destroy() });
    });
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof EngineError ? error : new EngineError(describeNetworkError(error), { code: classifyNetworkError(error), cause: error }));
    };
    const timer = setTimeout(() => {
      request.destroy();
      fail(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    request.on("error", fail);
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
}

export async function guardedStreamRequest(options) {
  const { response, abort } = await openRequest(options);
  return { status: response.statusCode, headers: response.headers, stream: response, abort };
}

export async function readBody(response, maxBytes = 5 * 1024 * 1024, timeoutMs = 30_000) {
  const chunks = [];
  let total = 0;
  return await new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new EngineError("The engine took too long to send its response.", { code: "timeout", status: 504 }));
      response.destroy();
    }, timeoutMs);
    response.on("data", chunk => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        finish(reject, new EngineError("The engine response was too large.", { code: "response_too_large" }));
        response.destroy();
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => finish(resolve, Buffer.concat(chunks)));
    response.on("error", error => finish(reject, new EngineError(describeNetworkError(error), { code: classifyNetworkError(error), cause: error })));
    response.on("aborted", () => finish(reject, new EngineError("The connection to the engine was interrupted.", { code: "aborted" })));
  });
}

export async function guardedRequest(options) {
  const { response } = await openRequest(options);
  const body = await readBody(response, options.maxBytes, options.timeoutMs);
  return { status: response.statusCode, headers: response.headers, body };
}

export function classifyNetworkError(error) {
  const code = error?.code || "";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timeout";
  if (code === "ECONNREFUSED") return "connection_refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_failed";
  if (code === "ECONNRESET" || code === "EPIPE") return "connection_reset";
  if (/CERT|SSL|TLS|DEPTH_ZERO|SELF_SIGNED/i.test(code)) return "tls_error";
  return "network_error";
}

export function describeNetworkError(error) {
  switch (classifyNetworkError(error)) {
    case "timeout": return "The engine did not respond in time. Check that it is running and reachable, or raise the timeout.";
    case "connection_refused": return "The engine refused the connection. Check that it is running and that the URL and port are correct.";
    case "dns_failed": return "The engine host name could not be found.";
    case "connection_reset": return "The connection to the engine was reset.";
    case "tls_error": return "The engine's HTTPS certificate was rejected. Use a valid certificate (for example through a tunnel).";
    default: return "Could not reach the engine.";
  }
}
