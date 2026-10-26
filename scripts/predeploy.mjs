import fs from "node:fs";

const entry = "index.js";
const code = fs.readFileSync(entry, "utf8");
console.log("--- predeploy entry head ---");
console.log(code.split("\n").slice(0, 12).join("\n"));
console.log("----------------------------");

if (!code.includes("export default")) {
  console.error("FAIL: index.js missing export default (Wrangler would treat as service-worker)");
  process.exit(1);
}
if (!code.includes("export class AstonSession")) {
  console.error("FAIL: index.js missing export class AstonSession");
  process.exit(1);
}
console.log("predeploy OK: ES module + Durable Object classes present");
