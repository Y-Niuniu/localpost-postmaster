import { pathToFileURL } from 'node:url';
const { createMailbox } = await import(pathToFileURL('C:/AI_ASSIST/tools/dsh-localpost-postmaster/localpost/mailbox.mjs').href);
const root = 'C:/AI_ASSIST/work/localpost-e-test';
const mb = createMailbox({ root, identity: 'codex' });
const out = await mb.deliver({
  id: 'mcptest-e1b-1', from: 'codex', to: 'dsh', type: 'task',
  subject: 'mcptest E1b arrival-lock probe (fresh root)',
  body: 'E1b: arrival must pin the bound chat; a later bind attempt from another chat must not move it.',
});
console.log('DELIVER=' + JSON.stringify(out));