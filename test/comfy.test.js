import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { inspectComfyCapabilities, buildImageWorkflow, streamComfyOutput } from "../lib/engines/comfy-adapter.js";
import { EngineError } from "../lib/engines/net-guard.js";

const LOCAL = { allowHttp: false, allowedHosts: new Set(["127.0.0.1"]) };
const profileFor = base => ({ id: "comfy-test", name: "Comfy test", comfyUrl: base, comfyAuthScheme: "bearer", comfyTimeoutMs: 5000 });
const json = (res, status, payload) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(payload)); };
function infoNode(required, optional = {}) { return { input: { required, optional } }; }

function fullObjectInfo() {
  return {
    CheckpointLoaderSimple: infoNode({ ckpt_name: [["test-model.safetensors"], {}] }),
    CLIPTextEncode: infoNode({ text: ["STRING", {}], clip: ["CLIP", {}] }),
    KSampler: infoNode({ seed: ["INT", {}], steps: ["INT", {}], cfg: ["FLOAT", {}], sampler_name: [["euler", "dpmpp_2m"], {}], scheduler: [["normal", "karras"], {}], denoise: ["FLOAT", {}], model: ["MODEL", {}], positive: ["CONDITIONING", {}], negative: ["CONDITIONING", {}], latent_image: ["LATENT", {}] }),
    VAEDecode: infoNode({ samples: ["LATENT", {}], vae: ["VAE", {}] }),
    SaveImage: infoNode({ filename_prefix: ["STRING", {}], images: ["IMAGE", {}] }),
    EmptyLatentImage: infoNode({ width: ["INT", {}], height: ["INT", {}], batch_size: ["INT", {}] }),
    LoadImage: infoNode({ image: [["upload.png"], {}] }),
    VAEEncode: infoNode({ pixels: ["IMAGE", {}], vae: ["VAE", {}] }),
    LoadImageMask: infoNode({ image: [["mask.png"], {}], channel: [["red", "green", "blue", "alpha"], {}] }),
    InpaintModelConditioning: infoNode({ positive: ["CONDITIONING", {}], negative: ["CONDITIONING", {}], vae: ["VAE", {}], pixels: ["IMAGE", {}], mask: ["MASK", {}], noise_mask: ["BOOLEAN", {}] }),
    SaveVideo: infoNode({ video: ["VIDEO", {}], filename_prefix: ["STRING", {}] })
  };
}

async function withServer(payload, fn) {
  const server = http.createServer((_req, res) => json(res, 200, payload));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
}

test("ComfyUI capability discovery enables only workflows matching installed node schemas", async () => {
  await withServer(fullObjectInfo(), async base => {
    const caps = await inspectComfyCapabilities(profileFor(base), "test-token", LOCAL);
    assert.equal(caps.image.txt2img, true);
    assert.equal(caps.image.img2img, true);
    assert.equal(caps.image.inpaint, true);
    assert.deepEqual(caps.image.models, ["test-model.safetensors"]);
    assert.deepEqual(caps.image.samplers, ["euler", "dpmpp_2m"]);
    assert.equal(caps.video.customWorkflow, true);
    assert.deepEqual(caps.video.outputNodes, ["SaveVideo"]);
  });
});

test("ComfyUI hides inpainting when the required mask channel or conditioning schema is missing", async () => {
  const info = fullObjectInfo();
  info.LoadImageMask.input.required.channel[0] = ["red", "blue"];
  delete info.InpaintModelConditioning.input.required.noise_mask;
  await withServer(info, async base => {
    const caps = await inspectComfyCapabilities(profileFor(base), "", LOCAL);
    assert.equal(caps.image.txt2img, true);
    assert.equal(caps.image.img2img, true);
    assert.equal(caps.image.inpaint, false);
    assert.ok(caps.image.missing.inpaint.includes("InpaintModelConditioning.noise_mask"));
    assert.ok(caps.image.missing.inpaint.includes("LoadImageMask.channel=green"));
  });
});

test("capability discovery rejects HTTP errors instead of inventing a model catalogue", async () => {
  const server = http.createServer((_req, res) => json(res, 503, { error: "offline" }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(inspectComfyCapabilities(profileFor(base), "", LOCAL), error => error instanceof EngineError && error.status === 502);
  } finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
});

test("ComfyUI workflow templates create txt2img, img2img and inpaint graphs from discovered choices", () => {
  const capabilities = { image: {
    txt2img: true, img2img: true, inpaint: true,
    models: ["test-model.safetensors"], samplers: ["euler"], schedulers: ["normal"],
    missing: { txt2img: [], img2img: [], inpaint: [] }
  }};
  const params = { model: "test-model.safetensors", prompt: "A mountain scene", negativePrompt: "blur", width: 1024, height: 768, count: 2, steps: 20, cfg: 6.5, seed: 42, sampler: "euler", scheduler: "normal" };
  const txt = buildImageWorkflow({ type: "image.txt2img", params, capabilities });
  assert.equal(txt.prompt["4"].class_type, "EmptyLatentImage");
  assert.equal(txt.prompt["4"].inputs.batch_size, 2);
  assert.equal(txt.prompt["5"].inputs.latent_image[0], "4");
  const edit = buildImageWorkflow({ type: "image.img2img", params, capabilities, imageName: "input.png" });
  assert.equal(edit.prompt["4"].class_type, "LoadImage");
  assert.equal(edit.prompt["8"].class_type, "VAEEncode");
  const inpaint = buildImageWorkflow({ type: "image.inpaint", params, capabilities, imageName: "input.png", maskName: "mask.png" });
  assert.equal(inpaint.prompt["8"].inputs.channel, "green");
  assert.equal(inpaint.prompt["9"].class_type, "InpaintModelConditioning");
  assert.equal(inpaint.prompt["5"].inputs.latent_image[0], "9");
});

test("ComfyUI refuses to build a workflow disabled by the detected capabilities", () => {
  assert.throws(() => buildImageWorkflow({ type: "image.inpaint", params: {}, capabilities: { image: { inpaint: false, missing: { inpaint: ["LoadImageMask"] } } } }), error => error.code === "capability_missing");
});


test("ComfyUI large media downloads are exposed as a guarded stream, not a buffered response", async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/view?filename=clip.mp4&subfolder=video&type=output");
    assert.equal(req.headers.authorization, "Bearer test-token");
    res.writeHead(200, { "Content-Type": "video/mp4" });
    res.write(Buffer.alloc(1024, 7));
    res.end(Buffer.alloc(1024, 8));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await streamComfyOutput({ profile: profileFor(base), token: "test-token", file: { filename: "clip.mp4", subfolder: "video", type: "output" }, policy: LOCAL });
    const chunks = [];
    for await (const chunk of response.stream) chunks.push(chunk);
    assert.equal(response.status, 200);
    assert.equal(Buffer.concat(chunks).length, 2048);
  } finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
});
