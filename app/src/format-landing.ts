/** Marketing landing page markup (presentation only). */
import { escapeText } from "./format.js";

export function landingPageHtml(opts: { demoData: boolean; production: boolean }): string {
  const demoNote = opts.demoData
    ? `<div class="landing-demo-pill" role="status"><strong>FREE DEMO</strong><span>Fictional DEMO DATA — not real fixtures or money</span></div>`
    : `<div class="landing-demo-pill" role="status"><strong>FREE TO PLAY</strong><span>Build an XI · Join contests · Climb the board</span></div>`;

  return `<div class="landing">
  <header class="landing-top">
    <a class="brand brand-lg" href="#/">KICKR</a>
    <nav class="landing-nav">
      <a href="#how">How it works</a>
      <a href="#demo">Live demo</a>
      <a href="#tech">Technology</a>
    </nav>
    <div class="landing-top-actions">
      <button type="button" class="ghost" id="explore-demo">Explore Demo</button>
      <button type="button" class="primary" id="play-free">Play Free</button>
    </div>
  </header>

  <section class="hero">
    <div class="hero-copy">
      ${demoNote}
      <h1 class="hero-title">KICKR</h1>
      <p class="hero-tag">Transparent scoring. Verifiable settlement architecture.</p>
      <p class="hero-lede">Build your XI, join FREE contests, and watch the leaderboard move with every goal — built for the pitch, not a spreadsheet.</p>
      <div class="hero-cta">
        <button type="button" class="primary primary-lg" id="play-free-hero">Play Free</button>
        <button type="button" class="ghost ghost-lg" id="explore-demo-hero">Explore Demo</button>
      </div>
      <p class="note" id="auth-note"></p>
    </div>
    <div class="hero-stage" aria-hidden="true">
      <div class="mock-match card">
        <div class="meta"><span class="badge badge-live">LIVE</span><span class="quiet">DEMO Cup · 67'</span></div>
        <div class="match-tile">
          <div class="team-side"><div class="crest">NV</div><div><strong>Northvale FC</strong><div class="quiet">NVF</div></div></div>
          <div class="kickoff"><strong class="score-mock">1 – 1</strong><div class="quiet">Kickoff 19:30</div></div>
          <div class="team-side away"><div class="crest">HB</div><div><strong>Harbor Bay</strong><div class="quiet">HBY</div></div></div>
        </div>
      </div>
      <div class="mock-grid">
        <div class="mock-xi card">
          <div class="meta"><span>Your XI</span><span class="badge badge-c">C</span></div>
          <div class="pitch pitch-sm">
            <div class="line"><div class="chip selected-slot"><div class="avatar">OK</div><div class="name">Okafor</div><span class="role badge badge-c">C</span></div><div class="chip selected-slot"><div class="avatar">RL</div><div class="name">Ramos</div></div></div>
            <div class="line"><div class="chip selected-slot"><div class="avatar">MS</div><div class="name">Silva</div></div><div class="chip selected-slot"><div class="avatar">JP</div><div class="name">Park</div><span class="role badge badge-vc">VC</span></div><div class="chip selected-slot"><div class="avatar">TN</div><div class="name">Nguyen</div></div></div>
            <div class="line"><div class="chip selected-slot"><div class="avatar">DK</div><div class="name">Khan</div></div><div class="chip selected-slot"><div class="avatar">EL</div><div class="name">Lopez</div></div><div class="chip selected-slot"><div class="avatar">CW</div><div class="name">West</div></div><div class="chip selected-slot"><div class="avatar">AM</div><div class="name">Moreau</div></div></div>
            <div class="line"><div class="chip selected-slot"><div class="avatar">BG</div><div class="name">Garcia</div></div></div>
          </div>
        </div>
        <div class="mock-lb card">
          <div class="meta"><span class="badge badge-live">LIVE</span><span>Leaderboard</span></div>
          <div class="leaderboard">
            <div class="lb-row top-1 you"><div class="rank">#1 <span class="rank-move up">▲2</span></div><div><strong>You</strong></div><div class="score-cell"><strong>84.5</strong><div class="score-delta">+6.0</div></div></div>
            <div class="lb-row top-2"><div class="rank">#2</div><div>Rival XI</div><div class="score-cell"><strong>81.0</strong></div></div>
            <div class="lb-row top-3"><div class="rank">#3</div><div>Harbor Heroes</div><div class="score-cell"><strong>76.5</strong></div></div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="landing-section" id="how">
    <p class="section-kicker">How it works</p>
    <h2>From kickoff to final whistle</h2>
    <div class="how-grid">
      <article class="card how-card"><span class="how-num">01</span><h3>Pick a match</h3><p class="quiet">Choose a DEMO Cup fixture and open the player pool.</p></article>
      <article class="card how-card"><span class="how-num">02</span><h3>Build your XI</h3><p class="quiet">Fill the pitch, set Captain &amp; Vice, stay inside the credit budget.</p></article>
      <article class="card how-card"><span class="how-num">03</span><h3>Join FREE</h3><p class="quiet">Enter Head-to-Head or Grand League — no USDC, no prize pool.</p></article>
      <article class="card how-card"><span class="how-num">04</span><h3>Climb live</h3><p class="quiet">Scores update as events land. Rank moves. Final result locks in.</p></article>
    </div>
  </section>

  <section class="landing-section" id="demo">
    <p class="section-kicker">Live Demo Match</p>
    <h2>Broadcast energy, fantasy stakes</h2>
    <p class="quiet section-lede">Illustrative DEMO Cup board — the real app uses the same match identity, LIVE badges, and pitch layout.</p>
    <article class="card landing-feature match-feature">
      <div class="match-tile">
        <div class="team-side"><div class="crest crest-lg">NV</div><div><strong>Northvale FC</strong><div class="quiet">Home</div></div></div>
        <div class="kickoff"><span class="badge badge-live">LIVE 67'</span><strong class="score-mock">1 – 1</strong><div class="quiet">DEMO DATA</div></div>
        <div class="team-side away"><div class="crest crest-lg">HB</div><div><strong>Harbor Bay</strong><div class="quiet">Away</div></div></div>
      </div>
    </article>
  </section>

  <section class="landing-section" id="xi">
    <p class="section-kicker">Build Your XI</p>
    <h2>The pitch is the product</h2>
    <p class="quiet section-lede">Positional layout, player cards, C/VC, formation, and credits — designed as the hero screen.</p>
    <div class="landing-split">
      <div class="pitch pitch-feature">
        <div class="line"><div class="chip selected-slot"><div class="avatar">OK</div><div class="name">Okafor</div><span class="role badge badge-c">C</span></div><div class="chip selected-slot"><div class="avatar">RL</div><div class="name">Ramos</div></div></div>
        <div class="line"><div class="chip selected-slot"><div class="avatar">MS</div><div class="name">Silva</div></div><div class="chip selected-slot"><div class="avatar">JP</div><div class="name">Park</div><span class="role badge badge-vc">VC</span></div><div class="chip selected-slot"><div class="avatar">TN</div><div class="name">Nguyen</div></div></div>
        <div class="line"><div class="chip selected-slot"><div class="avatar">DK</div><div class="name">Khan</div></div><div class="chip selected-slot"><div class="avatar">EL</div><div class="name">Lopez</div></div><div class="chip selected-slot"><div class="avatar">CW</div><div class="name">West</div></div><div class="chip selected-slot"><div class="avatar">AM</div><div class="name">Moreau</div></div></div>
        <div class="line"><div class="chip selected-slot"><div class="avatar">BG</div><div class="name">Garcia</div></div></div>
      </div>
      <div class="stack">
        <div class="card"><div class="credits-panel"><div><div class="quiet">Credits remaining</div><div class="credits-left">12</div></div><div class="xi-count">88 / 100 used</div></div><div class="meter"><span style="width:88%"></span></div></div>
        <div class="card"><strong>4-3-3</strong><p class="quiet">11/11 selected · Captain &amp; Vice set</p><button type="button" class="primary" id="play-free-xi">Save XI &amp; play</button></div>
      </div>
    </div>
  </section>

  <section class="landing-section" id="boards">
    <p class="section-kicker">Live Leaderboards</p>
    <h2>Top of the table, in real time</h2>
    <article class="card">
      <div class="lb-head">
        <div class="meta"><span class="badge badge-live">LIVE</span><span>FREE Grand League</span></div>
        <div class="quiet">Updated just now · LIVE</div>
      </div>
      <div class="leaderboard">
        <div class="lb-row top-1"><div class="rank">#1 <span class="rank-move up">▲1</span></div><div>Northvale United</div><div class="score-cell"><strong>92.0</strong><div class="score-delta">+4.5</div></div></div>
        <div class="lb-row top-2 you"><div class="rank">#2 <span class="rank-move down">▼1</span></div><div><strong>You</strong></div><div class="score-cell"><strong>88.5</strong><div class="score-delta">+2.0</div></div></div>
        <div class="lb-row top-3"><div class="rank">#3</div><div>Bay Lineup</div><div class="score-cell"><strong>84.0</strong></div></div>
      </div>
    </article>
  </section>

  <section class="landing-section" id="leagues">
    <p class="section-kicker">Private Leagues</p>
    <h2>Compete with your circle</h2>
    <p class="quiet section-lede">Create a FREE private league, share an invite code, and race the same match on one board — no entry fee, no prize pool.</p>
    <div class="how-grid how-grid-3">
      <article class="card how-card"><h3>Create</h3><p class="quiet">Name your league and set capacity.</p></article>
      <article class="card how-card"><h3>Invite</h3><p class="quiet">Copy a code or link — friends join with their XI.</p></article>
      <article class="card how-card"><h3>Compete</h3><p class="quiet">One match, one leaderboard, pure rank &amp; points.</p></article>
    </div>
  </section>

  <section class="landing-section" id="why">
    <p class="section-kicker">Why KICKR</p>
    <h2>Fantasy that feels like matchday</h2>
    <div class="why-grid">
      <article class="card"><h3>Match identity</h3><p class="quiet">Crests, kickoff, LIVE states — not generic contest tiles.</p></article>
      <article class="card"><h3>XI on the pitch</h3><p class="quiet">Formation, credits, captaincy in one focused builder.</p></article>
      <article class="card"><h3>Live movement</h3><p class="quiet">Rank deltas and score swings as the game unfolds.</p></article>
      <article class="card"><h3>FREE clarity</h3><p class="quiet">No claim prize on FREE — rank, score, share.</p></article>
    </div>
  </section>

  <section class="landing-section" id="tech">
    <p class="section-kicker">Technology</p>
    <h2>Built for judges who look under the hood</h2>
    <div class="tech-panel card">
      <ul class="tech-list">
        <li><strong>Solana escrow program</strong> — contest vaults, deposits, and claims on Devnet (paid production contests off).</li>
        <li><strong>Verifiable settlement path</strong> — attestation-gated advancement; RUN_SETTLEMENT granted to nobody in this demo.</li>
        <li><strong>FREE-first product</strong> — fictional DEMO DATA, no backend USDC custody, no India paid entry.</li>
        <li><strong>Live scoring</strong> — event → player → team → contest leaderboard with freshness signals.</li>
      </ul>
      <p class="note">This public demo uses fictional DEMO DATA. It is not Sportmonks live fixtures and does not move real money.</p>
    </div>
  </section>

  <section class="landing-section landing-final">
    <h2>Ready for kickoff?</h2>
    <p class="quiet">Play the FREE demo — build an XI and join a contest in minutes.</p>
    <div class="hero-cta">
      <button type="button" class="primary primary-lg" id="play-free-final">Play Free</button>
      <button type="button" class="ghost ghost-lg" id="signin-wallet">Connect wallet</button>
      ${opts.production && !opts.demoData ? "" : `<button type="button" class="ghost" id="signin-dev">${opts.demoData ? "Quick demo sign-in" : "Sign in (development)"}</button>`}
    </div>
    <p class="note" id="auth-note-final"></p>
  </section>

  <footer class="landing-foot">
    <span class="brand">KICKR</span>
    <span class="quiet">Fantasy football · FREE demo · ${escapeText(opts.demoData ? "DEMO DATA" : "Dev")}</span>
  </footer>
</div>`;
}
