// The chi-square distribution, for the P values computed in plain TypeScript
// (the log-rank test) rather than in R. The regularized lower incomplete gamma
// P(a, x) is the chi-square CDF at x with 2a degrees of freedom.

import { logGamma } from "./student-t";

/** Regularized lower incomplete gamma P(a, x), Numerical Recipes' `gammp`. */
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    // Series representation.
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n <= 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  // Continued fraction for Q(a, x); P = 1 - Q.
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let m = 1; m <= 500; m++) {
    const an = -m * (m - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Upper tail P(χ² with `df` degrees of freedom ≥ `chi2`): the log-rank P value. */
export const chiSquareSF = (chi2: number, df: number) => 1 - gammaP(df / 2, chi2 / 2);
