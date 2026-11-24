import type { ReactNode } from 'react';
import { landingBoard } from '../../server/app.ts';
import type { UserRow } from '../../server/db.ts';
import { profileCount, REPO_URL, SITE, type LandingBoard } from '../../server/pages.ts';
import { commas, compact, PROVIDERS } from '../../shared/format.ts';
import { GitHubMark, GitHubSetup, InstallCommands, ProviderLabel, Standings } from '../common.tsx';
import { Layout } from '../layout.tsx';
import { PageLink } from '../link.tsx';
import type { PageModule } from '../page.ts';

/** The home page: what the service does, how, what leaves a machine, and the top of the rankings. */

/**
 * The logo's motif behind the heading: contribution squares that rise like bar charts toward
 * both edges, leaving the middle clear for the words. Each bar is one shape filled with a
 * pattern of squares, so the whole drawing stays small.
 */
const HERO = (() => {
  const columns = 64;
  const rows = 7;
  const pitch = 26;
  const cell = 20;
  const width = columns * pitch - (pitch - cell);
  const height = rows * pitch - (pitch - cell);
  const wobble = [0.3, -0.6, 0.1, 0.7, -0.3, 0.5, -0.7, 0.2];
  const bars: string[] = ['', '', '', '', ''];
  let newest = { size: 0, column: 0 };
  for (let column = 0; column < columns; column++) {
    const fromCenter = Math.abs(column - (columns - 1) / 2) / ((columns - 1) / 2);
    if (fromCenter < 0.4) continue;
    const x = column * pitch;
    const size = Math.max(0, Math.min(rows, Math.round(((fromCenter - 0.4) / 0.6) ** 0.9 * 6.2 + wobble[(column * 5) % wobble.length])));
    if (size === 0) continue;
    // The newest square is on the right, as it is in the logo, where the drawing is at full strength.
    if (column > columns * 0.8 && column < columns * 0.88 && size >= newest.size) newest = { size, column };
    const top = (rows - size) * pitch;
    bars[Math.ceil((size / rows) * 4)] += `M${x} ${top}h${cell}v${height - top}h-${cell}z`;
  }
  return { rows, pitch, cell, width, height, bars, newest };
})();

const LEVELS = [1, 2, 3, 4];

function HeroArt() {
  const { rows, pitch, cell, width, height, bars, newest } = HERO;
  return (
    <svg className="hero-art" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        {LEVELS.map((level) => (
          <pattern key={level} id={`oms-g${level}`} width={pitch} height={pitch} patternUnits="userSpaceOnUse">
            <rect width={cell} height={cell} rx={5} fill={`var(--g${level})`} />
          </pattern>
        ))}
      </defs>
      {LEVELS.map((level) => <path key={level} d={bars[level]} fill={`url(#oms-g${level})`} />)}
      <rect x={newest.column * pitch} y={(rows - newest.size) * pitch} width={cell} height={cell} rx={5} fill="var(--spark)" />
    </svg>
  );
}

/** Each feature's icon is a drawing written here, in a 24-unit box. */
const FEATURES: [icon: string, title: string, text: ReactNode][] = [
  ['<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', 'Always recording',
    <><code>oms</code> records usage in the background as you work, and keeps its own record, so your history survives when AI tools delete their logs.</>],
  ['<rect x="2.5" y="5" width="13" height="9.5" rx="1.5"/><path d="M1 18h12"/><rect x="16.5" y="8.5" width="5" height="10.5" rx="1.2"/>', 'Every machine, counted once',
    'Sign in on each computer. Per-machine logs are added together, and an account-wide total is counted a single time.'],
  ['<circle cx="12" cy="12" r="3.5"/><path d="M2.5 12h6M15.5 12h6"/>', 'Private work included',
    'GitHub’s contribution API hides private work, so commits are counted by walking each repository, on your own machine.'],
  ['<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>', 'Private by default',
    'Your profile stays hidden until you publish it. Machine names are never public.'],
  ['<path d="M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5"/>', 'Made for your README',
    'Embed the whole dashboard, or only the parts you want, as images that follow light and dark mode.'],
  ['<path d="M5 20v-8M12 20V4M19 20v-5"/>', 'Rankings',
    'See where you stand among published profiles, and compare your own devices and providers.'],
];

const UPLOADED = [
  'Tokens per day and model', 'Lifetime totals per tool and model', 'Aggregated GitHub numbers, such as commits per month and lines per language',
  'Your public GitHub profile: name, bio, company, location and status', 'Each machine’s name and platform, shown only to you', 'Your timezone',
];
const KEPT = ['Prompts, responses and code', 'Commit messages and file paths', 'Private repository and organization names', 'The token that reads your repositories'];

const STEPS: [title: string, text: ReactNode][] = [
  ['Read on your machine',
    <>Run <code>oms</code> on each computer. It reads the usage records your AI tools already keep there. One computer with GitHub access also walks your repositories, and that access never leaves it.</>],
  ['Only totals are uploaded',
    'Tokens per day and model, and aggregated GitHub numbers. Prompts, code, commit messages and private repository names stay where they are.'],
  ['You see it where you choose',
    'First on a dashboard only you can open. Publish it for a profile page, a place in the rankings, and images to embed in your README.'],
];

const QUESTIONS: [question: ReactNode, answer: ReactNode][] = [
  ['Is anything public by default?',
    'No. Your profile stays hidden until you publish it, and a private profile looks the same as one that doesn’t exist. Publishing shows your totals per model and per day, and lists you in the public rankings. Machine names are never public.'],
  [<>What does <code>oms</code> read, and what does it send?</>,
    <>It reads the usage records your AI tools keep on that machine, and your GitHub repositories with a token that stays there. It sends totals: tokens per day and model, each tool’s lifetime total, aggregated GitHub numbers, your public GitHub profile, your timezone, and the machine’s name and platform, which only you see. Run <code>oms preview</code> to see exactly what would be uploaded, without sending anything.</>],
  ['What can this server do with my GitHub sign-in?',
    'Only tell who you are. The token it receives comes from a GitHub App with no permissions, so it can’t read your repositories. The server uses it once and doesn’t store it.'],
  ['How is cost estimated?',
    <>At public API list prices. It is what the usage would cost through the API, not what you paid. Tokens without a known model or price are left out, so the figure is then shown as a minimum. <a href="/how-we-count#cost">How we count</a> has the rest.</>],
  ['What if I use several machines?',
    'Sign in on each one. Per-machine figures and logs are added together, and an account-wide total, such as Codex’s, is counted once. A machine’s id comes from its hardware, so reinstalling doesn’t register it twice.'],
  ['How often do the numbers update?',
    <><code>oms</code> reads new log lines every 5 minutes and uploads once a day, so your numbers can be up to a day behind. Run <code>oms sync</code> to update right away. Public pages are cached for 5 minutes.</>],
  ['How do I delete everything?',
    <>On your dashboard. Removing a machine deletes its data and signs it out. Deleting your account removes everything on the server, after you confirm with your username. Each machine keeps its local history, so signing in again brings your usage back. <a href="/privacy#deleting">Privacy</a> has the details.</>],
  ['Can I run my own server?',
    <>Yes. The server is a single Cloudflare Worker with a D1 database. <a href={`${REPO_URL}#run-your-own-server`}>The README</a> has the steps, and how to sign your machines in to it.</>],
];

/** With fewer ranked profiles, their count and total describe those few people rather than the site. */
const FIGURES_FROM = 3;

/** A quiet line of numbers under the heading. How many tools `oms` reads is true of any server, so it always shows. */
function Figures({ board }: { board: LandingBoard }) {
  const ranked = board.participants >= FIGURES_FROM
    ? [[commas(board.participants), 'ranked public profiles'], [compact(board.tokens), 'AI tokens between them, all time']]
    : [];
  const items = [...ranked, [String(PROVIDERS.size), 'AI tools read automatically']];
  return (
    <ul className="tally wrap">
      {items.map(([value, label]) => <li key={label}><strong>{value}</strong>{' '}<span>{label}</span></li>)}
    </ul>
  );
}

function SectionHead({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

interface LandingProps {
  origin: string;
  viewer: UserRow | null;
  board: LandingBoard;
}

function LandingView({ origin, viewer, board }: LandingProps) {
  const start = viewer
    ? <a className="button primary lg" href="/me">Go to your dashboard</a>
    : <a className="button primary lg" href="/login"><GitHubMark />Sign in with GitHub</a>;
  const [leader] = board.leaders;
  const login = leader ? encodeURIComponent(leader.label) : '';
  return (
    <Layout title={`${SITE} · Your real developer stats, from every machine`} viewer={viewer} bleed origin={origin} icons={PROVIDERS.keys()}>
      <section className="hero">
        <HeroArt />
        <div className="wrap">
          <p className="eyebrow">Open source · macOS, Linux and Windows</p>
          <h1>{'Your real developer stats,'}<br />{' from every machine.'}</h1>
          <p className="lead">Sign in with GitHub, run <code>oms</code> on each computer, and see your AI tokens and contributions in one place, with private work included.</p>
          <div className="actions">
            {start}
            <PageLink className="button lg" href="/rankings">See the rankings</PageLink>
          </div>
          <InstallCommands origin={origin} />
          <p className="muted"><code>oms</code> records usage continuously and uploads once a day. Run <code>oms sync</code> to update right away.</p>
          <GitHubSetup />
        </div>
      </section>
      <Figures board={board} />
      {leader ? (
        <section className="section wrap">
          <SectionHead title="A dashboard built from real work">
            Live from the rankings: <a href={`/u/${login}`}>{`@${leader.label}`}</a>, first by lifetime AI tokens.
          </SectionHead>
          <a className="showcase" href={`/u/${login}`}>
            <img src={`/u/${login}/dashboard.svg`} alt={`The developer dashboard of @${leader.label}`} loading="lazy" />
          </a>
        </section>
      ) : null}
      <section className="section wrap">
        <SectionHead title="How it works">The counting happens on your machines. The server adds up what they send.</SectionHead>
        <ol className="steps">
          {STEPS.map(([title, text]) => <li key={title}><h3>{title}</h3><p>{text}</p></li>)}
        </ol>
      </section>
      <section className="section wrap">
        <SectionHead title="Numbers you can stand behind">Collected on your machines, combined on the server, and shown only where you choose.</SectionHead>
        <div className="grid">
          {FEATURES.map(([icon, title, text]) => (
            <div key={title} className="feature">
              <div className="icon"><svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon }} /></div>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="section wrap">
        <SectionHead title="Reads the tools you already use"><code>oms</code> finds these histories on its own. Any other tool can be added with a JSONL export.</SectionHead>
        <ul className="chips">
          {[...PROVIDERS.keys()].map((id) => <li key={id}><ProviderLabel id={id} /></li>)}
        </ul>
      </section>
      <section className="section wrap">
        <SectionHead title="What leaves your machine">Only totals. Run <code>oms preview</code> to see exactly what would be uploaded, without sending anything.</SectionHead>
        <div className="grid">
          <div className="panel ledger"><h3>Uploaded</h3><ul>{UPLOADED.map((item) => <li key={item}>{item}</li>)}</ul></div>
          <div className="panel ledger kept"><h3>Stays on your machine</h3><ul>{KEPT.map((item) => <li key={item}>{item}</li>)}</ul></div>
        </div>
      </section>
      {leader ? (
        <section className="section wrap">
          <SectionHead title="Top of the rankings">{`${profileCount(board.participants)}, by lifetime AI tokens. Publish your profile to appear here.`}</SectionHead>
          <div className="panel"><Standings rows={board.leaders} column="GitHub user" tokenColumn="Lifetime tokens" profiles={{ viewer: viewer?.login ?? null }} /></div>
          <p><PageLink href="/rankings">See all rankings</PageLink></p>
        </section>
      ) : null}
      <section className="section wrap questions">
        <SectionHead title="Questions">Short answers. <a href="/how-we-count">How we count</a> and <a href="/privacy">Privacy</a> have the long ones.</SectionHead>
        <div className="panel faq">
          {QUESTIONS.map(([question, answer], index) => <details key={index}><summary>{question}</summary><p>{answer}</p></details>)}
        </div>
      </section>
      <div className="wrap">
        <section className="cta">
          <h2>Start counting</h2>
          <p>Install <code>oms</code>, sign in with GitHub, and run <code>oms sync</code> to see your first numbers.</p>
          <div className="actions">
            {start}
            <a className="button lg" href={`${REPO_URL}#get-started`}>Read the guide</a>
          </div>
        </section>
      </div>
    </Layout>
  );
}

export const landing: PageModule<LandingProps> = {
  async load({ url, viewer, deps }) {
    return { props: { origin: url.origin, viewer, board: await landingBoard(url.origin, deps) } };
  },
  View: LandingView,
};
