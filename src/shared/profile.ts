import type { GitHubProfile, ProfileMetrics, ProfileStatus } from './metrics.ts';

/** Statuses the owner can pick on the website. Picking none uses their GitHub status. */
export const STATUS_CHOICES = {
  'open-to-work': 'Open to work',
  hiring: 'Hiring',
  freelance: 'Open to freelance',
  none: "Don't show a status",
} as const;

export type StatusChoice = keyof typeof STATUS_CHOICES;

const isStatusChoice = (value: unknown): value is StatusChoice => typeof value === 'string' && Object.hasOwn(STATUS_CHOICES, value);

/** What the owner wrote on the website. An empty field falls back to their GitHub profile. */
export interface ManualProfile {
  name: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  bio: string | null;
  status: StatusChoice | null;
}

/** In characters. GitHub allows 160 for a bio. */
export const PROFILE_LIMITS = { name: 60, title: 60, company: 60, location: 60, bio: 160 } as const;

const TEXT_FIELDS = Object.keys(PROFILE_LIMITS) as (keyof typeof PROFILE_LIMITS)[];

/**
 * One line of plain text, at most `max` characters, or null when nothing is left. Line breaks
 * and control characters become spaces, and invisible formatting characters, which can
 * reorder how text displays, are removed. Joiners stay, so combined emoji keep their shape.
 */
export function cleanLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const line = value
    .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
    .replace(/(?!\u200D)\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = Array.from(line).slice(0, max).join('').trim();
  return clipped || null;
}

function manualFrom(read: (field: string) => unknown): ManualProfile {
  const profile = { status: null } as ManualProfile;
  for (const field of TEXT_FIELDS) profile[field] = cleanLine(read(field), PROFILE_LIMITS[field]);
  const status = read('status');
  profile.status = isStatusChoice(status) ? status : null;
  return profile;
}

/** From the website's form. Anything unexpected is dropped rather than refused. */
export const manualProfileFromForm = (form: URLSearchParams): ManualProfile => manualFrom((field) => form.get(field));

/** From the database, where it's stored as JSON. */
export function manualProfileFromJson(json: string | null | undefined): ManualProfile {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = json ? JSON.parse(json) : {};
    if (parsed && typeof parsed === 'object') stored = parsed as Record<string, unknown>;
  } catch {
    // Treated as empty, so the header falls back to GitHub.
  }
  return manualFrom((field) => (Object.hasOwn(stored, field) ? stored[field] : null));
}

/** Null when every field is empty, so nothing is stored. */
export function manualProfileJson(profile: ManualProfile): string | null {
  const filled = Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== null));
  return Object.keys(filled).length ? JSON.stringify(filled) : null;
}

/** A GitHub profile from an upload, cleaned the same way as what's typed on the website. */
export function cleanGitHubProfile(value: unknown): GitHubProfile | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const rawStatus = raw.status && typeof raw.status === 'object' ? (raw.status as Record<string, unknown>) : null;
  const status = rawStatus && { emoji: cleanLine(rawStatus.emoji, 8), message: cleanLine(rawStatus.message, 160), busy: rawStatus.busy === true };
  return {
    name: cleanLine(raw.name, 160),
    bio: cleanLine(raw.bio, 160),
    company: cleanLine(raw.company, 160),
    location: cleanLine(raw.location, 160),
    hireable: raw.hireable === true,
    status: status && (status.emoji || status.message || status.busy) ? status : null,
  };
}

function statusOf(choice: StatusChoice | null, github: GitHubProfile | undefined): ProfileStatus | null {
  if (choice === 'none') return null;
  if (choice) return { label: STATUS_CHOICES[choice], emoji: null, tone: choice === 'open-to-work' ? 'open' : choice };
  const status = github?.status;
  if (status) return { label: status.message ?? (status.busy ? 'Busy' : ''), emoji: status.emoji, tone: status.busy ? 'busy' : 'neutral' };
  if (github?.hireable) return { label: 'Available for hire', emoji: null, tone: 'open' };
  return null;
}

/** Each field is what the owner wrote, else what GitHub has. A job title only comes from the website. */
export function profileOf(user: { login: string; name: string | null }, manual: ManualProfile, github: GitHubProfile | undefined): ProfileMetrics {
  return {
    login: user.login,
    name: manual.name ?? github?.name ?? cleanLine(user.name, PROFILE_LIMITS.name),
    title: manual.title,
    company: manual.company ?? github?.company ?? null,
    location: manual.location ?? github?.location ?? null,
    bio: manual.bio ?? github?.bio ?? null,
    status: statusOf(manual.status, github),
    avatar: null,
  };
}
