type Labels = Readonly<Record<string, string>>;
interface Sample { name: string; labels: Labels; value: number }

const safeLabels = new Set(['status', 'kind', 'outcome', 'operation']);
function labelKey(labels: Labels): string { return Object.keys(labels).sort().map((key) => `${key}=${labels[key]}`).join('|'); }
function escapeLabel(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"'); }
function renderLabels(labels: Labels): string {
  const parts = Object.entries(labels).filter(([key, value]) => (safeLabels.has(key) || key === 'le') && value.length <= 64)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}="${escapeLabel(value)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

/** Small per-process Prometheus registry. Labels intentionally exclude business identifiers. */
export class MetricRegistry {
  private readonly counters = new Map<string, Map<string, Sample>>();
  private readonly gauges = new Map<string, Map<string, Sample>>();
  private readonly histograms = new Map<string, { bounds: number[]; counts: Map<string, number[]>; sums: Map<string, number>; totals: Map<string, number>; labels: Map<string, Labels> }>();

  increment(name: string, labels: Labels = {}, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) return;
    this.add(this.counters, name, labels, amount);
  }

  setGauge(name: string, value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) return;
    this.add(this.gauges, name, labels, value, true);
  }

  observe(name: string, value: number, labels: Labels = {}, bounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]): void {
    if (!Number.isFinite(value) || value < 0) return;
    let histogram = this.histograms.get(name);
    if (!histogram) { histogram = { bounds: [...bounds].sort((a, b) => a - b), counts: new Map(), sums: new Map(), totals: new Map(), labels: new Map() }; this.histograms.set(name, histogram); }
    const key = labelKey(labels);
    const counts = histogram.counts.get(key) ?? histogram.bounds.map(() => 0);
    for (let index = 0; index < histogram.bounds.length; index += 1) if (value <= histogram.bounds[index]!) counts[index] = counts[index]! + 1;
    histogram.counts.set(key, counts);
    histogram.sums.set(key, (histogram.sums.get(key) ?? 0) + value);
    histogram.totals.set(key, (histogram.totals.get(key) ?? 0) + 1);
    histogram.labels.set(key, labels);
  }

  async render(): Promise<string> {
    const lines: string[] = [];
    for (const [name, samples] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const sample of samples.values()) lines.push(`${name}${renderLabels(sample.labels)} ${sample.value}`);
    }
    for (const [name, samples] of this.gauges) {
      lines.push(`# TYPE ${name} gauge`);
      for (const sample of samples.values()) lines.push(`${name}${renderLabels(sample.labels)} ${sample.value}`);
    }
    for (const [name, histogram] of this.histograms) {
      lines.push(`# TYPE ${name} histogram`);
      for (const [key, counts] of histogram.counts) {
        const labels = histogram.labels.get(key) ?? {};
        histogram.bounds.forEach((bound, index) => lines.push(`${name}_bucket${renderLabels({ ...labels, le: String(bound) })} ${counts[index]}`));
        lines.push(`${name}_bucket${renderLabels({ ...labels, le: '+Inf' })} ${histogram.totals.get(key) ?? 0}`);
        lines.push(`${name}_sum${renderLabels(labels)} ${histogram.sums.get(key) ?? 0}`);
        lines.push(`${name}_count${renderLabels(labels)} ${histogram.totals.get(key) ?? 0}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private add(target: Map<string, Map<string, Sample>>, name: string, labels: Labels, amount: number, replace = false): void {
    const permitted = Object.fromEntries(Object.entries(labels).filter(([key, value]) => safeLabels.has(key) && value.length <= 64));
    let samples = target.get(name);
    if (!samples) { samples = new Map(); target.set(name, samples); }
    const key = labelKey(permitted);
    const old = samples.get(key);
    samples.set(key, { name, labels: permitted, value: replace ? amount : (old?.value ?? 0) + amount });
  }
}

export const metrics = new MetricRegistry();
