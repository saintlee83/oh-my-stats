export type Scope = 'personal' | 'org' | 'external';

export interface Coverage {
  reposListed: number;
  reposWalked: number;
  reposFailed: number;
  reposWithCommits: number;
  churnDone: number;
  churnPending: number;
  churnFailed: number;
  gists: number;
}

/** [input, output, cacheRead, cacheWrite, messages] */
export type UsageTuple = [number, number, number, number, number];

/** [input, output, cacheRead, cacheWrite] */
export type TokenBreakdown = [number, number, number, number];

/** A lifetime figure reported by a tool itself, which outlives deleted logs. */
export interface ToolTotals {
  /** 'machine' covers one computer. 'account' covers every device on the account. */
  scope: 'machine' | 'account';
  total: number;
  /** The last date the figure covers. Newer usage is added from logs. */
  asOf: string | null;
  /** Lifetime usage per model, when the tool reports it. */
  models?: Record<string, TokenBreakdown>;
  /** Tokens per day, when the tool reports them. */
  daily?: Record<string, number>;
}

export type TokenTotals = Record<string, ToolTotals>;

/** Everything one machine reports: date -> "tool/model" -> usage, plus its tool figures. */
export interface MachineUsage {
  id: string;
  days: Record<string, Record<string, UsageTuple>>;
  totals?: TokenTotals;
}

export interface Price {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export type PriceTable = Record<string, Price>;
