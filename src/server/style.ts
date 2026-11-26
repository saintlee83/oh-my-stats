/**
 * The website's shared stylesheet, sent inside every page. The private dashboard adds
 * its workspace styles from the static assets.
 *
 * Grays and blues are GitHub's, the same as the dashboard's default theme, so the
 * dashboard image sits on the page like any other panel. Greens are the logo's.
 */
const SOURCE = `
  :root {
    color-scheme: light dark;
    --bg: #f6f8fa; --surface: #ffffff; --raised: #f6f8fa;
    --ink: #1f2328; --ink2: #424a53; --muted: #59636e;
    --line: #d0d7de; --line-soft: #e6eaef;
    --link: #0969da; --focus: #0969da; --mine: rgba(9, 105, 218, 0.06);
    --button: #f6f8fa; --button-hover: #eaeef2;
    --primary: #1f883d; --primary-hover: #1a7f37; --primary-ink: #ffffff;
    --danger: #d1242f;
    --code: #f6f8fa; --code-inline: rgba(175, 184, 193, 0.2);
    --accent: #1a7f37; --accent-soft: #dafbe1; --meter: #2da44e;
    --g1: #aceebb; --g2: #4ac26b; --g3: #1a7f37; --g4: #0a4621; --spark: #0969da;
    --gold: #7d4e00; --gold-bg: #fff8c5; --silver: #424a53; --silver-bg: #e6eaef; --bronze: #762c00; --bronze-bg: #ffe2c8;
    --terminal: #0d1117;
    --shadow: 0 1px 2px rgba(31, 35, 40, 0.06); --shadow-lg: 0 16px 40px -16px rgba(31, 35, 40, 0.28);
    /* Series colors, for telling providers and models apart: eight hues in an order checked for color-vision safety, then gray for names drawn together. */
    --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300; --s7: #6250d6; --s8: #e34948; --s0: #afb8c1;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #010409; --surface: #0d1117; --raised: #161b22;
      --ink: #e6edf3; --ink2: #c9d1d9; --muted: #8b949e;
      --line: #30363d; --line-soft: #21262d;
      --link: #4493f8; --focus: #1f6feb; --mine: rgba(68, 147, 248, 0.1);
      --button: #21262d; --button-hover: #30363d;
      --primary: #238636; --primary-hover: #1f7a31;
      --danger: #f85149;
      --code: #161b22; --code-inline: rgba(110, 118, 129, 0.4);
      --accent: #3fb950; --accent-soft: rgba(46, 160, 67, 0.15); --meter: #3fb950;
      --g1: #1b5334; --g2: #247a43; --g3: #3cab60; --g4: #89e59f; --spark: #58a6ff;
      --gold: #e3b341; --gold-bg: rgba(187, 128, 9, 0.2); --silver: #c9d1d9; --silver-bg: rgba(110, 118, 129, 0.25); --bronze: #f0883e; --bronze-bg: rgba(219, 109, 40, 0.2);
      --terminal: #010409;
      --shadow: none; --shadow-lg: 0 16px 40px -16px rgba(0, 0, 0, 0.9);
      --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #0ca30c; --s7: #9085e9; --s8: #e66767; --s0: #6e7681;
    }
  }

  /* Base */
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--ink);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  main { flex: 1; width: 100%; max-width: 1032px; margin: 0 auto; padding: 8px 16px 72px; }
  a { color: var(--link); text-underline-offset: 2px; }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  h1 { font-size: 30px; font-weight: 700; line-height: 1.2; letter-spacing: -0.02em; margin: 28px 0 8px; }
  h2 { font-size: 16px; font-weight: 600; line-height: 1.3; margin: 0 0 12px; }
  h3 { font-size: 15px; font-weight: 600; line-height: 1.35; margin: 0 0 6px; }
  p { margin: 0 0 12px; color: var(--ink2); }
  .muted { color: var(--muted); font-size: 13px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

  /* Header and footer */
  .skip { position: absolute; left: 16px; top: -48px; z-index: 2; padding: 8px 12px; border-radius: 8px; background: var(--surface); border: 1px solid var(--line); font-weight: 600; }
  .skip:focus { top: 10px; }
  header.top, footer.bottom { background: var(--surface); }
  header.top { border-bottom: 1px solid var(--line); }
  .bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; max-width: 1032px; min-height: 56px; margin: 0 auto; padding: 9px 16px; }
  .brand { display: inline-flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 700; letter-spacing: -0.01em; color: var(--ink); text-decoration: none; }
  .brand img { display: block; border-radius: 6px; }
  nav.links { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  nav.links > a:not(.button) { padding: 6px 10px; border-radius: 8px; font-size: 14px; font-weight: 500; color: var(--ink2); text-decoration: none; }
  nav.links > a:not(.button):hover { background: var(--button-hover); color: var(--ink); }
  footer.bottom { border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
  footer.bottom .bar { min-height: 64px; padding-block: 16px; }
  footer.bottom p { margin: 0; color: inherit; }
  footer.bottom nav { display: flex; flex-wrap: wrap; gap: 4px 18px; }
  footer.bottom a { color: var(--muted); text-decoration: none; }
  footer.bottom a:hover { color: var(--ink); text-decoration: underline; }

  /* Buttons and forms */
  button, .button { appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 36px; padding: 6px 14px;
    font: inherit; font-size: 14px; font-weight: 600; line-height: 20px; white-space: nowrap; text-decoration: none; cursor: pointer;
    color: var(--ink); background: var(--button); border: 1px solid var(--line); border-radius: 8px; transition: background-color 0.12s, border-color 0.12s; }
  button:hover, .button:hover { background: var(--button-hover); }
  .primary { background: var(--primary); border-color: transparent; color: var(--primary-ink); }
  .primary:hover { background: var(--primary-hover); }
  .danger { color: var(--danger); }
  button.danger:hover { background: var(--danger); border-color: var(--danger); color: #ffffff; }
  .button.lg { min-height: 44px; padding: 10px 20px; font-size: 16px; border-radius: 10px; }
  .button svg { flex: none; width: 18px; height: 18px; fill: currentColor; }
  .button img, .who img { flex: none; border-radius: 50%; background: var(--raised); }
  input[type=text], textarea, select { font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 8px;
    padding: 6px 10px; min-height: 36px; width: 100%; max-width: 240px; }
  input:focus-visible, textarea:focus-visible, select:focus-visible { outline-offset: -1px; border-color: var(--focus); }
  ::placeholder { color: var(--muted); opacity: 1; }
  form.inline { display: inline-flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0; }
  /* In a table the row scrolls sideways instead, so a name and its button stay on one line. */
  td form.inline { flex-wrap: nowrap; }
  td input[type=text] { width: 10em; }
  .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px 16px; margin: 16px 0; }
  .fields label { display: grid; gap: 6px; font-size: 13px; font-weight: 600; color: var(--ink2); }
  .fields .wide { grid-column: 1 / -1; }
  .fields input[type=text], .fields textarea, .fields select { max-width: none; font-weight: 400; }
  .fields textarea { resize: vertical; }
  details.confirm summary { cursor: pointer; font-weight: 600; width: fit-content; padding: 6px 0; }
  details.confirm form { margin-top: 8px; }

  /* Panels, code and tables */
  .panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 20px 24px; margin: 16px 0; box-shadow: var(--shadow); overflow: hidden; }
  .panel > :last-child { margin-bottom: 0; }
  .panel-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 16px; margin: 0 0 12px; }
  .panel-head h2, .panel-head p { margin: 0; }
  .dash { overflow-x: auto; margin: 16px 0; border-radius: 12px; box-shadow: var(--shadow); }
  .dash svg { display: block; max-width: 100%; height: auto; }
  pre, code { font: 13px/1.55 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; }
  pre { background: var(--code); border: 1px solid var(--line-soft); border-radius: 8px; padding: 12px 14px; overflow-x: auto; margin: 8px 0 12px; }
  code { background: var(--code-inline); border-radius: 6px; padding: 0.15em 0.4em; }
  pre code { background: none; padding: 0; }
  .table { width: 100%; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 10px 16px 10px 0; border-bottom: 1px solid var(--line-soft); vertical-align: middle; white-space: nowrap; }
  th:last-child, td:last-child { padding-right: 0; }
  th { font-size: 12px; font-weight: 600; color: var(--muted); }
  thead th, thead td { border-bottom-color: var(--line); }
  tbody tr:last-child td { border-bottom: 0; }
  .num { text-align: right; }
  .badge { display: inline-block; font-size: 12px; font-weight: 600; line-height: 18px; padding: 0 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--ink2); vertical-align: 2px; }
  .badge.live { color: var(--accent); border-color: transparent; background: var(--accent-soft); }
  a.badge { background: var(--surface); text-decoration: none; }
  a.badge:hover { color: var(--link); border-color: var(--link); }
  /* A tool's mark goes before its name, in the name's color. The drawings the marks refer to take no room. */
  .marks { position: absolute; }
  .provider-icon { flex: none; width: 16px; height: 16px; margin-right: 8px; vertical-align: text-bottom; fill: currentColor; fill-rule: evenodd; }
  /* A link in a board spaces what it holds by itself. */
  .who a .provider-icon { margin-right: 0; }

  /* Page headings and their controls */
  .page-head { display: flex; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: 12px 24px; margin: 28px 0 16px; }
  .page-head h1 { margin: 0; }
  .page-head p { margin: 6px 0 0; max-width: 64ch; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin: 16px 0 12px; }
  .segments { display: inline-flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--line-soft); }
  .segments a { padding: 5px 12px; border-radius: 7px; font-size: 14px; font-weight: 500; color: var(--ink2); text-decoration: none; white-space: nowrap; }
  .segments a:hover { color: var(--ink); }
  .segments [aria-current=page] { background: var(--surface); color: var(--ink); font-weight: 600; box-shadow: 0 0 0 1px var(--line); }
  .filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 16px; }
  .filters a { padding: 3px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); font-size: 13px; font-weight: 500; color: var(--ink2); text-decoration: none; }
  .filters a:hover { color: var(--ink); border-color: var(--muted); }
  .filters [aria-current=page] { background: var(--ink); border-color: var(--ink); color: var(--surface); }
  .profile { display: flex; align-items: center; gap: 16px; margin: 28px 0 20px; }
  .profile > img { width: 64px; height: 64px; border-radius: 50%; border: 1px solid var(--line); background: var(--raised); }
  .profile > div { min-width: 0; }
  .profile > .actions { flex: none; margin-left: auto; }
  .profile h1 { margin: 0; font-size: 26px; overflow-wrap: anywhere; }
  .profile p { margin: 2px 0 0; color: var(--muted); }
  .profile p + p { margin-top: 8px; }

  /* Rankings */
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin: 16px 0; }
  .tile { display: grid; gap: 2px; padding: 16px 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); font-size: 13px; color: var(--muted); }
  .tile strong { font-size: 30px; line-height: 1.15; letter-spacing: -0.02em; color: var(--ink); font-variant-numeric: tabular-nums; }
  .tile-label { font-weight: 600; color: var(--ink2); }
  .standings td { padding-block: 8px; }
  .standings .rank { width: 1%; }
  .standings .meter { width: 36%; }
  .place { display: inline-grid; place-items: center; min-width: 28px; height: 28px; padding: 0 7px; border-radius: 999px; font-size: 13px; font-weight: 600; color: var(--muted); }
  .place[data-place="1"] { color: var(--gold); background: var(--gold-bg); }
  .place[data-place="2"] { color: var(--silver); background: var(--silver-bg); }
  .place[data-place="3"] { color: var(--bronze); background: var(--bronze-bg); }
  .who { font-weight: 600; }
  .who a { display: inline-flex; align-items: center; gap: 10px; color: var(--ink); text-decoration: none; vertical-align: middle; }
  .who a:hover { color: var(--link); text-decoration: underline; }
  .who .badge { margin-left: 6px; vertical-align: middle; }
  .meter span { display: block; height: 8px; width: var(--share); min-width: 3px; border-radius: 4px; background: var(--meter); }
  .standings .num strong { font-size: 15px; }
  .standings .num small { display: block; font-size: 12px; line-height: 1.3; color: var(--muted); }
  tr.me td { background: var(--mine); }
  tr.me td:first-child { box-shadow: inset 3px 0 0 var(--link); }

  /* Activity */
  .activity-panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 350px), 1fr)); gap: 16px; margin: 16px 0; }
  .activity-panels .panel { margin: 0; }
  .day[data-level="1"] { background: var(--g1); }
  .day[data-level="2"] { background: var(--g2); }
  .day[data-level="3"] { background: var(--g3); }
  .day[data-level="4"] { background: var(--g4); }
  /* A day that is pointed at, by a mouse, a tap or the arrow keys. */
  .day[data-date]:hover, .day.on { outline: 2px solid var(--ink); outline-offset: 1px; }
  .weeks:focus-visible { outline: 2px solid var(--focus); outline-offset: 4px; border-radius: 4px; }
  /* What a day says when it is pointed at. It floats over the page, placed by the script that shows it. */
  .tip { position: fixed; z-index: 20; left: 0; top: 0; min-width: 200px; max-width: min(320px, calc(100vw - 16px)); padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px;
    background: var(--surface); color: var(--ink); box-shadow: var(--shadow-lg); font-size: 12px; line-height: 1.5; font-weight: 400; letter-spacing: 0; text-align: left; pointer-events: none; }
  .tip p { margin: 0; color: inherit; }
  .tip .tip-date { font-weight: 600; color: var(--muted); }
  .tip .tip-total { color: var(--ink2); }
  .tip-total strong { font-size: 16px; color: var(--ink); font-variant-numeric: tabular-nums; }
  .tip .tip-head { margin-top: 8px; padding-top: 7px; border-top: 1px solid var(--line-soft); font-size: 11px; font-weight: 600; color: var(--muted); }
  .tip-row { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto 40px; align-items: center; gap: 8px; font-variant-numeric: tabular-nums; }
  /* A short stroke of the series color: at this size a filled box would outweigh the figures. */
  .tip-row i { height: 3px; border-radius: 2px; }
  .tip-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink2); }
  .tip-row b { font-weight: 600; text-align: right; }
  .tip-row em { font-style: normal; text-align: right; color: var(--muted); }
  .tip .tip-note { margin-top: 6px; font-size: 11px; color: var(--muted); }

  /* Install commands: one pane per system, switched without scripts */
  .terminal { display: grid; grid-template-columns: auto auto 1fr; position: relative; overflow: hidden; text-align: left; color: #e6edf3; background: var(--terminal); border: 1px solid #30363d; border-radius: 12px; }
  .terminal input { position: absolute; opacity: 0; pointer-events: none; }
  .terminal label { padding: 10px 16px 8px; border-bottom: 2px solid transparent; font-size: 13px; font-weight: 600; color: #8b949e; cursor: pointer; }
  .terminal label:hover { color: #e6edf3; }
  .terminal input:checked + label { color: #e6edf3; border-bottom-color: #3fb950; }
  .terminal input:focus-visible + label { outline: 2px solid #58a6ff; outline-offset: -3px; border-radius: 6px; }
  .terminal pre { display: none; grid-column: 1 / -1; margin: 0; padding: 16px 18px; border: 0; border-top: 1px solid #30363d; border-radius: 0; background: none; color: inherit; font-size: 14px; line-height: 1.75; }
  .terminal input:nth-of-type(1):checked ~ pre:nth-of-type(1), .terminal input:nth-of-type(2):checked ~ pre:nth-of-type(2) { display: block; }
  .github-setup { margin-top: 16px; text-align: left; }
  .github-setup summary { cursor: pointer; font-weight: 600; }
  .github-setup[open] summary { margin-bottom: 8px; }
  .github-setup li + li { margin-top: 8px; }
  .github-setup ol { margin: 0; padding-inline-start: 24px; color: var(--ink2); }

  /* Landing page */
  main.bleed { max-width: none; padding: 0 0 72px; }
  .wrap { max-width: 1032px; margin: 0 auto; padding: 0 16px; }
  .hero { position: relative; overflow: hidden; padding: 72px 0 64px; text-align: center; background: var(--surface); border-bottom: 1px solid var(--line); }
  .hero .wrap { position: relative; }
  /* Shown at the sides only, fading out before it reaches the words in the middle. */
  .hero-art { position: absolute; left: 50%; bottom: -6px; transform: translateX(-50%); pointer-events: none;
    -webkit-mask-image: linear-gradient(90deg, transparent 3%, #000 12%, #000 20%, transparent 31%, transparent 69%, #000 80%, #000 88%, transparent 97%);
    mask-image: linear-gradient(90deg, transparent 3%, #000 12%, #000 20%, transparent 31%, transparent 69%, #000 80%, #000 88%, transparent 97%); }
  .eyebrow { display: inline-flex; align-items: center; gap: 8px; margin: 0 0 20px; padding: 4px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); font-size: 13px; font-weight: 500; color: var(--ink2); }
  .eyebrow::before { content: ""; width: 8px; height: 8px; border-radius: 2px; background: var(--g2); }
  .hero h1 { margin: 0 0 16px; font-size: clamp(34px, 5.6vw, 56px); line-height: 1.05; letter-spacing: -0.035em; text-wrap: balance; }
  .lead { max-width: 60ch; margin: 0 auto 28px; font-size: clamp(16px, 1.7vw, 19px); line-height: 1.55; text-wrap: pretty; }
  .hero .actions { justify-content: center; gap: 12px; }
  .hero .terminal { max-width: 640px; margin: 40px auto 14px; box-shadow: var(--shadow-lg); }
  .hero .github-setup { max-width: 640px; margin-inline: auto; }
  .hero .github-setup summary { text-align: center; }
  .hero .muted { margin: 0; }
  .section { padding-top: 64px; }
  .section-head { margin: 0 0 24px; }
  .section-head h2 { margin: 0 0 6px; font-size: 26px; font-weight: 700; letter-spacing: -0.02em; }
  .section-head p { margin: 0; max-width: 64ch; font-size: 16px; }
  .showcase { display: block; position: relative; max-height: 540px; overflow: hidden; border-radius: 12px; }
  .showcase img { display: block; width: 100%; height: auto; }
  .showcase::after { content: ""; position: absolute; inset: auto 0 0; height: 140px; background: linear-gradient(transparent, var(--bg)); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .feature { padding: 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); }
  .feature p { margin: 0; font-size: 14px; line-height: 1.55; }
  .icon { display: grid; place-items: center; width: 36px; height: 36px; margin: 0 0 14px; border-radius: 9px; color: var(--accent); background: var(--accent-soft); }
  .icon svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .chips li { padding: 4px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); font-size: 13px; font-weight: 500; color: var(--ink2); }
  .ledger { margin: 0; }
  .ledger ul { margin: 0; padding: 0; list-style: none; }
  .ledger li { position: relative; padding: 9px 0 9px 24px; border-top: 1px solid var(--line-soft); font-size: 14px; color: var(--ink2); }
  .ledger li::before { content: ""; position: absolute; left: 1px; top: 15px; width: 10px; height: 10px; border-radius: 3px; background: var(--g2); }
  .ledger.kept li::before { background: var(--line); }
  .cta { margin-top: 64px; padding: 44px 24px; text-align: center; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); }
  .cta h2 { margin: 0 0 8px; font-size: 26px; font-weight: 700; letter-spacing: -0.02em; }
  .cta p { margin: 0 auto 24px; max-width: 52ch; font-size: 16px; }
  .cta .actions { justify-content: center; gap: 12px; }
  .notice { padding: 56px 0 24px; text-align: center; }
  .notice .code { margin: 0 0 8px; font-size: 14px; font-weight: 600; color: var(--muted); font-variant-numeric: tabular-nums; }
  .notice h1 { margin: 0 0 24px; text-wrap: balance; }
  .notice .actions { justify-content: center; }

  /* Rankings boards */
  .board-tabs { display: flex; gap: 4px; margin: 0 0 16px; box-shadow: inset 0 -1px 0 var(--line); }
  .board-tabs a { padding: 8px 12px; border-bottom: 2px solid transparent; font-size: 14px; font-weight: 500; color: var(--ink2); text-decoration: none; }
  .board-tabs a:hover { color: var(--ink); border-bottom-color: var(--line); }
  .board-tabs a[aria-current=page] { color: var(--ink); font-weight: 600; border-bottom-color: var(--accent); }
  /* Five periods are wider than a phone, so they take a second row and fill both. */
  .segments { flex-wrap: wrap; }
  .segments a { flex: 1 1 auto; text-align: center; }
  .toolbar .filters { margin: 0; }
  .who b, .who small { display: block; line-height: 1.35; }
  .who a b, .who a small { max-width: 32ch; overflow: hidden; text-overflow: ellipsis; }
  .who small { font-size: 12px; font-weight: 400; color: var(--muted); }
  .reach .meter { width: 24%; }
  .standings .up { color: var(--accent); }
  .standings .down { color: var(--danger); }
  .standings small.narrow { display: none; }
  .board-pager { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; justify-items: start; gap: 12px; margin-top: 16px; font-size: 13px; color: var(--muted); }
  .board-pager > :last-child { justify-self: end; }
  @media (max-width: 640px) {
    /* A phone shows one column of numbers. What the others said is written under the name or the number. */
    .standings .wide, .standings small.narrow + small { display: none; }
    .standings small.narrow { display: block; }
    /* The name takes the width the numbers leave, and a long one is cut short there. */
    .standings .who { width: 100%; max-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .who a { max-width: 100%; overflow: hidden; }
    .who a:focus-visible { outline-offset: -2px; }
    .me .who a { max-width: calc(100% - 46px); }
    .who a span { min-width: 0; }
    .reach .who { white-space: normal; overflow-wrap: anywhere; }
  }

  /* Profile and dashboard */
  /* The name keeps room for its rank beside the 64px picture and its gap. The buttons drop below when none is left. */
  .profile { flex-wrap: wrap; }
  .profile > div:first-of-type { flex: 1 1 min(340px, calc(100% - 80px)); }
  .profile > .actions { flex: 0 1 auto; margin-left: 0; }
  /* Panes switched without scripts: the nth radio marks the nth label as chosen and shows the nth pane. */
  .panes { position: relative; }
  .panes > input { position: absolute; opacity: 0; pointer-events: none; }
  .panes .panel-head { align-items: center; gap: 10px 16px; }
  .panes .segments { flex-wrap: wrap; }
  .segments label { display: grid; padding: 5px 12px; border-radius: 7px; font-size: 14px; font-weight: 500; color: var(--ink2); white-space: nowrap; cursor: pointer; }
  /* Keeps the width of the chosen label's heavier text, so choosing one moves nothing. */
  .segments label::after { content: attr(data-label); height: 0; overflow: hidden; visibility: hidden; font-weight: 600; }
  .segments label:hover { color: var(--ink); }
  .panes > input:nth-of-type(1):checked ~ .panel-head label:nth-of-type(1), .panes > input:nth-of-type(2):checked ~ .panel-head label:nth-of-type(2), .panes > input:nth-of-type(3):checked ~ .panel-head label:nth-of-type(3),
  .panes > input:nth-of-type(4):checked ~ .panel-head label:nth-of-type(4), .panes > input:nth-of-type(5):checked ~ .panel-head label:nth-of-type(5) { background: var(--surface); color: var(--ink); font-weight: 600; box-shadow: 0 0 0 1px var(--line); }
  .panes > input:nth-of-type(1):focus-visible ~ .panel-head label:nth-of-type(1), .panes > input:nth-of-type(2):focus-visible ~ .panel-head label:nth-of-type(2), .panes > input:nth-of-type(3):focus-visible ~ .panel-head label:nth-of-type(3),
  .panes > input:nth-of-type(4):focus-visible ~ .panel-head label:nth-of-type(4), .panes > input:nth-of-type(5):focus-visible ~ .panel-head label:nth-of-type(5) { outline: 2px solid var(--focus); outline-offset: 2px; }
  .panes > .pane { display: none; }
  .panes > input:nth-of-type(1):checked ~ .pane:nth-of-type(1), .panes > input:nth-of-type(2):checked ~ .pane:nth-of-type(2), .panes > input:nth-of-type(3):checked ~ .pane:nth-of-type(3),
  .panes > input:nth-of-type(4):checked ~ .pane:nth-of-type(4), .panes > input:nth-of-type(5):checked ~ .pane:nth-of-type(5) { display: block; }
  .panes > .pane > p:last-child { margin-bottom: 0; }
  /* A year of days. A narrow screen scrolls it sideways, and the last 12 months start at their newest week. */
  .weeks-scroll { overflow-x: auto; padding: 6px; margin: -6px; scroll-padding-left: 38px; }
  .weeks-scroll.newest { direction: rtl; }
  /* The weeks share the panel's width, and keep days large enough to tap where it is narrow. */
  .weeks-fit { min-width: 900px; direction: ltr; }
  .weeks { display: grid; grid-auto-flow: column; grid-template-columns: 26px; grid-auto-columns: minmax(0, 1fr); grid-template-rows: 16px repeat(7, auto); gap: 3px; }
  .weeks .day { aspect-ratio: 1; }
  .weeks small, .scale small { font-size: 11px; line-height: 14px; color: var(--muted); white-space: nowrap; }
  /* The weekday names stay in view while the weeks scroll under them. */
  .weeks > :nth-child(-n+8) { position: sticky; left: 0; z-index: 1; background: var(--surface); }
  span.day { background: var(--line-soft); }
  .weeks .day, .scale .day { border-radius: 3px; }
  .scale { display: flex; align-items: center; justify-content: flex-end; gap: 3px; margin: 10px 0 0; pointer-events: none; }
  .scale .day { width: 14px; height: 14px; }
  .scale small { margin: 0 3px; }
  .figures { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0 0 12px; }
  .figure { display: grid; align-content: start; gap: 2px; min-width: 0; padding: 14px 16px; border: 1px solid var(--line-soft); border-radius: 10px; background: var(--raised); font-size: 13px; color: var(--muted); }
  .figure > span:first-child { font-weight: 600; color: var(--ink2); }
  .figure strong { font-size: 22px; line-height: 1.25; letter-spacing: -0.01em; color: var(--ink); overflow-wrap: anywhere; }
  /* The dashboard image's first four series colors, in its order, checked the same way against each surface. */
  .mix { --input: #2a78d6; --output: #eb6834; --cache-read: #1baf7a; --cache-write: #eda100; }
  @media (prefers-color-scheme: dark) { .mix { --input: #3987e5; --output: #d95926; --cache-read: #199e70; --cache-write: #c98500; } }
  .mix-bar { display: flex; gap: 2px; height: 8px; margin: 4px 0 8px; }
  .mix-bar span { min-width: 3px; border-radius: 4px; }
  .mix td i { display: inline-block; width: 10px; height: 10px; margin-right: 8px; border-radius: 3px; }
  /* A period's tokens by provider and by model: a bar for the split, and a table that names each part beside its color. */
  .breakdowns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 40px; margin: 20px 0 14px; }
  .breakdown { min-width: 0; }
  .breakdown h3 { margin: 0 0 10px; font-size: 13px; color: var(--ink2); }
  .breakdown .mix-bar { height: 10px; margin: 0 0 8px; }
  .breakdown .mix-bar span { border-radius: 5px; }
  .breakdown > .muted { margin: 8px 0 0; }
  .shares td { padding: 6px 0 6px 16px; font-size: 14px; }
  /* A name takes the width its figures leave, and a long one is cut short there. */
  .shares td:first-child { width: 100%; max-width: 0; padding-left: 0; overflow: hidden; text-overflow: ellipsis; color: var(--ink); }
  .shares td:last-child { min-width: 64px; }
  .shares td i { display: inline-block; width: 10px; height: 10px; margin-right: 8px; border-radius: 3px; }
  .shares td.num { color: var(--muted); }
  .shares td.num strong { font-weight: 600; color: var(--ink); }
  @media (max-width: 760px) { .breakdowns { grid-template-columns: minmax(0, 1fr); } }
  /* Two tiles to a row once four are too narrow for a date, and one where two are. */
  @media (max-width: 760px) { .figures { grid-template-columns: repeat(auto-fit, minmax(max(140px, calc(50% - 6px)), 1fr)); } }
  @media (max-width: 640px) {
    .figures { gap: 8px; }
    .figure { padding: 12px; }
    .figure strong { font-size: 19px; }
  }

  /* The daily chart: a bar for each day, split by provider or by model. The dashboard places it in its own grid. */
  .trend-card { min-width: 0; margin: 16px 0; padding: 22px 24px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow); }
  .trend-total { margin-top: 14px; color: var(--ink); font-size: clamp(30px, 3vw, 40px); font-weight: 600; line-height: 1.05; letter-spacing: -.045em; }
  .trend-total span { font-size: 14px; font-weight: 450; color: var(--muted); letter-spacing: 0; }
  .trend-range { margin: 4px 0 20px; font-size: 12px; color: var(--muted); }
  .trend-range strong { color: var(--ink2); font-weight: 650; }
  .plot-area { display: grid; grid-template-columns: 38px minmax(0, 1fr); }
  .plot-scale, .plot-dates, .plot-detail { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted); }
  .plot-scale { display: flex; flex-direction: column; justify-content: space-between; }
  .plot { position: relative; height: 168px; border-top: 1px solid var(--line-soft); border-bottom: 1px solid var(--line); background: linear-gradient(to bottom, transparent calc(50% - .5px), var(--line-soft) calc(50% - .5px) calc(50% + .5px), transparent calc(50% + .5px)); }
  .plot-slots, .plot input { position: absolute; inset: 0; width: 100%; height: 100%; }
  .plot-slots { display: flex; }
  /* A day's room. Its bar is thinner than the room, and never wider than 24px. */
  .plot-slot { flex: 1 1 0; min-width: 0; display: flex; align-items: flex-end; justify-content: center; padding: 0 1px; border-radius: 3px 3px 0 0; }
  .plot-slot.selected { background: var(--line-soft); }
  /* One day, split from the baseline up. The gaps are the surface showing through, which keeps neighbours apart. */
  .plot-bar { display: flex; flex-direction: column-reverse; container-type: size; width: 100%; max-width: 24px; min-height: 2px; border-radius: 3px 3px 0 0; overflow: hidden; }
  .plot-bar b { flex: 1 1 0; min-height: 0; }
  /* The surface shows between two parts, but for at most a twenty-fifth of the bar's height each
     time, so a day too small for gaps keeps its colors. Without container units there is no gap. */
  .plot-bar b + b { margin-bottom: 0; margin-bottom: min(2px, 4cqh); }
  .plot input { margin: 0; opacity: 0; cursor: crosshair; }
  .plot:has(input:focus-visible) { outline: 2px solid var(--focus); outline-offset: 3px; }
  .plot-dates { display: flex; justify-content: space-between; margin: 7px 0 0 38px; }
  .plot-keys { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; min-height: 27px; margin: 14px 0 0 38px; }
  .plot-keys ul { display: flex; flex-wrap: wrap; gap: 4px 16px; min-width: 0; margin: 0; padding: 0; list-style: none; font-size: 12px; color: var(--ink2); }
  .plot-keys li { min-width: 0; overflow-wrap: anywhere; }
  .plot-keys li i { display: inline-block; width: 10px; height: 10px; margin-right: 6px; border-radius: 3px; }
  .switch { display: inline-flex; padding: 2px; border: 1px solid var(--line-soft); border-radius: 7px; background: var(--raised); }
  .switch button { min-height: 0; padding: 3px 9px; border: 0; border-radius: 4px; background: none; color: var(--muted); font-size: 12px; font-weight: 550; line-height: 19px; }
  .switch button:hover { color: var(--ink); background: none; }
  .switch button[aria-pressed="true"] { background: var(--ink); color: var(--surface); }
  .plot-detail { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; margin: 14px 0 0; padding-top: 10px; border-top: 1px solid var(--line-soft); }
  .plot-detail span { font: 12px/1.4 system-ui, sans-serif; }
  .plot-detail b { color: var(--ink2); font-weight: 500; }
  @media (max-width: 760px) { .plot-keys { margin-left: 0; } }
  @media (max-width: 600px) {
    .trend-card { padding: 17px 16px; }
    .plot { height: 132px; }
  }

  /* Groups */
  .group-crumb { margin: 0 0 4px; font-size: 13px; font-weight: 600; }
  .group-crumb a { color: var(--muted); text-decoration: none; }
  .group-crumb a:hover { color: var(--link); text-decoration: underline; }
  /* A name is one unbroken word as often as not, and must not push the page sideways. */
  .group-head > div:first-child { min-width: 0; }
  .group-head h1, .group-head p, .group-list a, .group-list p { overflow-wrap: anywhere; }
  .group-facts { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; margin-top: 10px; }
  .group-facts .badge { vertical-align: 0; }
  /* Five periods are more than a phone is wide, so they take a second row there. */
  .group-periods { flex-wrap: wrap; }
  .group-tiles { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  /* One tile can hold a line more than the other, and the shorter one keeps its lines together. */
  .group-tiles .tile { align-content: start; }
  /* A name with its badges may take two lines, so the tokens stay on the screen of a phone. */
  .group-board .who { white-space: normal; overflow-wrap: anywhere; }
  .group-board .who .badge { margin-block: 2px; }
  .group-list { margin: 0; padding: 0; list-style: none; }
  .group-list li { display: flex; align-items: baseline; justify-content: space-between; gap: 4px 24px; padding: 12px 0; border-top: 1px solid var(--line-soft); }
  .group-list li:first-child { padding-top: 0; border-top: 0; }
  .group-list li:last-child { padding-bottom: 0; }
  .group-list div { min-width: 0; }
  .group-list a { font-weight: 600; color: var(--ink); text-decoration: none; }
  .group-list a:hover { color: var(--link); text-decoration: underline; }
  .group-list .badge { margin-left: 8px; }
  .group-list p { margin: 2px 0 0; font-size: 14px; color: var(--muted); }
  .group-count { flex: none; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .group-roster li { align-items: center; flex-wrap: wrap; }
  .group-roster .who { overflow-wrap: anywhere; }
  .group-roster p { font-size: 13px; font-weight: 400; }
  .group-roster details.confirm form { margin: 0 0 4px; }
  /* Two fields and one wide one: a grid that fits as many columns as it can would leave half the row empty. */
  .group-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  @media (max-width: 640px) { .group-fields { grid-template-columns: minmax(0, 1fr); } }
  .group-start { margin-top: 16px; }
  .group-start summary { width: fit-content; list-style: none; }
  .group-start summary::-webkit-details-marker { display: none; }
  .group-start[open] summary { margin-bottom: 16px; }
  .group-member { display: inline-flex; align-items: center; gap: 10px; vertical-align: middle; }
  .group-audience { margin-top: 12px; }
  .group-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .group-notice h1 { margin-bottom: 12px; }
  .group-notice p:not(.code) { max-width: 60ch; margin: 0 auto 12px; }
  .group-notice .actions { margin-top: 24px; }

  /* Reading pages */
  .tally { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 40px; padding-top: 20px; list-style: none; }
  .tally li { display: flex; align-items: baseline; gap: 8px; }
  .tally strong { font-size: 18px; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
  .tally span { font-size: 13px; color: var(--muted); }
  .steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; margin: 0; padding: 0; list-style: none; counter-reset: step; }
  .steps li { position: relative; counter-increment: step; }
  .steps li::before { content: counter(step); display: grid; place-items: center; width: 32px; height: 32px; margin: 0 0 14px; border-radius: 50%; font-size: 14px; font-weight: 700; color: var(--accent); background: var(--accent-soft); }
  /* A line from each number to the next, so the three read as one sequence. */
  .steps li::after { content: ""; position: absolute; top: 16px; left: 44px; right: -12px; height: 1px; background: var(--line); }
  .steps li:last-child::after { display: none; }
  .steps p { margin: 0; max-width: 44ch; font-size: 14px; line-height: 1.55; }
  /* The heading beside the answers, as on the reading pages, which keeps an answer's lines short. */
  .questions { display: grid; grid-template-columns: 256px minmax(0, 1fr); gap: 0 48px; align-items: start; }
  .faq { margin: 0; padding-block: 6px; }
  .faq details + details { border-top: 1px solid var(--line-soft); }
  .faq summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; font-weight: 600; cursor: pointer; list-style: none; }
  .faq summary::-webkit-details-marker { display: none; }
  .faq summary::after { content: ""; flex: none; width: 8px; height: 8px; margin: -4px 4px 0; border: solid var(--muted); border-width: 0 2px 2px 0; transform: rotate(45deg); }
  .faq [open] > summary::after { margin-top: 4px; transform: rotate(-135deg); }
  .faq summary:hover { color: var(--link); }
  .faq summary:focus-visible { outline-offset: -2px; border-radius: 6px; }
  .faq p { max-width: 34em; margin: 0; padding: 0 0 16px; }
  .reading { margin: 20px 0 0; }
  .reading > section { display: grid; grid-template-columns: 256px minmax(0, 1fr); gap: 8px 48px; padding: 28px 0; border-top: 1px solid var(--line); scroll-margin-top: 12px; }
  .reading h2 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.01em; }
  /* About 70 characters to a line. */
  .reading h2 + div { max-width: 32em; font-size: 16px; line-height: 1.65; text-wrap: pretty; }
  .reading h2 + div > :last-child { margin-bottom: 0; }
  .reading h3 { margin: 22px 0 6px; font-size: 16px; }
  .reading h3:first-child { margin-top: 0; }
  .reading p, .reading ul, .reading .table { margin: 0 0 14px; }
  .reading ul { padding-left: 20px; color: var(--ink2); }
  .reading li { margin: 0 0 6px; padding-left: 2px; }
  .reading li::marker { color: var(--muted); }
  .reading table { font-size: 14px; line-height: 1.5; }
  .reading th, .reading td { white-space: normal; vertical-align: top; }
  @media (max-width: 760px) {
    /* Stacked, the numbers share a column, so the lines start at one edge. */
    .tally { display: grid; grid-template-columns: auto auto; gap: 2px 10px; }
    .tally li { display: contents; }
    .tally strong { text-align: right; }
    .steps { grid-template-columns: minmax(0, 1fr); gap: 20px; }
    .steps li { padding-left: 46px; }
    .steps li::before { position: absolute; left: 0; top: -4px; margin: 0; }
    .steps li::after { display: none; }
    .steps p { max-width: none; }
    .questions { grid-template-columns: minmax(0, 1fr); }
    /* One row that scrolls sideways, so a phone shows the page's first words and not only its contents. */
    .jump { flex-wrap: nowrap; overflow-x: auto; margin-inline: -16px; padding: 2px 16px; }
    .jump a { flex: none; }
    .reading > section { grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 24px 0; }
  }
  /* Six footer links don't fit one row of a phone. Two rows of three leave none on its own. */
  @media (max-width: 480px) { footer.bottom nav { display: grid; grid-template-columns: repeat(3, auto); justify-content: start; } }

  @media (max-width: 860px) { .hero-art { display: none; } }
  @media (max-width: 640px) {
    h1 { font-size: 25px; }
    .panel { padding: 16px; }
    .dash svg { min-width: 720px; max-width: none; }
    .hero { padding: 48px 0 44px; }
    .hero br { display: none; }
    .section { padding-top: 48px; }
    .section-head h2, .cta h2 { font-size: 22px; }
    .standings .meter { display: none; }
    .terminal pre { font-size: 13px; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

/** Comments and layout whitespace are for whoever edits this file, not for the page. */
export const STYLE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/ ?([{};,]) ?|(:) /g, '$1$2').trim();
