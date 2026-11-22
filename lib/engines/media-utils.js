const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const OUTPUT_EXTENSIONS = /\.(png|jpe?g|webp|mp4|mov|webm)$/i;
export const VIDEO_OUTPUT_NODES = Object.freeze(["SaveVideo", "SaveWEBM", "VHS_VideoCombine", "VideoCombine"]);

export const COMFY_SESSION_JOB_TTL = 24 * 60 * 60 * 1000;

export function rememberComfySessionJob(session, engineId, promptId, now = Date.now()) {
  const jobs = Object.entries(session.comfyJobs || {})
    .filter(([, entry]) => entry && Number.isFinite(entry.createdAt) && now - entry.createdAt < COMFY_SESSION_JOB_TTL)
    .sort((a, b) => b[1].createdAt - a[1].createdAt)
    .slice(0, 49);
  jobs.push([promptId, { engineId, createdAt: now }]);
  session.comfyJobs = Object.fromEntries(jobs);
  return session.comfyJobs[promptId];
}

export function ownsComfySessionJob(session, engineId, promptId, now = Date.now()) {
  const entry = session.comfyJobs?.[promptId];
  return Boolean(entry && entry.engineId === engineId && Number.isFinite(entry.createdAt)
    && now - entry.createdAt < COMFY_SESSION_JOB_TTL);
}

export function hasValidImageSignature(file) {
  const buffer = file?.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || !IMAGE_MIME.has(file.mimetype)) return false;
  if (file.mimetype === "image/png") return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (file.mimetype === "image/jpeg") return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (file.mimetype === "image/webp") return buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  return false;
}

export function comfyOutputFiles(item) {
  const files = [];
  for (const output of Object.values(item?.outputs || {})) {
    for (const field of ["images", "gifs", "videos", "files"]) {
      for (const value of Array.isArray(output?.[field]) ? output[field] : []) {
        if (value && typeof value.filename === "string" && OUTPUT_EXTENSIONS.test(value.filename)
          && !value.filename.includes("/") && !value.filename.includes("\\") && !value.filename.includes("..")
          && typeof (value.subfolder ?? "") === "string"
          && !String(value.subfolder ?? "").startsWith("/") && !String(value.subfolder ?? "").startsWith("\\")
          && !String(value.subfolder ?? "").split(/[\\/]/).some(part => part === ".." || part === ".")
          && [undefined, "output", "temp"].includes(value.type)) files.push({
          filename: value.filename,
          subfolder: typeof value.subfolder === "string" ? value.subfolder : "",
          type: typeof value.type === "string" ? value.type : "output"
        });
      }
    }
  }
  return files;
}

export function validateComfyWorkflowGraph(graph, objectInfo) {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) return "Workflow must be an object in ComfyUI API prompt format.";
  const entries = Object.entries(graph);
  if (!entries.length || entries.length > 200) return "Workflow must contain between 1 and 200 nodes.";
  for (const [id, node] of entries) {
    if (!/^\d{1,8}$/.test(id) || !node || typeof node !== "object" || Array.isArray(node)
      || typeof node.class_type !== "string" || !objectInfo?.[node.class_type]
      || !node.inputs || typeof node.inputs !== "object" || Array.isArray(node.inputs)) {
      return `Workflow node ${id} is invalid or not installed on the selected ComfyUI server.`;
    }
    const schema = objectInfo[node.class_type]?.input || {};
    const supportedInputs = new Set([
      ...Object.keys(schema.required || {}),
      ...Object.keys(schema.optional || {})
    ]);
    for (const [inputName, inputValue] of Object.entries(node.inputs)) {
      if (!supportedInputs.has(inputName)) {
        return `Workflow node ${id} (${node.class_type}) uses an input that is not present in the installed /object_info schema: ${inputName}.`;
      }
      if (Array.isArray(inputValue) && inputValue.length === 2
        && typeof inputValue[0] === "string" && /^\d{1,8}$/.test(inputValue[0])
        && Number.isInteger(inputValue[1]) && !Object.prototype.hasOwnProperty.call(graph, inputValue[0])) {
        return `Workflow node ${id} links to missing node ${inputValue[0]}.`;
      }
    }
  }
  const hasVideoOutput = entries.some(([, node]) => VIDEO_OUTPUT_NODES.includes(node.class_type));
  if (!hasVideoOutput) return "Workflow must include an installed video output node (SaveVideo, SaveWEBM or a supported video combine node).";
  return null;
}
