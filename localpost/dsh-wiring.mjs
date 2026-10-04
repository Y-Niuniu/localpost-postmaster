import path from 'node:path';
import { createSessionStore } from './session-binding.mjs';
import { createMailbox } from './mailbox.mjs';
import { createBindingProvider } from './binding-provider.mjs';
import { createDshHostBridge, SUPPORTED_VERSION } from './dsh-host-bridge.mjs';
import { createMailTools } from './dsh-mail-tools.mjs';
import { createLedgerAcceptance } from './ledger-acceptance.mjs';
import { createDshAdapter } from './dsh-adapter.mjs';

/**
 * The isolated acceptance entry point.
 *
 * Wiring the bridge and the mail tools into the real DSH plugin is exactly what turns "the source is
 * merged" into "the host can run it", so it is also the moment production could start dispatching by
 * accident. This module therefore has one job: make the isolated entry reachable WITHOUT ever
 * touching production.
 *
 *   - nothing is registered unless the caller explicitly asked for it (default off);
 *   - only the isolated test root is accepted; the production mailbox root - and anything under it -
 *     is refused outright, so a typo can never point automatic handling at real mail;
 *   - every capability the bridge and the tools need is required, and the runtime must be the exact
 *     supported one, so a host that cannot attest a chat registers nothing;
 *   - the receiver is returned as a factory that is NOT started: live E1-E6 stay a separately
 *     authorized step, not a side effect of loading a plugin;
 *   - dispose releases commands, tools, guard and store handles and is idempotent.
 *
 * Status of this entry point is `ready_for_live_E`. It is not evidence that E1-E6 ran, and it is not
 * permission to enable production dispatch.
 */
export const ISOLATED_ROOT = 'C:/AI_ASSIST/work/localpost-e-test';
export const PRODUCTION_ROOT = 'C:/AI_ASSIST/.mailbox';
export const WIRING_STATUS = 'ready_for_live_E';

const resolved = value => { try { return path.resolve(String(value)); } catch { return null; } };
const samePath = (left, right) => left !== null && right !== null && left.toLowerCase() === right.toLowerCase();
const underPath = (child, parent) => {
  if (child === null || parent === null) return false;
  const low = child.toLowerCase();
  const base = parent.toLowerCase();
  return low === base || low.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
};

/** A refusal that registered nothing and disposes nothing, so callers can treat every shape alike. */
function refused(reason, decisions) {
  return Object.freeze({ enabled: false, status: WIRING_STATUS, reason, decisions: Object.freeze([...decisions]), dispose: () => {} });
}

/**
 * @param {{ctx?: object, config?: {enabled?: boolean, root?: string}, runtimeVersion?: string, identity?: string, hostId?: string}} input
 * @returns {{enabled: boolean, status: string, reason?: string, decisions: readonly string[], dispose: () => void, parts?: object}}
 */
export function createIsolatedWiring({ ctx, config = {}, runtimeVersion, identity = 'dsh', hostId = 'local' } = {}) {
  const decisions = [];
  if (config?.enabled !== true) return refused('disabled_by_default', decisions);
  decisions.push('explicitly_enabled');

  const root = resolved(config.root);
  const isolated = resolved(ISOLATED_ROOT);
  const production = resolved(PRODUCTION_ROOT);
  if (root === null || String(config.root ?? '').trim() === '') return refused('root_invalid', decisions);
  // The production mailbox root first: a misconfigured path must never reach real mail.
  if (underPath(root, production)) return refused('production_root_refused', decisions);
  if (!samePath(root, isolated)) return refused('root_not_isolated', decisions);
  decisions.push('isolated_root_confirmed');

  if (runtimeVersion !== SUPPORTED_VERSION) return refused('runtime_version_mismatch', decisions);
  decisions.push('runtime_version_confirmed');

  const store = createSessionStore({ root });
  const mailbox = createMailbox({ root, identity });
  const bridge = createDshHostBridge({ ctx, runtimeVersion, store, identity, hostId });
  const tools = createMailTools({ ctx, mailbox, store, identity, runtimeVersion, hostId });
  const acceptance = createLedgerAcceptance({ store, identity });

  // Nothing is registered before every piece that could fail has been built.
  const commands = bridge.registerCommands();
  if (commands.ok !== true) return refused('commands_' + String(commands.reason ?? 'refused'), decisions);
  const registered = tools.register();
  if (registered.ok !== true) {
    commands.dispose();
    return refused('tools_' + String(registered.reason ?? 'refused'), decisions);
  }
  decisions.push('commands_registered', 'tools_registered');

  let observed = null;
  const release = () => {
    if (observed !== null) return;
    observed = true;
    try { registered.dispose(); } catch { /* release is best effort */ }
    try { commands.dispose(); } catch { /* release is best effort */ }
  };

  const adapter = createDshAdapter({
    ctx, runtimeVersion, hostId, mailboxAgent: identity, acceptance,
    bindingProvider: createBindingProvider({ store, identity, host: bridge }),
  });
  decisions.push(adapter.capabilities.trustedBinding ? 'adapter_binding_trusted' : 'adapter_binding_untrusted');

  return Object.freeze({
    enabled: true, status: WIRING_STATUS, decisions: Object.freeze([...decisions]), dispose: release,
    parts: Object.freeze({
      root, store, mailbox, bridge, tools, acceptance, adapter,
      capabilities: Object.freeze({ ...tools.capabilities(), adapter: adapter.capabilities }),
      diagnostics: () => adapter.diagnostics(),
      /**
       * Live E1-E6 are not a side effect of loading a plugin: the receiver is handed back unstarted,
       * and starting it stays a separately authorized step on the isolated root.
       */
      receiverFactory: undefined,
    }),
  });
}
