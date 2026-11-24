import type { CSSProperties } from 'react';
import { commas, compact, money, providerName } from '../shared/format.ts';
import { AVATARS, GITHUB_MARK, HOSTED_ORIGIN, type ProfileRows } from '../server/pages.ts';
import { PROVIDER_ICONS } from '../server/provider-icons.ts';
import type { Standing } from '../server/rankings.ts';

/** Pieces several pages share. React escapes every value, so nothing here escapes by hand. */

/** A GitHub avatar at twice the size it's drawn, for sharp screens. The page may load images from nowhere else. */
export function Avatar({ url, size }: { url: string | null; size: number }) {
  if (!url) return null;
  try {
    const sized = new URL(url);
    if (sized.protocol !== 'https:' || sized.origin !== AVATARS) return null;
    sized.searchParams.set('s', String(size * 2));
    return <img src={sized.toString()} alt="" width={size} height={size} />;
  } catch {
    return null;
  }
}

/** The ID a mark is drawn under: a provider ID that someone made up gets the mark for any other tool. */
export const iconId = (id: string) => (PROVIDER_ICONS.has(id) ? id : 'other');

/**
 * A tool's mark, by reference to the drawing `Layout` puts on the page once. The page must
 * name every tool it marks in `Layout`'s `icons`. The reference is written out as markup, the
 * same as the server's other pages write it.
 */
export function ProviderIcon({ id }: { id: string }) {
  return <svg className="provider-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: `<use href="#provider-${iconId(id)}"/>` }} />;
}

/** A tool's mark, then its name. The mark is decoration: the name says the same to a screen reader. */
export function ProviderLabel({ id }: { id: string }) {
  return (
    <>
      <ProviderIcon id={id} />
      {providerName(id)}
    </>
  );
}

const GITHUB_PATHS = GITHUB_MARK.replace(/^<svg[^>]*>|<\/svg>$/g, '');

export function GitHubMark() {
  return <svg viewBox="0 0 16 16" aria-hidden="true" dangerouslySetInnerHTML={{ __html: GITHUB_PATHS }} />;
}

/**
 * A number in a table: the short figure to scan, and the exact one beneath it when they differ.
 * A phone has room for one column of numbers, so `narrow` is what it shows beneath instead:
 * the figure of a column it leaves out.
 */
export function Figure({ short, exact = short, narrow = '' }: { short: string; exact?: string; narrow?: string }) {
  return (
    <>
      <strong>{short}</strong>
      {narrow ? <small className="narrow">{narrow}</small> : null}
      {short === exact ? null : <small>{exact}</small>}
    </>
  );
}

/** A cost as its short figure and its exact one. Under a cent, the amount itself would read as nothing. */
export const costFigures = (cost: number): [short: string, exact: string] =>
  cost < 0.005 ? ['<$0.01', '<$0.01'] : [money(cost), `$${cost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`];

/** A share of the leader, as the width of a row's bar. */
export const share = (fraction: number): CSSProperties => ({ '--share': `${(100 * fraction).toFixed(1)}%` }) as CSSProperties;

type StandingRow = Standing & { name?: string | null; cost?: number; tool?: string };

/**
 * A ranked list. Totals span orders of magnitude, so each row has the short figure to
 * scan, the exact one beneath it, and a bar comparing it with the leader. Rows with a `tool`
 * are marked, so their page names those tools in `Layout`'s `icons`.
 */
export function Standings({ rows, column, tokenColumn, profiles = null }: { rows: StandingRow[]; column: string; tokenColumn: string; profiles?: ProfileRows | null }) {
  if (!rows.length) return <p>No token usage for this period.</p>;
  const byCost = profiles?.cost !== undefined;
  const score = (row: StandingRow) => (byCost ? row.cost ?? 0 : row.tokens);
  const most = score(rows[0]);
  return (
    <div className="table">
      <table className="standings">
        <thead>
          <tr>
            <th className="rank">Rank</th>
            <th>{column}</th>
            <td className="meter" aria-hidden="true"></td>
            {byCost ? (
              <>
                <th className="num">{profiles?.cost}</th>
                <th className="num wide">{tokenColumn}</th>
              </>
            ) : (
              <th className="num">{tokenColumn}</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const mine = profiles?.viewer?.toLowerCase() === row.label.toLowerCase();
            const login = encodeURIComponent(row.label);
            const handle = `@${row.label}`;
            return (
              <tr key={index} className={mine ? 'me' : undefined}>
                <td className="rank">
                  <span className="place" data-place={profiles && row.rank <= 3 ? row.rank : undefined}>{row.rank}</span>
                </td>
                <td className="who">
                  {profiles ? (
                    <>
                      <a href={`/u/${login}`}>
                        <img src={`${AVATARS}/${login}?s=56`} alt="" width={28} height={28} loading="lazy" />
                        {profiles.names && row.name ? (
                          <span>
                            <b>{row.name}</b>
                            <small>{handle}</small>
                          </span>
                        ) : (
                          handle
                        )}
                      </a>
                      {mine ? <span className="badge">You</span> : null}
                    </>
                  ) : row.tool ? (
                    <ProviderLabel id={row.tool} />
                  ) : (
                    row.label
                  )}
                </td>
                <td className="meter" aria-hidden="true">
                  <span style={share(score(row) / most)}></span>
                </td>
                {byCost ? (
                  <>
                    <td className="num">
                      <Figure {...figureOf(costFigures(row.cost ?? 0))} narrow={`${compact(row.tokens)} ${row.tokens === 1 ? 'token' : 'tokens'}`} />
                    </td>
                    <td className="num wide">
                      <Figure short={compact(row.tokens)} exact={commas(row.tokens)} />
                    </td>
                  </>
                ) : (
                  <td className="num">
                    <Figure short={compact(row.tokens)} exact={commas(row.tokens)} />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const figureOf = ([short, exact]: [string, string]) => ({ short, exact });

/** The same steps on every system but the first, so the reader picks theirs once. */
export function InstallCommands({ origin }: { origin: string }) {
  const login = `oms login${origin === HOSTED_ORIGIN ? '' : ` --server ${origin}`}`;
  const pane = (install: string) => (
    <pre>
      <code>{`${install}\n${login}\noms service install`}</code>
    </pre>
  );
  return (
    <div className="terminal" role="group" aria-label="Install commands">
      <input type="radio" name="os" id="os-unix" defaultChecked />
      <label htmlFor="os-unix">macOS and Linux</label>
      <input type="radio" name="os" id="os-windows" />
      <label htmlFor="os-windows">Windows</label>
      {pane(`curl -fsSL ${origin}/install.sh | sh`)}
      {pane(`irm ${origin}/install.ps1 | iex`)}
    </div>
  );
}

export function GitHubSetup() {
  return (
    <details className="github-setup">
      <summary>Add GitHub contribution stats (optional)</summary>
      <p>
        <code>oms login</code> is enough to sync AI usage. To include commits and other repository activity, set up the <a href="https://cli.github.com/">GitHub CLI</a> on one machine.
      </p>
      <ol>
        <li>
          Run <code>gh auth status</code> to check the active GitHub account. If you need to sign in, run <code>gh auth login</code> with the account you use for OMS.
        </li>
        <li>
          Run <code>oms sync --github</code> to update your contribution stats now. <code>oms</code> uses the repository token on this machine to read from GitHub.
        </li>
        <li>
          If the sync reports that your GitHub CLI login is missing <code>repo</code> or <code>read:org</code>, run <code>gh auth refresh -s repo,read:org</code>, approve the request, and retry the sync. The <code>repo</code> scope includes read and write access to repositories you can access. OMS uses it to read activity. The <code>read:org</code> scope allows reading organization and team membership.
        </li>
      </ol>
    </details>
  );
}
