const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));
const state = {
  chatMessages: [],
  providerStatuses: [],
  workspaceId: null,
  imageMode: "generate",
  imageModels: [],
  engines: [],
  comfyCapabilities: new Map(),
  videoWorkflow: null,
  inpaintMaskCanvas: null,
  inpaintMaskUrl: null,
  inpaintSourceFile: null
};
let toastTimer;
let activeMediaJob = null;

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(body && body.error ? body.error : "Request failed with status " + response.status);
  return body;
}
function notify(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
}
function setBusy(button, busy, busyText) {
  button.disabled = busy;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText || "กำลังทำงาน…";
  } else if (button.dataset.originalText) {
    button.textContent = button.dataset.originalText;
    delete button.dataset.originalText;
  }
}
function showPage(page) {
  $$(".page").forEach(section => section.classList.toggle("active", section.id === "page-" + page));
  $$(".nav-item[data-page]").forEach(button => button.classList.toggle("active", button.dataset.page === page));
  const titles = { chat: "AI Chat", code: "Code Workspace", images: "Image Studio", video: "Video Studio", settings: "Settings & API" };
  $("#page-title").textContent = titles[page] || "AI Code Chat";
}
$$(".nav-item[data-page]").forEach(button => button.addEventListener("click", () => showPage(button.dataset.page)));

function renderProviderStatuses(providers) {
  state.providerStatuses = providers || [];
  state.providerStatuses.forEach(provider => {
    const badge = $("#status-" + provider.id);
    if (!badge) return;
    badge.textContent = provider.managedByEnvironment ? "Server key active" : provider.configured ? "Connected" : "Not connected";
    badge.classList.toggle("connected", provider.configured);
    const input = $('[data-api-key="' + provider.id + '"]');
    if (input && provider.managedByEnvironment) {
      input.disabled = true;
      input.placeholder = "Managed by server environment";
    } else if (input) {
      input.disabled = false;
      input.placeholder = provider.configured ? "Key saved · enter a new key to replace" : "Paste API key…";
    }
  });
}
async function loadProviders() {
  const result = await api("/api/providers");
  renderProviderStatuses(result.providers);
}
async function loadChatModels(providerId, selectId) {
  const select = $(selectId);
  select.innerHTML = '<option>Loading models…</option>';
  try {
    const result = await api("/api/providers/" + encodeURIComponent(providerId) + "/models?type=chat");
    select.innerHTML = "";
    result.models.forEach(model => {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.name || model.id;
      select.append(option);
    });
    if (!result.models.length) {
      const option = document.createElement("option");
      option.textContent = "No models available";
      select.append(option);
    } else if (result.defaultModel && result.models.some(model => model.id === result.defaultModel)) {
      select.value = result.defaultModel;
    }
  } catch (error) {
    if (providerId.startsWith("engine:")) {
      select.innerHTML = "";
      const option = document.createElement("option");
      option.textContent = "Engine unavailable: " + error.message;
      select.append(option);
      notify(error.message, true);
    } else {
      select.innerHTML = '<option value="deepseek-v4.1-flash-1017-uncensored">DeepSeek V4.1 Flash Uncensored</option>';
    }
  }
}
$("#chat-provider").addEventListener("change", event => loadChatModels(event.target.value, "#chat-model"));
$("#code-provider").addEventListener("change", event => loadChatModels(event.target.value, "#code-model"));

async function streamChat(payload, target) {
  const response = await fetch("/api/chat/stream", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: payload });
  if (!response.ok) {
    let message = "Request failed with status " + response.status;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const handle = frame => {
    let event = "message";
    let data = "";
    frame.split("\n").forEach(line => {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    });
    if (!data) return;
    const body = JSON.parse(data);
    if (event === "error") throw new Error(body.error || "Engine error.");
    if (event === "delta") {
      text += body.text;
      target.textContent = text;
      $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      handle(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
    }
  }
  if (!text) throw new Error("The engine returned an empty response.");
  return text;
}

function addChatMessage(role, text, pending = false) {
  const empty = $("#chat-empty");
  if (empty) empty.remove();
  const item = document.createElement("div");
  item.className = "chat-message " + role;
  const label = document.createElement("div");
  label.className = "message-role";
  label.textContent = role === "user" ? "YOU" : "AI";
  const body = document.createElement("div");
  body.textContent = text;
  if (pending) body.classList.add("pending");
  item.append(label, body);
  $("#chat-messages").append(item);
  $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;
  return body;
}
$("#chat-form").addEventListener("submit", async event => {
  event.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  const button = $("#chat-send");
  const provider = $("#chat-provider").value;
  const model = $("#chat-model").value;
  const system = $("#chat-system").value.trim();
  state.chatMessages.push({ role: "user", content: text });
  addChatMessage("user", text);
  input.value = "";
  setBusy(button, true, "กำลังคิด…");
  const pending = addChatMessage("assistant", "กำลังประมวลผล…", true);
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push(...state.chatMessages);
  try {
    const payload = JSON.stringify({
      provider, model, messages,
      temperature: Number($("#chat-temperature").value) || 0.7,
      maxTokens: 2048
    });
    let text;
    if (provider.startsWith("engine:")) {
      text = await streamChat(payload, pending);
    } else {
      const result = await api("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
      text = result.text;
      pending.textContent = text;
    }
    pending.classList.remove("pending");
    state.chatMessages.push({ role: "assistant", content: text });
  } catch (error) {
    pending.textContent = "เกิดข้อผิดพลาด: " + error.message;
    notify(error.message, true);
    state.chatMessages.pop();
  } finally {
    setBusy(button, false);
    $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;
  }
});
$("#chat-input").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#chat-form").requestSubmit();
  }
});
$("#clear-chat").addEventListener("click", () => {
  state.chatMessages = [];
  $("#chat-messages").innerHTML = '<div class="empty-state" id="chat-empty"><div class="empty-symbol">✳</div><h2>เริ่มบทสนทนา</h2><p>พิมพ์ข้อความเพื่อเริ่มแชตใหม่</p></div>';
});

function renderFiles(files) {
  const tree = $("#file-tree");
  tree.innerHTML = "";
  if (!files || !files.length) {
    tree.innerHTML = '<div class="empty-inline">ไม่พบไฟล์ใน ZIP</div>';
    return;
  }
  files.forEach(file => {
    const row = document.createElement("div");
    row.className = "file-row " + file.type;
    const icon = document.createElement("span");
    icon.className = "file-kind";
    icon.textContent = file.type === "directory" ? "▸" : "·";
    const name = document.createElement("span");
    name.textContent = file.path;
    row.append(icon, name);
    if (file.type === "file") {
      const size = document.createElement("span");
      size.className = "file-size";
      size.textContent = file.size < 1024 ? file.size + " B" : Math.round(file.size / 1024) + " KB";
      row.append(size);
    }
    tree.append(row);
  });
}
function setWorkspaceActive(active) {
  $("#edit-submit").disabled = !active;
  $("#download-zip").disabled = !active;
}
$("#zip-form").addEventListener("submit", async event => {
  event.preventDefault();
  const file = $("#zip-file").files[0];
  if (!file) return;
  const button = event.submitter;
  const data = new FormData();
  data.append("archive", file);
  setBusy(button, true, "กำลังอ่าน ZIP…");
  try {
    const result = await api("/api/workspaces", { method: "POST", body: data });
    state.workspaceId = result.id;
    renderFiles(result.files);
    $("#workspace-meta").textContent = result.files.length + " รายการ · workspace ชั่วคราว 6 ชั่วโมง";
    setWorkspaceActive(true);
    $("#change-summary").hidden = true;
    notify("อัปโหลดโปรเจกต์เรียบร้อย");
  } catch (error) {
    notify(error.message, true);
  } finally { setBusy(button, false); }
});
$("#download-zip").addEventListener("click", () => {
  if (!state.workspaceId) return;
  window.location.href = "/api/workspaces/" + encodeURIComponent(state.workspaceId) + "/download";
});
$("#edit-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.workspaceId) return;
  const button = $("#edit-submit");
  setBusy(button, true, "AI กำลังแก้ไฟล์…");
  $("#change-summary").hidden = true;
  try {
    const result = await api("/api/workspaces/" + encodeURIComponent(state.workspaceId) + "/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: $("#code-provider").value,
        model: $("#code-model").value,
        instruction: $("#edit-instruction").value.trim()
      })
    });
    renderFiles(result.files);
    $("#change-summary").hidden = false;
    $("#change-summary").textContent = "แก้ไขแล้ว " + result.changedFiles.length + " ไฟล์: " + result.changedFiles.join(", ") + ". ดาวน์โหลด ZIP ได้ด้านบน";
    notify("AI แก้ไขไฟล์เรียบร้อย");
  } catch (error) { notify(error.message, true); }
  finally { setBusy(button, false); }
});

async function loadImageModels() {
  const result = await api("/api/images/models");
  state.imageModels = result.models || [];
  renderImageModels();
}
function engineChoices() {
  return state.engines.filter(engine => engine.comfyUrl);
}
function fillComfyEngineSelect(select, selected = "") {
  if (!select) return;
  const previous = selected || select.value;
  select.innerHTML = "";
  const options = engineChoices();
  options.forEach(engine => {
    const option = document.createElement("option");
    option.value = engine.id;
    option.textContent = engine.name;
    select.append(option);
  });
  if (options.some(engine => engine.id === previous)) select.value = previous;
  else if (options.length) select.value = options[0].id;
  if (!options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No ComfyUI Engine configured";
    select.append(option);
  }
}
async function loadComfyCapabilities(engineId, { quiet = false } = {}) {
  if (!engineId) return null;
  if (state.comfyCapabilities.has(engineId)) return state.comfyCapabilities.get(engineId);
  try {
    const result = await api("/api/engines/" + encodeURIComponent(engineId) + "/comfy/capabilities");
    state.comfyCapabilities.set(engineId, result.capabilities);
    return result.capabilities;
  } catch (error) {
    if (!quiet) notify(error.message, true);
    return null;
  }
}
function renderImageModels() {
  const select = $("#image-model");
  const backend = $("#image-backend").value;
  const engineId = $("#image-engine").value;
  select.innerHTML = "";
  let relevant = [];
  if (backend === "comfy") {
    const caps = state.comfyCapabilities.get(engineId);
    relevant = (caps?.image?.models || []).map(id => ({ id, name: id }));
  } else {
    relevant = state.imageModels.filter(model => model.operation === state.imageMode);
  }
  relevant.forEach(model => {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.name + (model.price && backend !== "comfy" ? " · " + model.price : "");
    select.append(option);
  });
  if (!relevant.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = backend === "comfy" ? "No checkpoint models detected" : "No model available";
    select.append(option);
  } else if (backend === "openuncensored") {
    const preferred = state.imageMode === "generate" ? "z-image-turbo" : "qwen-edit-uncensored";
    if (relevant.some(model => model.id === preferred)) select.value = preferred;
  }
  const comfy = backend === "comfy";
  $("#image-engine-wrap").hidden = !comfy;
  $("#comfy-advanced").hidden = !comfy;
  $("#reference-help").textContent = comfy ? "· PNG, JPEG or WebP · one source image" : "· PNG, JPEG or WebP · up to 3";
  $("#reference-images").multiple = !comfy;
  $("#inpaint-mode").hidden = !comfy;
  $("#inpaint-editor").hidden = state.imageMode !== "inpaint" || !comfy || !state.inpaintMaskCanvas;
  const countWrap = $("#count-wrap");
  countWrap.hidden = state.imageMode !== "generate" || comfy;
  $("#image-submit").disabled = !relevant.length;
}
async function setImageBackend(value) {
  $("#image-backend").value = value;
  if (value !== "comfy" && state.imageMode === "inpaint") setImageMode("generate");
  if (value === "comfy") {
    fillComfyEngineSelect($("#image-engine"));
    const caps = await loadComfyCapabilities($("#image-engine").value);
    if (caps?.image?.txt2img) {
      $("#image-result-meta").textContent = "ComfyUI ready · " + caps.image.models.length + " checkpoint model(s)";
    } else if (caps) {
      $("#image-result-meta").textContent = "This ComfyUI server is missing nodes required for Text to Image.";
    }
  }
  renderImageModels();
}
function setImageMode(mode) {
  if (mode === "inpaint" && $("#image-backend").value !== "comfy") return;
  state.imageMode = mode;
  $$(".mode-button").forEach(button => {
    const active = button.dataset.imageMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  $("#reference-wrap").hidden = mode === "generate";
  $("#inpaint-editor").hidden = mode !== "inpaint" || !state.inpaintMaskCanvas;
  $("#negative-label").hidden = mode === "edit";
  $("#negative-prompt").hidden = mode === "edit";
  $("#image-submit").textContent = mode === "edit" ? "Edit reference image ↗" : mode === "inpaint" ? "Inpaint selected area ↗" : "Generate image ↗";
  renderImageModels();
}
$$(".mode-button").forEach(button => button.addEventListener("click", () => setImageMode(button.dataset.imageMode)));
$("#image-backend").addEventListener("change", event => setImageBackend(event.target.value));
$("#image-engine").addEventListener("change", async event => {
  state.comfyCapabilities.delete(event.target.value);
  await loadComfyCapabilities(event.target.value);
  renderImageModels();
});
async function prepareInpaintCanvas(file) {
  const editor = $("#inpaint-editor");
  const sourcePreview = $("#mask-source-preview");
  const visibleCanvas = $("#mask-canvas");
  state.inpaintMaskCanvas = null;
  state.inpaintSourceFile = null;
  if (state.inpaintMaskUrl) URL.revokeObjectURL(state.inpaintMaskUrl);
  state.inpaintMaskUrl = null;
  editor.hidden = true;
  if (!file) return;
  const url = URL.createObjectURL(file);
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("ไม่สามารถอ่านภาพต้นแบบสำหรับ Inpainting ได้"));
    image.src = url;
  });
  const scale = Math.min(1, 2048 / image.width, 2048 / image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = width; sourceCanvas.height = height;
  sourceCanvas.getContext("2d").drawImage(image, 0, 0, width, height);
  const sourceBlob = await new Promise(resolve => sourceCanvas.toBlob(resolve, "image/png"));
  if (!sourceBlob) throw new Error("ไม่สามารถเตรียมภาพต้นฉบับสำหรับ Inpainting ได้");
  state.inpaintSourceFile = new File([sourceBlob], "inpaint-source.png", { type: "image/png" });
  state.inpaintMaskCanvas = document.createElement("canvas");
  state.inpaintMaskCanvas.width = width; state.inpaintMaskCanvas.height = height;
  const maskContext = state.inpaintMaskCanvas.getContext("2d");
  maskContext.fillStyle = "#000000"; maskContext.fillRect(0, 0, width, height);
  visibleCanvas.width = width; visibleCanvas.height = height;
  visibleCanvas.getContext("2d").clearRect(0, 0, width, height);
  sourcePreview.src = url;
  state.inpaintMaskUrl = url;
  editor.hidden = state.imageMode !== "inpaint";
}
$("#reference-images").addEventListener("change", async event => {
  const files = Array.from(event.target.files || []).slice(0, $("#image-backend").value === "comfy" ? 1 : 3);
  const preview = $("#reference-preview");
  preview.innerHTML = "";
  files.forEach(file => {
    const image = document.createElement("img");
    image.alt = file.name;
    image.src = URL.createObjectURL(file);
    preview.append(image);
  });
  try { await prepareInpaintCanvas(files[0] || null); }
  catch (error) { notify(error.message, true); }
});
function maskPoint(event) {
  const canvas = $("#mask-canvas");
  const rect = canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
}
function paintMaskPoint(context, point, color, size) {
  context.fillStyle = color;
  context.beginPath(); context.arc(point.x, point.y, size / 2, 0, Math.PI * 2); context.fill();
}
let maskPointer = null;
$("#mask-canvas").addEventListener("pointerdown", event => {
  if (!state.inpaintMaskCanvas) return;
  event.preventDefault();
  const canvas = event.currentTarget;
  canvas.setPointerCapture(event.pointerId);
  maskPointer = maskPoint(event);
  const brush = Number($("#mask-brush-size").value) || 42;
  paintMaskPoint(canvas.getContext("2d"), maskPointer, "rgba(255, 55, 55, .58)", brush);
  paintMaskPoint(state.inpaintMaskCanvas.getContext("2d"), maskPointer, "#00ff00", brush);
});
$("#mask-canvas").addEventListener("pointermove", event => {
  if (!maskPointer || !state.inpaintMaskCanvas) return;
  event.preventDefault();
  const next = maskPoint(event);
  const brush = Number($("#mask-brush-size").value) || 42;
  const visible = event.currentTarget.getContext("2d");
  const mask = state.inpaintMaskCanvas.getContext("2d");
  for (const [context, color] of [[visible, "rgba(255, 55, 55, .58)"], [mask, "#00ff00"]]) {
    context.strokeStyle = color; context.lineWidth = brush; context.lineCap = "round"; context.lineJoin = "round";
    context.beginPath(); context.moveTo(maskPointer.x, maskPointer.y); context.lineTo(next.x, next.y); context.stroke();
  }
  maskPointer = next;
});
function endMaskStroke() { maskPointer = null; }
$("#mask-canvas").addEventListener("pointerup", endMaskStroke);
$("#mask-canvas").addEventListener("pointercancel", endMaskStroke);
$("#mask-canvas").addEventListener("lostpointercapture", endMaskStroke);
$("#mask-clear").addEventListener("click", () => {
  if (!state.inpaintMaskCanvas) return;
  $("#mask-canvas").getContext("2d").clearRect(0, 0, $("#mask-canvas").width, $("#mask-canvas").height);
  const context = state.inpaintMaskCanvas.getContext("2d");
  context.fillStyle = "#000000"; context.fillRect(0, 0, state.inpaintMaskCanvas.width, state.inpaintMaskCanvas.height);
});
function renderGeneratedImages(result) {
  const gallery = $("#image-gallery");
  gallery.innerHTML = "";
  (result.images || []).forEach((src, index) => {
    const card = document.createElement("div");
    card.className = "result-image";
    const image = document.createElement("img");
    image.src = src;
    image.alt = "Generated image " + (index + 1);
    const link = document.createElement("a");
    link.href = src;
    link.download = "ai-code-chat-" + (index + 1) + ".png";
    link.textContent = "Download image ↓";
    card.append(image, link);
    gallery.append(card);
  });
  $("#image-result-meta").textContent = result.model + (result.costUsd !== null && result.costUsd !== undefined ? " · estimated provider cost $" + result.costUsd : "");
}
function setMediaProgress(kind, visible, label = "") {
  const box = $("#" + kind + "-progress");
  box.hidden = !visible;
  $("#" + kind + "-progress-label").textContent = label;
  const bar = $("#" + kind + "-progress-bar");
  bar.removeAttribute("value");
}
async function cancelActiveMediaJob(kind) {
  if (!activeMediaJob) return;
  const job = activeMediaJob;
  activeMediaJob = null;
  try {
    await api("/api/engines/" + encodeURIComponent(job.engineId) + "/comfy/jobs/" + encodeURIComponent(job.promptId) + "/cancel", { method: "POST" });
    notify("ส่งคำขอยกเลิกไปยัง ComfyUI แล้ว");
  } catch (error) { notify(error.message, true); }
  setMediaProgress(kind, false);
  $("#" + kind + "-stop").hidden = true;
}
async function pollComfyJob({ kind, engineId, promptId }) {
  const current = { engineId, promptId, kind };
  activeMediaJob = current;
  const stop = $("#" + kind + "-stop");
  stop.hidden = false;
  setMediaProgress(kind, true, "อยู่ในคิว ComfyUI…");
  const deadline = Date.now() + 6 * 60 * 60 * 1000;
  try {
    while (Date.now() < deadline) {
      if (activeMediaJob !== current) return null;
      await new Promise(resolve => setTimeout(resolve, 1800));
      if (activeMediaJob !== current) return null;
      const status = await api("/api/engines/" + encodeURIComponent(engineId) + "/comfy/jobs/" + encodeURIComponent(promptId));
      if (activeMediaJob !== current) return null;
      const labels = { queued: "อยู่ในคิว ComfyUI…", running: "กำลังประมวลผลบน ComfyUI…", unknown: "กำลังตรวจสถานะงาน…", succeeded: "เสร็จแล้ว", failed: "ComfyUI แจ้งว่างานล้มเหลว" };
      setMediaProgress(kind, true, labels[status.status] || status.status);
      if (status.status === "failed") throw new Error(status.error || "ComfyUI ทำงานไม่สำเร็จ ตรวจสอบ node/model errors ใน ComfyUI server");
      if (status.status === "succeeded") return status.outputs || [];
    }
    throw new Error("ใช้เวลาติดตามงานเกิน 6 ชั่วโมง งานอาจยังอยู่ใน ComfyUI; ตรวจสอบ Queue บนเซิร์ฟเวอร์ก่อนส่งงานซ้ำ");
  } finally {
    if (activeMediaJob === current) activeMediaJob = null;
    stop.hidden = true;
    setMediaProgress(kind, false);
  }
}

function showComfyImageOutputs(outputs, engineId, promptId) {
  const gallery = $("#image-gallery");
  gallery.innerHTML = "";
  const images = outputs.filter(file => /\.(png|jpe?g|webp)$/i.test(file.filename));
  images.forEach((file, index) => {
    const card = document.createElement("div"); card.className = "result-image";
    const image = document.createElement("img"); image.src = file.url; image.alt = "ComfyUI generated image " + (index + 1);
    const link = document.createElement("a"); link.href = file.url + "?download=1"; link.download = file.filename; link.textContent = "Download image ↓";
    card.append(image, link); gallery.append(card);
  });
  $("#image-result-meta").textContent = "ComfyUI · " + images.length + " output(s) · prompt " + promptId;
}
$("#image-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("#image-submit");
  const backend = $("#image-backend").value;
  const model = $("#image-model").value;
  const prompt = $("#image-prompt").value.trim();
  const size = $("#image-size").value;
  setBusy(button, true, state.imageMode === "generate" ? "กำลังสร้างภาพ…" : state.imageMode === "inpaint" ? "กำลัง Inpainting…" : "กำลังแก้ภาพ…");
  try {
    const files = Array.from($("#reference-images").files || []).slice(0, backend === "comfy" ? 1 : 3);
    if (backend === "comfy") {
      const engineId = $("#image-engine").value;
      if (!engineId) throw new Error("เลือก ComfyUI Engine ใน Settings ก่อน");
      if (state.imageMode !== "generate" && !files.length) throw new Error("เลือกภาพต้นแบบก่อนเริ่มงาน");
      const capabilities = await loadComfyCapabilities(engineId);
      const operation = state.imageMode === "edit" ? "img2img" : state.imageMode === "inpaint" ? "inpaint" : "txt2img";
      if (!capabilities?.image?.[operation]) throw new Error(capabilities?.image?.reason || "ComfyUI ยังไม่มี node/model ที่รองรับงานนี้");
      const [width, height] = size === "auto" ? [1024, 1024] : size.split("x").map(Number);
      const data = new FormData();
      data.append("type", "image." + operation);
      data.append("prompt", prompt);
      data.append("negativePrompt", $("#negative-prompt").value);
      data.append("model", model);
      data.append("width", String(width)); data.append("height", String(height));
      data.append("count", String($("#image-count").value));
      data.append("steps", $("#comfy-steps").value);
      data.append("cfg", $("#comfy-cfg").value);
      if ($("#comfy-seed").value) data.append("seed", $("#comfy-seed").value);
      if (operation === "inpaint") {
        if (!state.inpaintSourceFile) throw new Error("โหลดภาพต้นฉบับสำหรับ Inpainting ไม่สำเร็จ");
        data.append("image", state.inpaintSourceFile, state.inpaintSourceFile.name);
        if (!state.inpaintMaskCanvas) throw new Error("วาดพื้นที่สีแดงบนภาพต้นแบบก่อนเริ่ม Inpainting");
        const maskBlob = await new Promise(resolve => state.inpaintMaskCanvas.toBlob(resolve, "image/png"));
        if (!maskBlob) throw new Error("ไม่สามารถสร้าง mask จากภาพได้");
        data.append("mask", new File([maskBlob], "inpaint-mask.png", { type: "image/png" }));
      } else if (files[0]) data.append("image", files[0], files[0].name);
      const queued = await api("/api/engines/" + encodeURIComponent(engineId) + "/comfy/jobs", { method: "POST", body: data });
      const outputs = await pollComfyJob({ kind: "image", engineId, promptId: queued.promptId });
      if (!outputs) return;
      showComfyImageOutputs(outputs, engineId, queued.promptId);
      notify("ComfyUI สร้างภาพเรียบร้อย");
    } else {
      let result;
      if (state.imageMode === "edit") {
        if (!files.length) throw new Error("เลือกภาพอ้างอิงอย่างน้อย 1 ภาพ");
        const data = new FormData();
        data.append("model", model); data.append("prompt", prompt); data.append("size", size);
        files.forEach(file => data.append("images", file, file.name));
        result = await api("/api/images/edit", { method: "POST", body: data });
      } else {
        result = await api("/api/images/generate", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt, size, count: Number($("#image-count").value), negativePrompt: $("#negative-prompt").value })
        });
      }
      renderGeneratedImages(result); notify("สร้างภาพเรียบร้อย");
    }
  } catch (error) { notify(error.message, true); }
  finally { setBusy(button, false); }
});
$("#image-stop").addEventListener("click", () => cancelActiveMediaJob("image"));

async function refreshVideoEngineStatus() {
  const engineId = $("#video-engine").value;
  const submit = $("#video-submit");
  submit.disabled = true;
  if (!engineId) { $("#video-capability").textContent = "ยังไม่มี ComfyUI Engine กรุณาตั้งค่าใน Settings & API"; return null; }
  $("#video-capability").textContent = "กำลังตรวจ /object_info…";
  const caps = await loadComfyCapabilities(engineId, { quiet: true });
  const ready = Boolean(caps?.video?.customWorkflow && state.videoWorkflow);
  $("#video-capability").textContent = caps?.video?.reason || "ไม่สามารถตรวจสอบ ComfyUI ได้";
  submit.disabled = !ready || !$("#video-prompt-node").value;
  return caps;
}
function fillNodeSelect(select, nodes, blankLabel) {
  const previous = select.value;
  select.innerHTML = "";
  if (blankLabel !== null) { const blank = document.createElement("option"); blank.value = ""; blank.textContent = blankLabel; select.append(blank); }
  nodes.forEach(([id, node]) => {
    const option = document.createElement("option"); option.value = id;
    option.textContent = id + " · " + node.class_type;
    select.append(option);
  });
  if (Array.from(select.options).some(option => option.value === previous)) select.value = previous;
}
$("#video-workflow").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  state.videoWorkflow = null;
  $("#video-submit").disabled = true;
  [$("#video-prompt-node"), $("#video-negative-node"), $("#video-image-node")].forEach(select => { select.innerHTML = ""; select.disabled = true; });
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { notify("Workflow JSON ต้องมีขนาดไม่เกิน 2 MB", true); event.target.value = ""; return; }
  try {
    const graph = JSON.parse(await file.text());
    if (!graph || typeof graph !== "object" || Array.isArray(graph) || !Object.keys(graph).length || Object.keys(graph).length > 200) throw new Error("Workflow ต้องเป็น ComfyUI API prompt JSON และมีไม่เกิน 200 nodes");
    state.videoWorkflow = graph;
    const entries = Object.entries(graph).filter(([, node]) => node && typeof node === "object" && node.inputs && typeof node.inputs === "object");
    const textNodes = entries.filter(([, node]) => typeof node.inputs.text === "string");
    const imageNodes = entries.filter(([, node]) => typeof node.inputs.image === "string");
    if (!textNodes.length) throw new Error("ไม่พบ node ที่มี inputs.text ใน Workflow");
    fillNodeSelect($("#video-prompt-node"), textNodes, null);
    fillNodeSelect($("#video-negative-node"), textNodes, "No negative prompt");
    fillNodeSelect($("#video-image-node"), imageNodes, "No starting image");
    if (textNodes.length > 1) $("#video-negative-node").value = textNodes[1][0];
    [$("#video-prompt-node"), $("#video-negative-node"), $("#video-image-node")].forEach(select => { select.disabled = false; });
    notify("นำเข้า Workflow แล้ว เลือก positive/negative prompt node ให้ถูกต้อง");
    await refreshVideoEngineStatus();
  } catch (error) { state.videoWorkflow = null; notify(error.message, true); }
});
$("#video-engine").addEventListener("change", async event => { state.comfyCapabilities.delete(event.target.value); await refreshVideoEngineStatus(); });
$("#video-prompt-node").addEventListener("change", refreshVideoEngineStatus);
$("#video-reference").addEventListener("change", event => {
  const preview = $("#video-reference-preview"); preview.innerHTML = "";
  const file = event.target.files?.[0];
  if (file) { const image = document.createElement("img"); image.alt = file.name; image.src = URL.createObjectURL(file); preview.append(image); }
});
$("#video-form").addEventListener("submit", async event => {
  event.preventDefault();
  const engineId = $("#video-engine").value;
  const promptNodeId = $("#video-prompt-node").value;
  const prompt = $("#video-prompt").value.trim();
  const submit = $("#video-submit");
  setBusy(submit, true, "กำลังส่ง Workflow…");
  try {
    if (!state.videoWorkflow || !engineId || !promptNodeId || !prompt) throw new Error("เลือก Engine, Workflow, Prompt node และ Prompt ให้ครบ");
    const data = new FormData();
    data.append("type", "video.workflow"); data.append("workflow", JSON.stringify(state.videoWorkflow));
    data.append("promptNodeId", promptNodeId); data.append("negativeNodeId", $("#video-negative-node").value);
    data.append("imageNodeId", $("#video-image-node").value); data.append("prompt", prompt);
    data.append("negativePrompt", $("#video-negative").value);
    const image = $("#video-reference").files?.[0];
    if (image) data.append("image", image, image.name);
    const queued = await api("/api/engines/" + encodeURIComponent(engineId) + "/comfy/jobs", { method: "POST", body: data });
    const outputs = await pollComfyJob({ kind: "video", engineId, promptId: queued.promptId });
    if (!outputs) return;
    const videos = outputs.filter(file => /\.(mp4|mov|webm)$/i.test(file.filename));
    const gallery = $("#video-gallery"); gallery.innerHTML = "";
    videos.forEach((file, index) => {
      const card = document.createElement("div"); card.className = "result-video";
      const video = document.createElement("video"); video.controls = true; video.playsInline = true; video.src = file.url;
      const link = document.createElement("a"); link.href = file.url + "?download=1"; link.download = file.filename; link.textContent = "Download video ↓";
      card.append(video, link); gallery.append(card);
    });
    $("#video-result-meta").textContent = videos.length ? "ComfyUI · " + videos.length + " video output(s)" : "Workflow completed, but no MP4/MOV/WebM output was returned.";
    if (!videos.length) throw new Error("Workflow สำเร็จแต่ไม่ส่งไฟล์ MP4, MOV หรือ WebM กลับมา ตรวจ video output node ใน Workflow");
    notify("สร้างวิดีโอเรียบร้อย");
  } catch (error) { notify(error.message, true); }
  finally { setBusy(submit, false); await refreshVideoEngineStatus(); }
});
$("#video-stop").addEventListener("click", () => cancelActiveMediaJob("video"));

const STATUS_LABELS = { ok: "Online", degraded: "Degraded", unauthorized: "Token rejected", unreachable: "Unreachable", unconfigured: "Not set" };
function syncEngineOptions() {
  ["#chat-provider", "#code-provider"].forEach(selector => {
    const select = $(selector);
    const previous = select.value;
    select.querySelectorAll("optgroup[data-engines]").forEach(group => group.remove());
    const usable = state.engines.filter(engine => engine.chatUrl);
    if (usable.length) {
      const group = document.createElement("optgroup");
      group.label = "Locally Uncensored";
      group.dataset.engines = "1";
      usable.forEach(engine => {
        const option = document.createElement("option");
        option.value = "engine:" + engine.id;
        option.textContent = engine.name;
        group.append(option);
      });
      select.append(group);
    }
    if (Array.from(select.options).some(option => option.value === previous)) select.value = previous;
    else { select.selectedIndex = 0; select.dispatchEvent(new Event("change")); }
  });
}
function resetEngineForm() {
  $("#engine-form").reset();
  $("#engine-id").value = "";
  $("#engine-chat-token").placeholder = "Token";
  $("#engine-comfy-token").placeholder = "Token";
  $("#engine-reset").hidden = true;
  $("#engine-result").hidden = true;
}
function renderEngines(engines) {
  state.engines = engines || [];
  fillComfyEngineSelect($("#image-engine"));
  fillComfyEngineSelect($("#video-engine"));
  const list = $("#engine-list");
  list.innerHTML = "";
  const badge = $("#status-engine");
  badge.textContent = state.engines.length ? state.engines.length + " engine" + (state.engines.length > 1 ? "s" : "") : "No engine";
  badge.classList.toggle("connected", state.engines.length > 0);
  state.engines.forEach(engine => {
    const row = document.createElement("div");
    row.className = "engine-item";
    const name = document.createElement("strong");
    name.textContent = engine.name;
    const detail = document.createElement("span");
    detail.className = "muted";
    detail.textContent = [engine.chatUrl && "Chat: " + engine.chatUrl, engine.comfyUrl && "ComfyUI: " + engine.comfyUrl].filter(Boolean).join(" · ");
    const status = document.createElement("span");
    status.className = "provider-status";
    status.textContent = "Not checked";
    const actions = document.createElement("div");
    actions.className = "engine-item-actions";
    const check = document.createElement("button");
    check.type = "button"; check.className = "button subtle small"; check.textContent = "Check";
    check.addEventListener("click", async () => {
      setBusy(check, true, "…");
      try {
        const result = await api("/api/engines/" + encodeURIComponent(engine.id) + "/health");
        const parts = [result.chat, result.comfy].filter(item => item.status !== "unconfigured");
        const worst = parts.find(item => item.status !== "ok");
        const shown = worst || parts[0] || { status: "unconfigured" };
        status.textContent = STATUS_LABELS[shown.status] || shown.status;
        status.classList.toggle("connected", shown.status === "ok");
        status.title = parts.map(item => item.adapter + ": " + item.message).join("\n");
      } catch (error) { notify(error.message, true); }
      finally { setBusy(check, false); }
    });
    actions.append(check);
    if (!engine.managedByEnvironment) {
      const edit = document.createElement("button");
      edit.type = "button"; edit.className = "button subtle small"; edit.textContent = "Edit";
      edit.addEventListener("click", () => {
        $("#engine-id").value = engine.id;
        $("#engine-name").value = engine.name;
        $("#engine-chat-url").value = engine.chatUrl;
        $("#engine-comfy-url").value = engine.comfyUrl;
        $("#engine-chat-timeout").value = Math.round(engine.chatTimeoutMs / 1000);
        $("#engine-comfy-timeout").value = Math.round(engine.comfyTimeoutMs / 1000);
        $("#engine-chat-token").value = "";
        $("#engine-comfy-token").value = "";
        $("#engine-chat-token").placeholder = engine.hasChatToken ? "Token saved · enter a new one to replace" : "Token";
        $("#engine-comfy-token").placeholder = engine.hasComfyToken ? "Token saved · enter a new one to replace" : "Token";
        $("#engine-reset").hidden = false;
        $("#engine-name").focus();
      });
      const remove = document.createElement("button");
      remove.type = "button"; remove.className = "button subtle small"; remove.textContent = "Delete";
      remove.addEventListener("click", async () => {
        if (!confirm("ลบ Engine นี้?")) return;
        try {
          const result = await api("/api/engines/" + encodeURIComponent(engine.id), { method: "DELETE" });
          renderEngines(result.engines);
          syncEngineOptions();
          notify("ลบ Engine แล้ว");
        } catch (error) { notify(error.message, true); }
      });
      actions.append(edit, remove);
    }
    row.append(name, status, detail, actions);
    list.append(row);
  });
}
function engineFormBody() {
  const body = {
    name: $("#engine-name").value.trim(),
    chatUrl: $("#engine-chat-url").value.trim(),
    comfyUrl: $("#engine-comfy-url").value.trim(),
    chatTimeoutMs: (Number($("#engine-chat-timeout").value) || 120) * 1000,
    comfyTimeoutMs: (Number($("#engine-comfy-timeout").value) || 300) * 1000
  };
  const chatToken = $("#engine-chat-token").value.trim();
  const comfyToken = $("#engine-comfy-token").value.trim();
  if (chatToken) body.chatToken = chatToken;
  if (comfyToken) body.comfyToken = comfyToken;
  return body;
}
function showEngineResult(result) {
  const box = $("#engine-result");
  box.hidden = false;
  box.innerHTML = "";
  [result.chat, result.comfy].forEach(item => {
    const line = document.createElement("div");
    const good = item.status === "ok";
    line.className = good ? "ok" : item.status === "unconfigured" ? "muted" : "bad";
    const label = item.adapter === "chat" ? "Chat" : "ComfyUI";
    line.textContent = label + ": " + (STATUS_LABELS[item.status] || item.status) + " — " + item.message +
      (item.latencyMs !== undefined && good ? " (" + item.latencyMs + " ms" + (item.modelCount !== undefined ? ", " + item.modelCount + " models" : "") + ")" : "");
    box.append(line);
  });
}
$("#engine-test").addEventListener("click", async event => {
  const button = event.currentTarget;
  setBusy(button, true, "กำลังทดสอบ…");
  try {
    const body = engineFormBody();
    const id = $("#engine-id").value;
    if (id) body.id = id;
    showEngineResult(await api("/api/engines/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  } catch (error) { notify(error.message, true); }
  finally { setBusy(button, false); }
});
$("#engine-reset").addEventListener("click", resetEngineForm);
$("#engine-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("#engine-save");
  setBusy(button, true, "กำลังบันทึก…");
  try {
    const id = $("#engine-id").value;
    const result = await api(id ? "/api/engines/" + encodeURIComponent(id) : "/api/engines", {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(engineFormBody())
    });
    renderEngines(result.engines);
    state.comfyCapabilities.clear();
    syncEngineOptions();
    resetEngineForm();
    notify("บันทึก Engine แล้ว");
  } catch (error) { notify(error.message, true); }
  finally { setBusy(button, false); }
});
async function loadEngines() {
  try {
    const result = await api("/api/engines");
    renderEngines(result.engines);
    syncEngineOptions();
  } catch (error) { notify(error.message, true); }
}

$$(".key-form:not(.engine-form)").forEach(form => form.addEventListener("submit", async event => {
  event.preventDefault();
  const provider = form.dataset.providerKey;
  const input = $('[data-api-key="' + provider + '"]');
  const button = form.querySelector("button");
  if (!input.value.trim()) return;
  setBusy(button, true, "กำลังบันทึก…");
  try {
    const result = await api("/api/providers/" + provider + "/key", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: input.value.trim() })
    });
    input.value = "";
    renderProviderStatuses(result.providers);
    notify("บันทึก API Key แล้ว");
  } catch (error) { notify(error.message, true); }
  finally { setBusy(button, false); }
}));

async function initialise() {
  try {
    await api("/api/session");
    $("#server-status").textContent = "Server online";
    $(".status-dot").classList.add("ready");
    await loadProviders();
    await loadEngines();
    await Promise.all([
      loadChatModels($("#chat-provider").value, "#chat-model"),
      loadChatModels($("#code-provider").value, "#code-model"),
      loadImageModels()
    ]);
    renderImageModels();
    if ($("#image-backend").value === "comfy") await setImageBackend("comfy");
    await refreshVideoEngineStatus();
  } catch (error) {
    $("#server-status").textContent = "Connection error";
    notify(error.message, true);
  }
}
initialise();
