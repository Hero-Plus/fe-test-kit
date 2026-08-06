// The vocabulary the spec tables project into, which is no one repo's status enum — terminal's
// `PurchaseStatusDisplay` and merchant's chip keys each map into it, and re-pointing this at either
// would make a case table that fits one repo and describes the spec for none.
//
// `Requested` is never an `expected` value in the projection — it is what the diverging repos wrongly
// produce on the STATUS-4 cells, so dropping it as unused would stop exactly their helpers compiling.
export type DisplayStatus =
  | "Completed"
  | "Pending"
  | "Processing"
  | "Requested"
  | "PartiallyRefunded"
  | "PreAuthorized"
  | "Declined"
  | "Refunded"
  | "Canceled"
  | "Unknown";

export interface ConformanceCase {
  rule: string;
  name: string;
  // `unknown`, not `Record<string, unknown>`: the only operation any repo performs on this is an
  // assertion to its own wire type, and those are interfaces — no implicit index signature, so the
  // narrower spelling refuses that assertion. The shape is the spec table's, in its own field names.
  input: unknown;
  expected: DisplayStatus;
}

export interface ConformanceTable {
  sourceTable: string;
  vocabulary: DisplayStatus[];
  rows: ConformanceCase[];
  // Rules whose input is what `displayStatus` returned, not a wire body — projecting one anyway lets a
  // repo pass every row for it and still get it wrong, which the ledger would then read as conformance.
  notProjected?: { rule: string; reason: string }[];
}

// Returning `string` would let a typo'd output pass `toBe(expected)` and leave `vocabulary` decorative.
export type DisplayStatusFn = (input: ConformanceCase["input"]) => DisplayStatus;
