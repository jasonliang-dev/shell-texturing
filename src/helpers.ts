export function clamp(n: number, lo: number, hi: number) {
  if (n < lo) {
    return lo;
  } else if (n > hi) {
    return hi;
  } else {
    return n;
  }
}

export function lerp(a: number, b: number, t: number) {
  return a + t * (b - a);
}
