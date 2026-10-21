import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = path.resolve(import.meta.dirname, "../../..");
const allowlist = {
  "skillping": [".codex-plugin/plugin.json", "LICENSE", "hooks/hooks.json", "skills/skillping/SKILL.md", "skills/skillping/agents/openai.yaml", "skills/skillping-help/SKILL.md", "skills/skillping-help/agents/openai.yaml"],
  "skillping-runtime": ["LICENSE","THIRD_PARTY_NOTICES.md","dist/mcp/server.bundle.js","mcp.json","package.json","plugin.json","prompts/extract-v6.md","prompts/review-v3.md","third-party/find-skills/LICENSE","third-party/find-skills/SKILL.md","third-party/find-skills/SOURCE.md"]
};
const marketplaceFile = ".agents/plugins/marketplace.json";
const rootFiles = [marketplaceFile, "LICENSE", "README.md", "README.zh-CN.md", "install.ps1", "docs/assets/skillping-mark.svg", "docs/installation.md"];
const receiptName = ".skillping-release.json";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const unknown = () => new Error("unrecognized release output; preserve it and choose a new task-owned output");

async function inventory(root, prefix = "") {
  const entries = {};
  for (const item of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix + item.name;
    if (!prefix && name === receiptName && item.isFile()) continue;
    if (item.isDirectory()) {
      entries[name + "/"] = null;
      Object.assign(entries, await inventory(root, name + "/"));
    } else if (item.isFile()) entries[name] = hash(await readFile(path.join(root, name)));
    else throw unknown();
  }
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}

export async function buildRelease(outputRoot = path.join(workspace, "artifacts/plugins")) {
  outputRoot = path.resolve(outputRoot);
  // Reject junctions before traversing either an existing root or its ancestors.
  for (let current = outputRoot; ; current = path.dirname(current)) {
    const stat = await lstat(current).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw unknown();
    if (path.dirname(current) === current) break;
  }
  const exists = await lstat(outputRoot).then(() => true, () => false);
  if (exists) {
    const receiptPath = path.join(outputRoot, receiptName);
    const receiptStat = await lstat(receiptPath).catch(() => { throw unknown(); });
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) throw unknown();
    const previous = await readFile(receiptPath, "utf8").then(JSON.parse).catch(() => { throw unknown(); });
    if (previous.owner !== "skillping-release-v1" || JSON.stringify(previous.entries) !== JSON.stringify(await inventory(outputRoot))) throw unknown();
    const previousFiles = Object.keys(previous.entries).filter(name => !name.endsWith("/")).sort();
    const componentFiles = Object.entries(allowlist).flatMap(([name, files]) => files.map(file => `${name}/${file}`)).sort();
    const allowedFiles = [...rootFiles, ...componentFiles].sort();
    if (JSON.stringify(previousFiles) !== JSON.stringify(allowedFiles)) throw unknown();
  }
  const copies = [];
  for (const [name, files] of [["", rootFiles], ...Object.entries(allowlist)]) for (const file of files) {
    const source = name ? path.join(workspace, "plugins", name, file) : path.join(workspace, file);
    if (!(await lstat(source)).isFile()) throw new Error("release source must be a regular file");
    let bytes = await readFile(source);
    if (!name && file === marketplaceFile) {
      const catalog = JSON.parse(bytes);
      for (const entry of catalog.plugins) {
        const packageName = path.basename(entry.source.path);
        if (entry.source.source !== "local" || !Object.hasOwn(allowlist, packageName) ||
            path.resolve(workspace, entry.source.path) !== path.join(workspace, "distribution", packageName)) {
          throw new Error("release marketplace must select bundled plugins");
        }
        entry.source.path = `./${packageName}`;
      }
      bytes = Buffer.from(JSON.stringify(catalog, null, 2) + "\n");
    }
    if (!name && (file === "README.md" || file === "README.zh-CN.md")) {
      bytes = Buffer.from(bytes.toString("utf8").replaceAll("plugins/skillping-runtime/THIRD_PARTY_NOTICES.md", "skillping-runtime/THIRD_PARTY_NOTICES.md"));
    }
    if (name === "skillping-runtime" && file === "package.json") {
      const { name, version, private: privatePackage, license, type, engines } = JSON.parse(bytes);
      bytes = Buffer.from(JSON.stringify({ name, version, private: privatePackage, license, type, engines }, null, 2) + "\n");
    }
    copies.push({ destination: path.join(outputRoot, name, file), bytes });
  }
  await mkdir(outputRoot, { recursive: true });
  for (const { destination, bytes } of copies) {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: exists ? "w" : "wx" });
  }
  await writeFile(path.join(outputRoot, receiptName), JSON.stringify({ owner: "skillping-release-v1", entries: await inventory(outputRoot) }, null, 2) + "\n", { flag: exists ? "w" : "wx" });
  return outputRoot;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await buildRelease(process.argv[2]);
  console.log(`release marketplace built: ${rootFiles.length} root files, Hook ${allowlist["skillping"].length} files, Runtime ${allowlist["skillping-runtime"].length} files`);
}
