import fs from 'node:fs';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { createMailbox } from '../../tools/dsh-localpost-postmaster/localpost/mailbox.mjs';
const root = 'C:/AI_ASSIST/work/localpost-e-test';
const id = 'mcptest-e2-368-9bf8f0ac-5626-4c59-86cb-c6792a49e11a';
const sessionFile = 'C:/Users/16548/.dsh/sessions/--C-AI_ASSIST--/session-16854214-d220-4ecc-8e57-65fa5df3fbcd/session.v4.jsonl.zstd';
const compressed = fs.readFileSync(sessionFile);
const frames = [];
let offset = 0;
while (offset < compressed.length) {
  const decoded = zstdDecompressSync(compressed.subarray(offset), { info: true });
  const consumed = decoded.engine.bytesWritten;
  if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > compressed.length - offset) throw new Error('Unverified compressed frame boundary');
  frames.push(decoded.buffer);
  offset += consumed;
}
const text = Buffer.concat(frames).toString('utf8');
const rows = text.split('\n').filter(line => line.trim());
console.log('DECODE=' + JSON.stringify({ compressedBytes: compressed.length, consumedBytes: offset, frames: frames.length, textBytes: Buffer.byteLength(text), rows: rows.length }));
const events = rows.filter(line => line.includes(id));
console.log('MATCHING_EVENT_COUNT=' + events.length);
for (const line of events) {
  const event = JSON.parse(line);
  if (event.type === 'assistant/message') continue;
  console.log('EVENT=' + JSON.stringify(event));
}
for (const row of rows) {
  const event = JSON.parse(row);
  if (event.type === 'tool/call') console.log('TOOL_CALL=' + JSON.stringify({ seq: event.seq, at: new Date(event.time).toISOString(), name: event.data?.name, args: event.data?.name?.startsWith('localpost_') ? event.data?.arguments : undefined }));
  if (event.type === 'tool/result') {
    const message = event.data?.message;
    const texts = message?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
    if (texts.includes('binding yet') || texts.startsWith('LocalPost: mode=')) console.log('BINDING_RESULT=' + JSON.stringify({ seq: event.seq, at: new Date(event.time).toISOString(), isError: message.isError, text: texts }));
  }
  if (['turn/start', 'turn/end', 'agent/turn/start', 'agent/turn/end', 'user/message'].includes(event.type)) console.log('TURN_EVENT=' + JSON.stringify({ type: event.type, seq: event.seq, at: new Date(event.time).toISOString(), id: event.data?.id, source: { kind: event.data?.source?.kind, form: event.data?.source?.form } }));
}
for (const bucket of ['inbox', 'archive']) {
  const dir = path.join(root, 'agents/codex', bucket);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
    const letter = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (letter.reply_to === id) console.log('REPLY=' + JSON.stringify({ bucket, ...letter }));
    if (process.argv.includes('--archive-result') && bucket === 'inbox' && letter.reply_to === id && letter.type === 'result' && letter.from === 'dsh' && letter.to === 'codex' && letter.outcome === 'completed') {
      console.log('ARCHIVE=' + JSON.stringify(await createMailbox({ root, identity: 'codex' }).archive('codex', letter.id)));
    }
  }
}
