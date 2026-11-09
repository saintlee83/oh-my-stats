import type { Coverage, Scope } from './types.ts';

/** The JSON contract for GitHub metrics, produced by the Rust agent and rendered here. */
export interface BucketRow {
  key: 'morning' | 'daytime' | 'evening' | 'night';
  label: string;
  emoji: string;
  range: string;
  count: number;
  share: number;
}

/** Lines you added, per source. `bytes` is the repo footprint credited to you, for reference. */
export interface LanguageRow {
  name: string;
  lines: number;
  bytes: number;
  share: number;
  personal: number;
  org: number;
  external: number;
  gist: number;
}

export interface ChurnRow {
  name: string;
  add: number;
  del: number;
  net: number;
}

export interface CoauthorMetricRow {
  label: string;
  kind: 'ai' | 'bot' | 'person' | 'private';
  commits: number;
  share: number;
}

export interface ModelUsage {
  tool: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  total: number;
  cost: number | null;
}

export interface TokenToolRow {
  tool: string;
  total: number;
  fresh: number;
  cost: number;
  /** Tokens the tool reports but no model can be named for, because no local log covers them. */
  unattributed: number;
  scope: 'machine' | 'account' | 'logs';
  asOf: string | null;
  /** How many machines report this tool. */
  machines: number;
}

export interface TokenMetrics {
  total: number;
  /** Input, output and cache writes. Only covers tokens with a known breakdown. */
  fresh: number;
  cacheRead: number;
  input: number;
  output: number;
  cacheWrite: number;
  /** Model responses found in local logs. */
  messages: number;
  /** A minimum: tokens without a known model or price are left out. */
  cost: number;
  unpricedModels: string[];
  unattributed: number;
  models: ModelUsage[];
  tools: TokenToolRow[];
  /** Tokens per machine, for its owner. Never rendered publicly. */
  machines: { id: string; total: number }[];
  /** Trailing 60 days, oldest first. */
  daily: { date: string; total: number; byTool: Record<string, number> }[];
  monthly: { month: string; total: number; byTool: Record<string, number> }[];
  /** Lifetime tokens from before a tool's daily records begin. */
  undated: number;
  last30: { total: number; fresh: number; perCommit: number | null };
  firstDay: string | null;
  activeDays: number;
  peak: { date: string; total: number } | null;
  cacheShare: number;
}

export interface GitHubMetrics {
  login: string;
  memberSince: string;
  counts: {
    commits: number;
    pulls: number;
    merged: number;
    issues: number;
    reviews: number;
    comments: number;
    calendar: number;
    attributed: number;
  };
  /** `calendar` is the year's total on the GitHub graph, including what can't be itemized. */
  thisYear: { year: number; commits: number; pulls: number; issues: number; reviews: number; calendar: number };
  commitsLast30: number;
  months: string[];
  monthly: { commits: number[]; pulls: number[]; issues: number[]; reviews: number[] };
  years: { year: number; commits: number; pulls: number; issues: number; reviews: number; calendar: number; hidden: number }[];
  /** year -> 12 monthly commit-and-PR-and-review counts; drives the long-range grid. */
  yearGrid: { year: number; months: number[] }[];
  scopes: Record<Scope, { commits: number; pulls: number; issues: number; reviews: number }>;
  rhythm: {
    buckets: BucketRow[];
    punch: number[][];
    weekdays: number[];
    peak: { weekday: number; hour: number; count: number } | null;
    persona: string;
    total: number;
  };
  coauthors: {
    rows: CoauthorMetricRow[];
    coauthored: number;
    solo: number;
    soloShare: number;
    privatePeople: number;
    byKind: { ai: number; bot: number; person: number };
  };
  languages: LanguageRow[];
  languageTotals: Record<'personal' | 'org' | 'external' | 'gist', number>;
  churn: {
    rows: ChurnRow[];
    add: number;
    del: number;
    docs: { add: number; del: number };
    skipped: number;
    bulk: { commits: number; lines: number };
    monthly: { month: string; add: number; del: number }[];
  };
  pulse: {
    streak: number;
    bestStreak: number;
    activeDaysYear: number;
    busiest: { date: string; count: number } | null;
    aiCommits: number;
    aiShare: number;
    aiAgents: { name: string; count: number }[];
    aiShareRecent: number;
    mergeRate: number;
    mergeHours: number | null;
    reviewHours: number | null;
    kinds: { name: string; count: number }[];
    avgCommitSize: number | null;
    stars: number;
    followers: number;
    organizations: number;
  };
  coverage: Coverage;
}

export interface Metrics {
  generatedDate: string;
  timezone: string;
  github: GitHubMetrics | null;
  tokens: TokenMetrics | null;
}

