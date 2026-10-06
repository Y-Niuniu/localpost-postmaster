/**
 * 独立验证：宿主 v4 会话格式对 `message.source.kind` 的受理契约。
 *
 * 运行方式（DSH harness 的 run_code / PTC 程序内，该运行时是 Electron-node，可直接 import app.asar 内路径）：
 *   await import("file:///C:/AI_ASSIST/work/e2-contract/verify-source-kind.mjs")
 * 也可以从任意 Electron 内核的 node 里用 `await import(url)` 调用 `verify(path)`。
 *
 * 产出：每条候选 source 形态在「写入路径（encodeEvent）」与「行级受理（assertV4RowAdmission）」上的结果。
 */
export const HOST_ASAR = "C:/Users/16548/AppData/Local/Programs/DeepSeek Harness/resources/app.asar";
const MODULE_PATH = "/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js";

export async function loadHostFormat(asar = HOST_ASAR) {
  return import("file:///" + (asar + MODULE_PATH).replace(/ /g, "%20"));
}

const row = source => ({
  type: "user/message", seq: 7, time: 1,
  data: { id: "msg-1", role: "user", content: [{ type: "text", text: "LocalPost relay" }], source },
});

export const SHAPES = [
  ["current adapter  {kind:'plugin',plugin:'localpost',form:'relay'}", { kind: "plugin", plugin: "localpost", form: "relay" }],
  ["recommended      {kind:'plugin:localpost',form:'relay'}", { kind: "plugin:localpost", form: "relay" }],
  ["alt              {kind:'localpost',form:'relay'}", { kind: "localpost", form: "relay" }],
  ["first-class      {kind:'agent-message',form:'relay'}", { kind: "agent-message", form: "relay" }],
  ["empty kind       {kind:''}", { kind: "" }],
  ["bare wrapper     {kind:'plugin'}", { kind: "plugin" }],
  ["built-in         {kind:'user'}", { kind: "user" }],
];

export function verify(mod) {
  const out = [];
  for (const [label, source] of SHAPES) {
    const result = { label, rowAdmission: "PASS", encodeEvent: "PASS" };
    try { mod.assertV4RowAdmission(row(source)); } catch (e) { result.rowAdmission = "THROW " + e.message; }
    try { mod.releasedV4SessionFormatCodec.encodeEvent(row(source)); } catch (e) { result.encodeEvent = "THROW " + e.message; }
    out.push(result);
  }
  return out;
}

const mod = await loadHostFormat();
const results = verify(mod);
for (const r of results) console.log(r.label + "\n    assertV4RowAdmission: " + r.rowAdmission + "\n    encodeEvent:          " + r.encodeEvent);
const ok = results.filter(r => r.encodeEvent === "PASS").map(r => r.label.trim().split(" ")[0]);
console.log("\n写入路径不抛异常的形态：" + ok.join(", "));
