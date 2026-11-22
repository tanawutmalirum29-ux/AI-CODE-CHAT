import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const output = path.join(root, ".amplify-hosting");
const compute = path.join(output, "compute", "default");
const staticDir = path.join(output, "static");

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(compute, { recursive: true });
await fs.mkdir(staticDir, { recursive: true });

for (const file of ["server.js", "package.json"]) {
  await fs.copyFile(path.join(root, file), path.join(compute, file));
}
for (const directory of ["lib", "node_modules", "public"]) {
  await fs.cp(path.join(root, directory), path.join(compute, directory), { recursive: true });
}
await fs.cp(path.join(root, "public"), staticDir, { recursive: true });
await fs.copyFile(path.join(root, "deploy-manifest.json"), path.join(output, "deploy-manifest.json"));
console.log("Amplify deployment bundle created at .amplify-hosting/");
