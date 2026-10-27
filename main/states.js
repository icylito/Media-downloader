// The one table of every download state. `kind` groups them for presentation
// (pending / active / ok / error); ALLOWED guards transitions so a racing
// cancel or a straggler log line can never land an item in an impossible state.
const STATE = {
  QUEUED: 'queued',
  RESOLVING: 'resolving',
  DOWNLOADING: 'downloading',
  MUXING: 'muxing',
  EXTRACTING: 'extracting',
  EMBEDDING: 'embedding',
  DONE: 'done',
  SKIPPED: 'skipped',
  CANCELING: 'canceling',
  CANCELED: 'canceled',
  FAILED: 'failed',
};

const STATES = {
  [STATE.QUEUED]: { label: 'Queued', kind: 'pending' },
  [STATE.RESOLVING]: { label: 'Fetching info…', kind: 'active' },
  [STATE.DOWNLOADING]: { label: 'Downloading', kind: 'active' },
  [STATE.MUXING]: { label: 'Merging video and audio', kind: 'active' },
  [STATE.EXTRACTING]: { label: 'Processing audio…', kind: 'active' },
  [STATE.EMBEDDING]: { label: 'Adding thumbnail…', kind: 'active' },
  [STATE.DONE]: { label: 'Done', kind: 'ok' },
  [STATE.SKIPPED]: { label: 'Already downloaded', kind: 'ok' },
  [STATE.CANCELING]: { label: 'Canceling…', kind: 'active' },
  [STATE.CANCELED]: { label: 'Canceled', kind: 'error' },
  [STATE.FAILED]: { label: 'Failed', kind: 'error' },
};

const ALLOWED = {
  [STATE.QUEUED]: [STATE.RESOLVING, STATE.DOWNLOADING, STATE.CANCELED],
  [STATE.RESOLVING]: [STATE.DOWNLOADING, STATE.SKIPPED, STATE.CANCELING, STATE.CANCELED, STATE.FAILED],
  [STATE.DOWNLOADING]: [STATE.MUXING, STATE.EXTRACTING, STATE.EMBEDDING, STATE.DONE, STATE.CANCELING, STATE.FAILED],
  [STATE.MUXING]: [STATE.DOWNLOADING, STATE.EXTRACTING, STATE.EMBEDDING, STATE.DONE, STATE.CANCELING, STATE.FAILED],
  [STATE.EXTRACTING]: [STATE.DOWNLOADING, STATE.EMBEDDING, STATE.DONE, STATE.CANCELING, STATE.FAILED],
  [STATE.EMBEDDING]: [STATE.DOWNLOADING, STATE.DONE, STATE.CANCELING, STATE.FAILED],
  [STATE.CANCELING]: [STATE.CANCELED],
  [STATE.DONE]: [],
  [STATE.SKIPPED]: [],
  [STATE.CANCELED]: [],
  [STATE.FAILED]: [],
};

const isTerminal = (key) => ALLOWED[key].length === 0;

const isActive = (key) => STATES[key]?.kind === 'active';

// a state that already left is final; done beats a late cancel
function canGo(from, to) {
  if (from === to) return true;
  return (ALLOWED[from] || []).includes(to);
}

module.exports = { STATE, STATES, canGo, isTerminal, isActive };
