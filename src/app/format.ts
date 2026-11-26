/** Number formatting for readouts. Pure. */

export const AU = 149597870700; // m (IAU 2012, exact)

export function formatDistance(m: number): string {
  const a = Math.abs(m);
  if (!Number.isFinite(m)) return '—';
  if (a < 1e4) return `${m.toFixed(0)} m`;
  if (a < 0.01 * AU) return `${Math.round(m / 1000).toLocaleString('en-US')} km`;
  return `${(m / AU).toFixed(a < 10 * AU ? 4 : 3)} AU`;
}

export function formatSpeed(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return Math.abs(ms) < 1e4 ? `${ms.toFixed(1)} m/s` : `${(ms / 1000).toFixed(3)} km/s`;
}
