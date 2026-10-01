import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const folders = ["src", "bin", "tools", "test"];
for (const folder of folders) for (const name of readdirSync(folder)) {
  if (!/\.(mjs|js)$/.test(name)) continue;
  const path = `${folder}/${name}`;
  const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  if (result.status) throw new Error(result.stderr);
  const source = readFileSync(path, "utf8");
  if (folder === "src" && /\bMath\.random\s*\(/.test(source)) throw new Error(`${path}: use engine-owned randomness.`);
  if (/[ \t]+$/m.test(source)) throw new Error(`${path}: trailing whitespace.`);
}
console.log("Source syntax, whitespace and deterministic-randomness checks passed.");
