/** Public landing page. Matchday scores below are explicitly illustrative. */
import { playerChip } from "./format.js";

const previewPlayers = [["Okafor", "Ramos", "Diallo"], ["Silva", "Park", "Nguyen"], ["Khan", "Lopez", "West", "Moreau"], ["Garcia"]];

export function landingPageHtml(opts: { demoData: boolean; production: boolean }): string {
  const pitch = previewPlayers.map((line) => `<div class="line">${line.map((name) => playerChip({ displayName: name, selected: true, role: name === "Okafor" ? "C" : name === "Park" ? "VC" : "" })).join("")}</div>`).join("");
  return `<div class="landing">
    <header class="landing-top">
      <a class="brand brand-lg" href="#/" aria-label="KICKR home"><span class="brand-symbol" aria-hidden="true">↗</span>KICKR<span class="brand-dot">.</span></a>
      <nav class="landing-nav" aria-label="Explore KICKR"><a href="#how" data-scroll="how">How it works</a><a href="#demo" data-scroll="demo">The matchday</a><a href="#leagues" data-scroll="leagues">Private leagues</a></nav>
      <button type="button" class="primary" id="play-free">Play Free <span aria-hidden="true">↗</span></button>
    </header>
    <main>
      <section class="hero" aria-labelledby="hero-heading">
        <div class="hero-copy">
          <p class="section-kicker"><span class="live-dot" aria-hidden="true"></span> YOUR MATCH. YOUR XI. YOUR MOMENT.</p>
          <h1 class="hero-title" id="hero-heading">Football.<br>With <em>you</em><br>in the game.</h1>
          <p class="hero-lede">You know the game. Now make the calls. Build your dream XI, take on your friends, and make every match count.</p>
          <div class="hero-cta"><button type="button" class="primary primary-lg" id="play-free-hero">Build your XI <span aria-hidden="true">↗</span></button><button type="button" class="text-button" id="explore-demo-hero"><span class="play-icon" aria-hidden="true">▶</span> Explore Demo</button></div>
          <p class="hero-footnote">Free to play. All the bragging rights.</p><p class="note" id="auth-note" role="status"></p>
          <div class="hero-proof"><span class="proof-number">11</span><span>players.<br><strong>Endless possibilities.</strong></span><span class="proof-divider"></span><span class="mini-ball" aria-hidden="true">✦</span><span>Your football instinct.<br><strong>Put to the test.</strong></span></div>
        </div>
        <div class="matchday-preview" id="demo">
          <div class="preview-topline"><span>THE MATCHDAY</span><span class="preview-label">ILLUSTRATIVE PREVIEW</span></div>
          <div class="preview-fixture"><div class="preview-club"><span class="club-shield">NV</span><strong>Northvale FC</strong></div><div class="preview-score"><span class="badge badge-live">LIVE · 67′</span><strong>1 <span>:</span> 1</strong><span>DEMO CUP</span></div><div class="preview-club"><span class="club-shield club-shield-away">HB</span><strong>Harbor Bay</strong></div></div>
          <div class="preview-xi-title"><span>YOUR STARTING XI</span><span>4–3–3 <span class="quiet">/</span> 88 CR</span></div>
          <div class="pitch preview-pitch">${pitch}</div>
          <div class="preview-scorebar"><div><span class="live-dot" aria-hidden="true"></span> YOUR POINTS <strong>84.5</strong></div><span class="score-gain">↗ +6.0</span><div class="preview-rank"><span>RANK</span><strong>#1</strong></div></div>
          <div class="goal-toast"><span class="goal-icon" aria-hidden="true">↗</span><div><strong>That’s your captain.</strong><span>Okafor scores · Captain points ×2</span></div><strong>+10</strong></div>
          <p class="preview-disclaimer">Fictional teams and illustrative scores. Build your own XI in the demo.</p>
        </div>
      </section>
      <div class="matchday-strip"><span>THE BEAUTIFUL GAME. <strong>YOUR WAY.</strong></span><span>BUILD <b>↗</b> COMPETE <b>↗</b> CLIMB <b>↗</b></span></div>
      <section class="landing-section" id="how" aria-labelledby="how-heading">
        <div class="section-heading"><div><p class="section-kicker">01 / THE GAME PLAN</p><h2 id="how-heading">Big football energy.<br>Four simple moves.</h2></div><p class="section-lede">From your first pick to the final whistle.<br>Here’s how it works.</p></div>
        <div class="how-grid">
          <article class="how-card"><span class="how-num">01 <span aria-hidden="true">↗</span></span><h3>Pick your match.</h3><p>Find a fixture. Read the lineup. Back your football knowledge.</p></article>
          <article class="how-card"><span class="how-num">02 <span aria-hidden="true">↗</span></span><h3>Build Your XI.</h3><p>Eleven players. One credit budget. Your captain earns double points.</p></article>
          <article class="how-card"><span class="how-num">03 <span aria-hidden="true">↗</span></span><h3>Find your rivals.</h3><p>Join a FREE contest or invite your friends to a private league.</p></article>
          <article class="how-card"><span class="how-num">04 <span aria-hidden="true">↗</span></span><h3>Own the matchday.</h3><p>Follow Live Leaderboards, watch your points climb, and share your finish.</p></article>
        </div>
      </section>
      <section class="rivalry-section" id="leagues" aria-labelledby="leagues-heading">
        <div class="rivalry-copy"><p class="section-kicker">02 / PRIVATE LEAGUES</p><h2 id="leagues-heading">Same friends.<br><em>New rivalries.</em></h2><p>The group chat has opinions. Give it a scoreboard. Create a free private league, share the invite, and settle it on the pitch.</p><button type="button" class="primary primary-lg" id="play-free-xi">Bring your squad <span aria-hidden="true">↗</span></button><span class="rivalry-note">Invite-only. Free entry. Bragging rights on the line.</span></div>
        <div class="rivalry-board"><div class="row"><span class="section-kicker">THE GROUP CHAT CUP</span><span class="preview-label">PREVIEW</span></div><h3>Let the table do the talking.</h3><div class="rival-row"><span>01</span><span class="rival-avatar">Y</span><strong>You <small>THE GAFFER</small></strong><b>92.0 <small>PTS</small></b><span class="rank-move up">↑ 2</span></div><div class="rival-row"><span>02</span><span class="rival-avatar rival-purple">S</span><strong>Sunday Legends</strong><b>88.5 <small>PTS</small></b><span class="quiet">—</span></div><div class="rival-row"><span>03</span><span class="rival-avatar rival-orange">B</span><strong>Bench Warmers</strong><b>76.0 <small>PTS</small></b><span class="rank-move down">↓ 1</span></div><div class="invite-preview"><span>YOUR LEAGUE. YOUR PEOPLE.</span><span>↗</span></div></div>
      </section>
      <section class="landing-section trust-section" id="tech"><div><p class="section-kicker">03 / THE FOUNDATION</p><h2>Know how you score.</h2><p class="section-lede">Captain multipliers. Clear points. A final result you can share.</p></div><div class="trust-copy"><h3>Built with transparency in mind.</h3><p>Our Solana escrow and verifiable settlement architecture are in development on Devnet. Today, KICKR is free to play: no entry fees and no monetary prizes.</p><p class="demo-disclosure"><span class="live-dot" aria-hidden="true"></span> ${opts.demoData ? "FREE DEMO · DEMO DATA — fictional matches and players." : "FREE TO PLAY · Explore the fantasy football experience."}</p></div></section>
      <section class="landing-final"><p class="section-kicker">THE NEXT MOVE IS YOURS</p><h2>Your XI.<br><em>Your moment.</em></h2><button type="button" class="primary primary-lg" id="play-free-final">Let’s play football <span aria-hidden="true">↗</span></button><p>Already have a wallet? <button type="button" class="text-button" id="signin-wallet">Connect wallet ↗</button></p>${opts.production && !opts.demoData ? "" : '<button type="button" class="text-button quiet" id="signin-dev">Quick demo sign-in</button>'}<p class="note" id="auth-note-final" role="status"></p></section>
    </main>
    <footer class="landing-foot"><a href="#/" class="brand">KICKR<span class="brand-dot">.</span></a><span>MADE FOR THE LOVE OF THE GAME.</span><span class="quiet">FREE fantasy football · ${opts.demoData ? "Fictional DEMO DATA" : "Development preview"}</span></footer>
  </div>`;
}
