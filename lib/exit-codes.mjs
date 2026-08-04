// A check that ran to completion but asserted nothing, because a host config artifact it reads is
// absent. Distinct from 0 so it cannot be tallied as a pass, and from 2 so a genuinely broken setup
// stays distinguishable from a repo that simply has not wired this part of the corpus.
//
// It exists because the alternative was measured: with these branches exiting 0, a wholly wrong
// HP_FIXTURES_CONFIG produced an all-PASS run.
export const VACUOUS = 3;
