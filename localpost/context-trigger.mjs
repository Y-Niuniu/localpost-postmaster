/**
 * Context-pressure trigger for the bound session. It is on only when the host reports both a stable,
 * strictly increasing per-session turn number and a trusted used/window context figure; otherwise it stays
 * off and the letter capacity alone rotates. One sample counts per independent turn: the first turn over the
 * threshold asks for one compaction; any later turn over it (straight after the compaction, or after falling
 * back below) asks for rotation, as does a failed or unsupported compaction. It only decides; the caller
 * compacts (and reports back) or begins the rotation.
 */
export const CONTEXT_THRESHOLD = 0.6;
export const telemetryEnabled = capabilities => capabilities?.turnIds === true && capabilities?.usage === true;

export function sampleIn(state, sample, { capabilities, threshold = CONTEXT_THRESHOLD } = {}) {
  if (!telemetryEnabled(capabilities)) return { action: 'none', reason: 'telemetry_unavailable' };
  const { binding } = state;
  if (binding.state !== 'active') return { action: 'none', reason: 'binding_frozen' };
  if (sample?.session !== binding.session.id) return { action: 'none', reason: 'stale_session' };
  const { turn, used, window } = sample;
  if (!Number.isSafeInteger(turn) || turn < 1 || typeof used !== 'number' || !Number.isFinite(used) || used < 0 ||
      typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return { action: 'none', reason: 'invalid_sample' };
  if (state.context?.generation !== binding.generation || state.context.session !== binding.session.id)
    state.context = { generation: binding.generation, session: binding.session.id, last_turn: 0, compaction: 'none' };
  const context = state.context;
  if (turn <= context.last_turn) return { action: 'none', reason: 'duplicate_turn' };
  context.last_turn = turn;
  const ratio = used / window;
  if (context.compaction === 'requested') return { action: 'none', reason: 'compaction_pending', ratio };
  if (ratio <= threshold) return { action: 'none', reason: 'below_threshold', ratio };
  if (context.compaction === 'none') {
    context.compaction = capabilities.compaction === true ? 'requested' : 'unsupported';
    return context.compaction === 'requested' ? { action: 'compact', reason: 'first_turn_over_threshold', ratio }
      : { action: 'rotate', reason: 'compaction_unsupported', ratio };
  }
  return { action: 'rotate', reason: context.compaction === 'done' ? 'over_threshold_after_compaction' : `compaction_${context.compaction}`, ratio };
}

export function compactionIn(state, { session, ok } = {}) {
  const { binding, context } = state;
  if (session !== binding.session.id || context?.session !== session || context.compaction !== 'requested')
    return { action: 'none', reason: 'no_compaction_pending' };
  if (ok === true) { context.compaction = 'done'; return { action: 'none', reason: 'compacted' }; }
  context.compaction = 'failed';
  return { action: 'rotate', reason: 'compaction_failed' };
}

export function createContextTrigger({ store, capabilities, threshold = CONTEXT_THRESHOLD } = {}) {
  if (!(threshold > 0 && threshold < 1)) throw new Error('The context threshold is a fraction between 0 and 1');
  const enabled = telemetryEnabled(capabilities);
  return {
    enabled,
    sample: async (identity, sample) => enabled ? store.update(identity, state => sampleIn(state, sample, { capabilities, threshold }))
      : { action: 'none', reason: 'telemetry_unavailable' },
    compaction: (identity, result) => store.update(identity, state => compactionIn(state, result)),
  };
}
