/**
 * Checks that development builds and tests run and production skips for their cost: today, deep-freezing a compiled sketch graph so
 * that a consumer writing into it fails where it writes. Production still freezes the compiled graph's containers.
 *
 * Domain code never reads the build mode: the app entry and the kernel worker set this from theirs, and test setup turns it on.
 */
let enabled = false;

export function setCadDevelopmentChecks(on: boolean): void {
  enabled = on;
}

export function cadDevelopmentChecks(): boolean {
  return enabled;
}
