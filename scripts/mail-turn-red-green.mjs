/**
 * Red/green evidence for the mail-turn allowlist (C1), judged against the REAL historical b-probe policy.
 *
 *   node scripts/mail-turn-red-green.mjs [path-to-b-probe-policy.mjs]
 *
 * Red:   the b-probe prefix policy (work/b-probe/probe-plugin/lib/policy.mjs) admits names of the gate. Its sha256 is
 *        checked before it is imported; the module is pure (no imports, no IO), so importing it only reads the file.
 * Green: the exact allowlist (mailTurnReason over a registry that holds the bridge's five definitions) admits none of
 *        the gate and all five real tools.
 * Prints every admitted name; exit 0 only when both hold, 2 when the historical policy is absent or not the reviewed one.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { TOOL_NAMES, mailTurnReason } from '../localpost/dsh-mail-tools.mjs';
import { GATE, REVIEW_NAMED } from '../localpost/fixtures/mail-turn-gate.mjs';

const LEGACY = process.argv[2] ?? 'C:/AI_ASSIST/work/b-probe/probe-plugin/lib/policy.mjs';
const LEGACY_SHA256 = '708f7c2c419dc2ed0af4a074ec22b01bbd06eea54126b51e77edcf5a219ec2b0';
const show = names => names.map(name => JSON.stringify(name)).join(', ') || '(none)';

let bytes;
try { bytes = fs.readFileSync(LEGACY); } catch (error) { console.log('LEGACY absent: ' + LEGACY + ' (' + error.code + ')'); process.exit(2); }
const sha256 = createHash('sha256').update(bytes).digest('hex');
if (sha256 !== LEGACY_SHA256) { console.log('LEGACY changed: sha256 ' + sha256 + ' != reviewed ' + LEGACY_SHA256); process.exit(2); }
const legacy = await import(pathToFileURL(LEGACY).href);

// The bridge's five definitions, as the registry holds them (a registration is keyed by the definition's own name).
const definitions = new Map(TOOL_NAMES.map(name => [name, { name }]));
const tools = { get: name => definitions.get(name) };
const ours = new Map(TOOL_NAMES.map(name => [name, new Set([definitions.get(name)])]));
const agent = { session: { id: 'chat-A', header: { cwd: 'C:/work/A' } } };
const exactAdmits = name => mailTurnReason(tools, ours, { name, agent }) === undefined;
const legacyAdmits = name => legacy.decide(name).allowed === true;

const legacyGate = GATE.filter(legacyAdmits);
const exactGate = GATE.filter(exactAdmits);
const legacyReal = TOOL_NAMES.filter(legacyAdmits);
const exactReal = TOOL_NAMES.filter(exactAdmits);
console.log('legacy policy : ' + LEGACY + ' sha256=' + sha256 + ' pattern=/' + legacy.ALLOWLIST_SOURCE + '/');
console.log('gate          : ' + GATE.length + ' names (localpost/fixtures/mail-turn-gate.mjs)');
console.log('RED   legacy admits ' + legacyGate.length + '/' + GATE.length + ' gate names: ' + show(legacyGate));
console.log('      legacy admits ' + legacyReal.length + '/' + TOOL_NAMES.length + ' real tools');
console.log('GREEN exact  admits ' + exactGate.length + '/' + GATE.length + ' gate names: ' + show(exactGate));
console.log('      exact  admits ' + exactReal.length + '/' + TOOL_NAMES.length + ' real tools');
const red = REVIEW_NAMED.every(legacyAdmits);
const green = exactGate.length === 0 && exactReal.length === TOOL_NAMES.length;
console.log('VERDICT red=' + red + ' (the review\'s ' + REVIEW_NAMED.length + ' names all admitted by the legacy prefix) green=' + green);
process.exit(red && green ? 0 : 1);
