// Test-only page: runs ephemerisDigest() in a worker and publishes the result
// as JSON in body[data-digest] (or body[data-error]).
const out = document.getElementById('out')!;
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const fail = (msg: string) => {
  if (document.body.dataset.digest || document.body.dataset.error) return;
  out.textContent = `ERROR: ${msg}`;
  document.body.dataset.error = msg;
  document.title = 'ERROR: ephemeris digest';
};
worker.onerror = (e) => fail(e.message || 'worker failed to load');
worker.onmessageerror = () => fail('worker message could not be read');
addEventListener('error', (e) => fail(`page error: ${e.message}`));
addEventListener('unhandledrejection', (e) => fail(`unhandled rejection: ${String(e.reason)}`));
worker.onmessage = (ev: MessageEvent) => {
  if (ev.data && 'error' in ev.data) return fail(ev.data.error);
  const json = JSON.stringify(ev.data);
  out.textContent = JSON.stringify(ev.data, null, 2);
  document.body.dataset.digest = json;
  document.title = 'DONE: ephemeris digest';
};
worker.postMessage(null);
