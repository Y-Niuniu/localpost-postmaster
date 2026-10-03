import { createReceiver } from './receiver.mjs';

const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const root = value('--root'), agent = value('--agent');
if (!root || !agent || !['status', 'receive'].includes(args[0])) {
  console.error('Usage: node receiver-cli.mjs status|receive --root PATH --agent NAME [--allow-from dsh --enable]');
  process.exitCode = 2;
} else {
  const receiver = createReceiver({ root, agent, allowFrom: (value('--allow-from') || '').split(',').filter(Boolean) });
  if (args[0] === 'status') console.log(JSON.stringify(await receiver.snapshot(), null, 2));
  else if (!args.includes('--enable') || !value('--allow-from')) {
    console.error('Reception requires explicit --enable and --allow-from; first scan excludes existing backlog.');
    process.exitCode = 2;
  } else {
    await receiver.start();
    console.log(JSON.stringify({ receiver: 'started', dispatch: 'disabled', reason: 'explicit_binding_and_acceptance_unverified' }));
    const shutdown = async () => { await receiver.stop(); process.exitCode = 0; };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  }
}
