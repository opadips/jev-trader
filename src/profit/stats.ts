/** Small numeric helpers for the analyzer. No dependencies, deterministic. */

export const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

export function std(xs: number[]) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Linear-interpolated quantile, q in [0, 1]. */
export function quantile(xs: number[], q: number) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export function weightedMean(xs: number[], ws: number[]) {
  let s = 0, w = 0;
  for (let i = 0; i < xs.length; i++) { s += xs[i]! * ws[i]!; w += ws[i]!; }
  return w ? s / w : NaN;
}

/** Pearson correlation over pairs where both values are finite. */
export function corr(a: number[], b: number[]) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  if (n < 3) return NaN;
  const cov = sab / n - (sa / n) * (sb / n), va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN;
}

/** OLS slope of y on x (through the means), over finite pairs. */
export function beta(x: number[], y: number[]) {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < x.length; i++) {
    const a = x[i]!, b = y[i]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    n++; sx += a; sy += b; sxx += a * a; sxy += a * b;
  }
  if (n < 3) return NaN;
  const v = sxx / n - (sx / n) ** 2;
  return v > 0 ? (sxy / n - (sx / n) * (sy / n)) / v : NaN;
}

/** Index of the first element with key >= target in an array sorted by key, or arr.length. */
export function lowerBound<T>(arr: T[], target: number, key: (t: T) => number) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (key(arr[m]!) < target) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * L2-regularised logistic regression by batch gradient descent on standardised features.
 * Small and slow on purpose: it is a baseline, not the model.
 */
export function fitLogistic(X: number[][], y: number[], opts: { l2?: number; iters?: number; lr?: number } = {}) {
  const { l2 = 1e-3, iters = 300, lr = 0.5 } = opts;
  const d = X[0]?.length ?? 0, n = X.length;
  const mu = Array(d).fill(0), sd = Array(d).fill(0);
  for (const r of X) for (let j = 0; j < d; j++) mu[j] += r[j]! / n;
  for (const r of X) for (let j = 0; j < d; j++) sd[j] += (r[j]! - mu[j]) ** 2 / n;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]));
  const w = Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const z = Z[i]!;
      let s = b;
      for (let j = 0; j < d; j++) s += w[j] * z[j]!;
      const e = sigmoid(s) - y[i]!;
      gb += e;
      for (let j = 0; j < d; j++) gw[j] += e * z[j]!;
    }
    b -= (lr * gb) / n;
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
  }
  return {
    weights: w, bias: b,
    predict(x: number[]) {
      let s = b;
      for (let j = 0; j < d; j++) s += w[j] * ((x[j]! - mu[j]) / sd[j]);
      return sigmoid(s);
    },
  };
}

export const sigmoid = (s: number) => 1 / (1 + Math.exp(-s));
