/**
 * Checks that development builds and tests run and production skips for their cost. Each use must give the same result with the switch
 * on or off for every valid input, and a test must run both ways and compare. Today the switch covers three checks:
 * - deep-freezing a compiled sketch graph, so that a consumer writing into it fails where it writes. Production still freezes the
 *   compiled graph's containers.
 * - checking each member a sketch generator made when its graph is accepted. Production trusts the exact lists generation made in that
 *   evaluation and checks everything else (`acceptCadSketchGraphWithMembers`).
 * - checking that a list of issues is one causal graph, so a producer that links a cause wrongly fails where it builds the list. Production
 *   keeps the list as it is, and the digest names what does not resolve (`createCadIssueList`).
 *
 * Domain code never reads the build mode: the app entry and the kernel worker set this from theirs, and test setup turns it on.
 */
let enabled = false;

/** Turns the development checks on or off. Only the app entry, the kernel worker and tests call this. */
export function setCadDevelopmentChecks(on: boolean): void {
  enabled = on;
}

/** Whether the development checks run. */
export function cadDevelopmentChecks(): boolean {
  return enabled;
}
