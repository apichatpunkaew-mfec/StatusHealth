import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules", ".bin", "wrangler");
const configPath = path.resolve(root, process.env.KV_CONFIG_PATH ?? "wrangler.toml");
const title = process.env.KV_NAMESPACE_TITLE ?? "HEALTH_KV";

function runWrangler(args) {
  try {
    return execFileSync(wrangler, args, { cwd: root, encoding: "utf8" });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.stdout?.toString().trim() || error.message;
    throw new Error(`wrangler ${args.join(" ")} failed:\n${detail}`);
  }
}

function parseNamespaceList(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end <= start) {
    throw new Error(`Cannot parse namespace list output:\n${output}`);
  }
  const list = JSON.parse(output.slice(start, end + 1));
  if (!Array.isArray(list)) throw new Error("Namespace list is not an array");
  return list;
}

function finalizeBlock(block, id) {
  if (!block.some((line) => /^binding\s*=\s*"HEALTH_KV"\s*$/.test(line))) {
    return { lines: block, found: false };
  }

  let hasId = false;
  const lines = block.map((line) => {
    if (/^id\s*=/.test(line)) {
      hasId = true;
      return `id = "${id}"`;
    }
    return line;
  });

  if (!hasId) {
    const at = lines.findIndex((line) => /^binding\s*=/.test(line));
    lines.splice(at + 1, 0, `id = "${id}"`);
  }

  return { lines, found: true };
}

function updateConfig(id) {
  const original = fs.readFileSync(configPath, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const output = [];
  let block = null;
  let updated = false;

  const flush = () => {
    if (!block) return;
    const result = finalizeBlock(block, id);
    output.push(...result.lines);
    if (result.found) updated = true;
    block = null;
  };

  for (const line of lines) {
    if (/^\[\[kv_namespaces\]\]\s*$/.test(line)) {
      flush();
      block = [line];
      continue;
    }
    if (block && /^\[/.test(line)) {
      flush();
      output.push(line);
      continue;
    }
    if (block) block.push(line);
    else output.push(line);
  }
  flush();

  if (!updated) {
    while (output.length > 0 && output[output.length - 1] === "") output.pop();
    output.push("", "[[kv_namespaces]]", 'binding = "HEALTH_KV"', `id = "${id}"`);
  }

  const next = output.join(eol) + (original.endsWith(eol) ? "" : eol);
  const changed = next !== original;
  if (changed) fs.writeFileSync(configPath, next);
  return changed;
}

let namespaces = parseNamespaceList(runWrangler(["kv", "namespace", "list"]));
let namespace = namespaces.find((item) => item?.title === title);
let created = false;

if (!namespace) {
  console.log(`KV namespace "${title}" not found - creating...`);
  runWrangler(["kv", "namespace", "create", title]);
  namespaces = parseNamespaceList(runWrangler(["kv", "namespace", "list"]));
  namespace = namespaces.find((item) => item?.title === title);
  created = true;
}

if (!namespace?.id) throw new Error(`Cannot resolve id for namespace "${title}"`);

const changed = updateConfig(namespace.id);
console.log(`${created ? "Created" : "Reused"} ${title}: ${namespace.id}`);
console.log(`wrangler.toml ${changed ? "updated" : "already up to date"}: ${configPath}`);
