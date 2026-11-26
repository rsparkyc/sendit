/// <reference lib="webworker" />
import { ephemerisDigest } from '../ephemeris-digest';

self.onmessage = async () => {
  try {
    self.postMessage(await ephemerisDigest());
  } catch (e) {
    self.postMessage({ error: String(e instanceof Error ? e.stack ?? e : e) });
  }
};
