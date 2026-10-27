export const available = value => Number.isFinite(value) && value >= 0;
export const count = value => available(value) ? value.toLocaleString('en-GB') : 'Not recorded';
export function usable(value) {
  return value && typeof value === 'object' && value.success !== false && value.code !== 'FORBIDDEN' ? value : null;
}
export function recordedHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter(row => typeof row?.hour === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(row.hour) && available(row.calls))
    .slice().sort((a, b) => a.hour.localeCompare(b.hour));
}
export function withinPeriod(rows, period, timestamp, now) {
  if (period === 'all') return rows;
  const cutoff = now - Number(period) * 60 * 60 * 1000;
  return rows.filter(row => {
    const time = Date.parse(timestamp(row));
    return Number.isFinite(time) && time >= cutoff && time <= now;
  });
}
