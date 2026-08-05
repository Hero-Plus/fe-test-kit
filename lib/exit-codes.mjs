// A check that ran but asserted nothing, because a host config artifact it reads is absent. Distinct
// from 0 so it cannot be tallied as a pass, and from 2 so a broken setup stays distinguishable from a
// repo that has not wired this part of the corpus.
export const VACUOUS = 3;
