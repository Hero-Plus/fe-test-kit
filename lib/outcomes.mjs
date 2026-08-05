// The four outcomes every check finishes through, and the one copy of the rule that picks between
// them: a run that asserted nothing is `vacuous`, whatever branch it took to get there.
//
// Spelling that rule per branch is how a check comes to print a green PASS over nothing. v0.1.3's
// `verbatim` judged its own emptiness from byte-identity and missed the case where HEAD held no body
// at all — every live body landed in `added`, the comparison loop never ran, and it exited 0. A
// branch cannot be trusted to recognise its own vacuity; a count can.
export const ASSERTED = 0;
export const FAILED = 1;
export const SETUP_ERROR = 2;
export const VACUOUS = 3;

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

/** Unusable config or unreadable corpus — the check never reached the point of asserting. */
export function setupError(check, message) {
  console.error(`\n${check}: ${message}`);
  process.exit(SETUP_ERROR);
}

export function finish({
  check,
  assertedCount,
  assertedUnit,
  failures = [],
  remediation,
  vacuousReason,
  pass,
}) {
  console.log(`\n${check}: asserted ${assertedCount} ${assertedUnit}`);

  // Adjudicated before the count, because a reported failure IS an assertion that did not hold:
  // taking the vacuous branch first would file a real finding under "asserted nothing" and hide it
  // behind a policy the host may have set to `warn`.
  if (failures.length > 0) {
    console.error(`\n${RED}FAIL${RESET} — ${failures.length} problem(s):`);
    for (const failure of failures) console.error(`  ${failure}`);
    if (remediation) console.error(`\n${remediation}`);
    process.exit(FAILED);
  }

  if (assertedCount === 0) {
    console.error(`\n${YELLOW}VACUOUS${RESET} — this run asserted nothing.`);
    if (vacuousReason) console.error(`  ${vacuousReason}`);
    process.exit(VACUOUS);
  }

  console.log(`\nPASS — ${pass}`);
  process.exit(ASSERTED);
}
