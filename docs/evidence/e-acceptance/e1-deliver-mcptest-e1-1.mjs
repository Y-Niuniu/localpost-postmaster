import { pathToFileURL } from 'node:url';
const { createMailbox } = await import(pathToFileURL('C:/AI_ASSIST/tools/dsh-localpost-postmaster/localpost/mailbox.mjs').href);
const root = 'C:/AI_ASSIST/work/localpost-e-test';
const mb = createMailbox({ root, identity: 'codex' });
const out = await mb.deliver({
  id: 'mcptest-e1-1', from: 'codex', to: 'dsh', type: 'task',
  subject: 'mcptest E1 arrival-lock probe',
  body: 'E1: this letter must stay routed to the chat that was bound when it arrived.',
});
console.log('DELIVER=' + JSON.stringify(out));