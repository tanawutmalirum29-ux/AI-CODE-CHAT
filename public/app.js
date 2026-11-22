const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));
const state = {
  chatMessages: [],
  providerStatuses: [],
  workspaceId: null,
  imageMode: "generate",
  imageModels: []
};
let toastTimer;

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
  const titles = { chat: "AI Chat", code: "Code Workspace", images: "Image Studio", settings: "Settings & API" };
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
    select.innerHTML = '<option value="deepseek-v4.1-flash-1017-uncensored">DeepSeek V4.1 Flash Uncensored</option>';
  }
}
$("#chat-provider").addEventListener("change", event => loadChatModels(event.target.value, "#chat-model"));
$("#code-provider").addEventListener("change", event => loadChatModels(event.target.value, "#code-model"));

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
    const result = await api("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider, model, messages,
        temperature: Number($("#chat-temperature").value) || 0.7,
        maxTokens: 2048
      })
    });
    pending.textContent = result.text;
    state.chatMessages.push({ role: "assistant", content: result.text });
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
function renderImageModels() {
  const select = $("#image-model");
  const relevant = state.imageModels.filter(model => model.operation === state.imageMode);
  select.innerHTML = "";
  relevant.forEach(model => {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.name + (model.price ? " · " + model.price : "");
    select.append(option);
  });
  if (state.imageMode === "generate" && relevant.some(model => model.id === "z-image-turbo")) select.value = "z-image-turbo";
  if (state.imageMode === "edit" && relevant.some(model => model.id === "qwen-edit-uncensored")) select.value = "qwen-edit-uncensored";
}
function setImageMode(mode) {
  state.imageMode = mode;
  $$(".mode-button").forEach(button => {
    const active = button.dataset.imageMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  $("#reference-wrap").hidden = mode !== "edit";
  $("#negative-label").hidden = mode === "edit";
  $("#negative-prompt").hidden = mode === "edit";
  $("#count-wrap").hidden = mode === "edit";
  $("#image-submit").textContent = mode === "edit" ? "Edit reference image ↗" : "Generate image ↗";
  renderImageModels();
}
$$(".mode-button").forEach(button => button.addEventListener("click", () => setImageMode(button.dataset.imageMode)));
$("#reference-images").addEventListener("change", event => {
  const files = Array.from(event.target.files || []).slice(0, 3);
  const preview = $("#reference-preview");
  preview.innerHTML = "";
  files.forEach(file => {
    const image = document.createElement("img");
    image.alt = file.name;
    image.src = URL.createObjectURL(file);
    preview.append(image);
  });
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
$("#image-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("#image-submit");
  const model = $("#image-model").value;
  const prompt = $("#image-prompt").value.trim();
  const size = $("#image-size").value;
  setBusy(button, true, state.imageMode === "edit" ? "กำลังแก้ภาพ…" : "กำลังสร้างภาพ…");
  try {
    let result;
    if (state.imageMode === "edit") {
      const files = Array.from($("#reference-images").files || []).slice(0, 3);
      if (!files.length) throw new Error("เลือกภาพอ้างอิงอย่างน้อย 1 ภาพ");
      const data = new FormData();
      data.append("model", model);
      data.append("prompt", prompt);
      data.append("size", size);
      files.forEach(file => data.append("images", file, file.name));
      result = await api("/api/images/edit", { method: "POST", body: data });
    } else {
      result = await api("/api/images/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model, prompt, size,
          count: Number($("#image-count").value),
          negativePrompt: $("#negative-prompt").value
        })
      });
    }
    renderGeneratedImages(result);
    notify("สร้างภาพเรียบร้อย");
  } catch (error) { notify(error.message, true); }
  finally { setBusy(button, false); }
});

$$(".key-form").forEach(form => form.addEventListener("submit", async event => {
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
    await Promise.all([
      loadChatModels($("#chat-provider").value, "#chat-model"),
      loadChatModels($("#code-provider").value, "#code-model"),
      loadImageModels()
    ]);
  } catch (error) {
    $("#server-status").textContent = "Connection error";
    notify(error.message, true);
  }
}
initialise();
