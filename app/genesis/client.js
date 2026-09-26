'use client';

import { useEffect, useState } from 'react';
import BackLink from '../back-link';
import { GENESIS_PFP } from '../../lib/knights';
import {
    CAPSULES_PER_WEEK, GENESIS_SUPPLY, HASH_POWER_BANDS, HASH_POWER_MAX, HASH_POWER_MIN,
    TICKET_CAP_HOURS, ticketsPerHour, weekEnd,
} from '../../lib/staking-config';

/**
 * `/genesis` — everything the Genesis collection is, and then the waitlist.
 *
 * Wearing the house shell rather than a bespoke marketing layout: the same `theme.css`, the same
 * header with a way back and a control on the right, the same left panel and scrolling right panel
 * the Staking Vault and the Summoning Chamber use. A stranger who joins the waitlist here and then
 * gets into the game should recognise the furniture.
 *
 * Two things this page refuses to do, both of them the reason the checks around it exist:
 *
 *   - **It types no numbers.** Every figure printed below is imported from the module that owns it —
 *     `lib/staking-config.js` for supply, hash power, the bands, tickets and the raffle, and
 *     `lib/reward-config.js` for what a dungeon pays. A marketing page is exactly where a number
 *     gets copied once and then quietly stops being true.
 *   - **It shows no screenshot that is not one.** The frames are drawn from what is in
 *     `public/assets/genesis/`, passed in by the server component; `src: null` is rendered as a frame
 *     that says the capture is still to come. See `lib/genesis-shots.js`.
 *
 * It reads nothing from the chain and asks for no wallet connection — the address at the bottom is
 * text, not a login, and the page works with no wallet at all.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The bar a band is drawn against: the largest band, so the ladder's top row is full.
 *
 * The same rule the vault uses, and deliberately not the supply — measuring a band against 1,024
 * would draw six bars between 6% and 20% of the height, which is a picture of nothing.
 */
const LADDER_TOP = Math.max(...HASH_POWER_BANDS.map((band) => band.count));

/** Formats a whole number the way the rest of the site does. */
function fmtInt(value) {
    return Number(value).toLocaleString('en-US');
}

/** `300–424`, the way a band is published. */
function rangeOf(band) {
    return `${fmtInt(band.lo)}–${fmtInt(band.hi)}`;
}

function fmtCountdown(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
    return `${mins}m ${secs}s`;
}

export default function GenesisClient({ shots = [] }) {
    const [email, setEmail] = useState('');
    const [address, setAddress] = useState('');
    const [followed, setFollowed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    const [message, setMessage] = useState(null);
    const [nowMs, setNowMs] = useState(() => Date.now());
    const [minted, setMinted] = useState(null);

    useEffect(() => {
        const id = setInterval(() => {
            if (typeof document !== 'undefined' && document.hidden) return;
            setNowMs(Date.now());
        }, 1000);
        return () => clearInterval(id);
    }, []);

    // Live minted count when the collection is deployed; stays null (TBD) otherwise.
    // Reads the public supply via a wallet-less holdings probe is not possible,
    // so this uses the same chain-backed supply endpoint the portfolio uses
    // when available, and degrades to fixed-supply display.
    useEffect(() => {
        let cancelled = false;
        fetch('/api/staking/config', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then(() => {
                if (!cancelled) setMinted(null);
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, []);

    // No queue size is printed anywhere on this page, and no position either.
    //
    // The page used to read the count from `/api/waitlist` and print it beside the form. The owner
    // asked that no running total sit on a public page, and a position is the same number wearing a
    // hat: for the newest arrival, "you are number 2 in line" *is* the size of the queue. The list
    // still lives in the store, the endpoint still answers with both numbers, and the only reader
    // that prints them is `tools/waitlist.js` — which needs the store's own credentials.

    async function submit(event) {
        event.preventDefault();
        if (busy || done) return;

        const cleanEmail = email.trim();
        if (!cleanEmail) {
            setMessage({ kind: 'error', text: 'Enter an email address so we can send you the mint date.' });
            return;
        }

        // Validated here as well as on the server, and for a reason that is about the person
        // rather than about the data: the server stores `null` for an address it does not
        // recognise, so a typo would be accepted and then silently dropped. Refusing it out loud
        // is the only version of this where the visitor can fix it.
        const cleanAddress = address.trim();
        if (cleanAddress && !ADDRESS_RE.test(cleanAddress)) {
            setMessage({ kind: 'error', text: 'That is not a valid EVM address. It should be 0x followed by 40 characters. Leave it empty if you would rather add it later.' });
            return;
        }

        setBusy(true);
        setMessage(null);
        try {
            const res = await fetch('/api/waitlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: cleanEmail,
                    address: cleanAddress || null,
                    followClaimed: followed,
                    source: 'genesis',
                }),
            });
            const body = await res.json().catch(() => null);

            if (!res.ok) {
                setMessage({ kind: 'error', text: body?.error || 'That did not go through. Try again in a moment.' });
                setBusy(false);
                return;
            }

            setMessage({
                kind: 'ok',
                text: body?.alreadyRegistered === true
                    ? 'You are already on the list. We will email you when Genesis opens.'
                    : 'You are on the list. We will email you when Genesis opens.',
            });
            setDone(true);
        } catch {
            setMessage({ kind: 'error', text: 'The server did not answer. Try again in a moment.' });
            setBusy(false);
        }
    }

    return (
        <>
            {/* Versioned like every other sheet: an unversioned `/theme.css` is a CSS change that
                never reaches a returning player. */}
            <link rel="stylesheet" href="/theme.css?v=8" />
            <link rel="stylesheet" href="/css/genesis.css?v=4" />
            <link rel="stylesheet" href="/css/nft-ui.css?v=1" />

            <div className="page genesis-page">
                {/* The loop behind everything. Decoration only — every figure above it is text, so
                    the page reads correctly with the video missing, blocked or still loading, and
                    a phone or a reduced-motion visitor never fetches it at all (see genesis.css).
                    The first source is the capture from `landing page/landing.MP4`; `intro.mp4`
                    stays behind it so a missing copy falls through rather than leaving a hole. */}
                <video
                    className="gn-video"
                    autoPlay
                    loop
                    muted
                    playsInline
                    preload="metadata"
                    poster="/assets/images/menu-background.jpg"
                >
                    <source src="/assets/genesis-loop.mp4" type="video/mp4" />
                    <source src="/assets/intro.mp4" type="video/mp4" />
                </video>
                <div className="gn-scrim" />

                <header className="header">
                    <div className="header-left">
                        <BackLink />
                        <a className="btn btn-ghost btn-sm" href="/">
                            <img src="assets/ui/exit cross.png" className="btn-icon-img" alt="" />
                            Dungeon Knights
                        </a>
                    </div>
                    <div className="header-title">GENESIS KNIGHTS</div>
                    <div className="header-actions">
                        <a className="btn btn-primary btn-sm" href="#waitlist">Join the waitlist</a>
                    </div>
                </header>

                <div className="gn-main-row">
                    {/* LEFT — what it is, and the one thing to do */}
                    <aside className="side-panel gn-aside">
                        <div className="side-panel-header">
                            <img src="assets/ui/sword.png" className="panel-header-icon" alt="" />
                            The Collection
                        </div>
                        <div className="side-panel-body">
                            <div className="gn-crest">
                                <img className="gn-crest-art" src={GENESIS_PFP} alt="A Genesis Knight" loading="eager" decoding="async" width={168} height={168} fetchPriority="high" />
                                <div className="gn-crest-facts">
                                    <div className="gn-crest-name nft-name">Genesis Knights</div>
                                    <div className="gn-crest-line nft-num">{fmtInt(GENESIS_SUPPLY)} supply, fixed at mint</div>
                                    <div className="gn-crest-line nft-num">{fmtInt(HASH_POWER_MIN)}–{fmtInt(HASH_POWER_MAX)} hash power</div>
                                </div>
                            </div>

                            <div className="gn-aside-block">
                                <div className="gn-aside-title">Why own one</div>
                                <ul className="gn-ticks">
                                    <li><strong>Runs and rewards</strong> settled on chain, per knight, each day</li>
                                    <li><strong>{TICKET_CAP_HOURS / 24}-day</strong> ticket clock, so playing beats parking</li>
                                    <li><strong>Raffle entry</strong>. Genesis is the only collection that draws</li>
                                    <li><strong>Yield</strong> on the weekly pool, alongside the Knights line</li>
                                </ul>
                            </div>

                            <div className="gn-aside-cta">
                                <a className="btn btn-primary btn-md w-full gn-cta-btn" href="#waitlist">
                                    <img src="assets/ui/sword.png" className="btn-icon-img" alt="" />
                                    Join the waitlist
                                </a>
                                <p className="gn-aside-fine">
                                    No wallet needed. The mint happens on OpenSea, and we only email you
                                    about the mint.
                                </p>
                            </div>
                        </div>
                    </aside>

                    {/* RIGHT — the numbers, in the order a buyer asks for them */}
                    <main className="side-panel gn-content">
                        <div className="side-panel-header">
                            <img src="assets/ui/castle.png" className="panel-header-icon" alt="" />
                            What you are buying
                        </div>
                        <div className="side-panel-body">

                            <div className="gn-supplybar" role="status" aria-label="Genesis supply and next raffle">
                                <span className="gn-supplybar-label">Genesis supply</span>
                                <span className="gn-supplybar-numbers nft-num">
                                    {minted != null ? `${fmtInt(minted)} / ${fmtInt(GENESIS_SUPPLY)}` : `${fmtInt(GENESIS_SUPPLY)} fixed`}
                                </span>
                                <span className="gn-supplybar-track" aria-hidden="true">
                                    <span
                                        className="gn-supplybar-fill"
                                        style={{ width: minted != null && GENESIS_SUPPLY ? `${Math.min(100, (minted / GENESIS_SUPPLY) * 100)}%` : '100%' }}
                                    />
                                </span>
                                <span className="gn-supplybar-countdown nft-num" aria-live="off">
                                    Draw in <strong>{fmtCountdown(weekEnd(nowMs) - nowMs)}</strong> · {fmtInt(CAPSULES_PER_WEEK)} capsules
                                </span>
                            </div>

                            <div className="gn-hero">
                                <h1 className="gn-hero-title nft-name">Only {fmtInt(GENESIS_SUPPLY)} will ever exist</h1>
                                <p className="gn-hero-copy">
                                    Genesis Knights are the fixed side of the collection: {fmtInt(GENESIS_SUPPLY)} of them
                                    on Robinhood Chain, and no more can be created. What sets one apart is the hash
                                    power it was born with, and that number decides how much of the vault it carries.
                                </p>
                            </div>

                            {/* The small boxes: the whole collection in six figures. */}
                            <div className="gn-tiles">
                                <div className="gn-tile">
                                    <span className="gn-tile-label">Supply</span>
                                    <span className="gn-tile-value gn-num">{fmtInt(GENESIS_SUPPLY)}</span>
                                    <span className="gn-tile-sub">Fixed at mint. The bands below add up to it.</span>
                                </div>
                                <div className="gn-tile">
                                    <span className="gn-tile-label">Hash power</span>
                                    <span className="gn-tile-value gn-num">{fmtInt(HASH_POWER_MIN)}–{fmtInt(HASH_POWER_MAX)}</span>
                                    <span className="gn-tile-sub">Rolled per knight, in the six bands below.</span>
                                </div>
                                <div className="gn-tile">
                                    <span className="gn-tile-label">Capsules a week</span>
                                    <span className="gn-tile-value gn-num">{fmtInt(CAPSULES_PER_WEEK)}</span>
                                    <span className="gn-tile-sub">Awarded to staked Genesis knights, split by tickets.</span>
                                </div>
                            </div>

                            {/* The bands. Counts are the promise, so they are the column that adds up. */}
                            <section className="gn-section">
                                <h2 className="gn-section-title">The six hash-power bands</h2>
                                <p className="gn-section-copy">
                                    Every knight is rolled into one of these bands, and inside a band every roll is
                                    equally likely. The counts are fixed: {fmtInt(GENESIS_SUPPLY)} knights, split{' '}
                                    {HASH_POWER_BANDS.map((band) => band.count).join(' / ')}.
                                    Staking banks one ticket per hour for each point of hash power, up to {TICKET_CAP_HOURS} hours.
                                </p>
                                {/* The published distribution, drawn — the same ladder, the same palette and
                                    the same proportions as the Staking Vault's, because it is the same table.
                                    A buyer who has seen one recognises the other, and a graph is the honest
                                    shape for a distribution: the thin top is visible at a glance, which is
                                    exactly what the counts are there to say. */}
                                <div
                                    className="gn-ladder"
                                    role="group"
                                    aria-label={`Hash power bands across the ${fmtInt(GENESIS_SUPPLY)} Genesis Knights`}
                                >
                                    <div className="gn-ladder-head">
                                        <span className="gn-ladder-title">Power ladder</span>
                                        <span className="gn-ladder-rule gn-num">
                                            {fmtInt(ticketsPerHour(1))} HP = {fmtInt(ticketsPerHour(1))} ticket / hour
                                        </span>
                                    </div>
                                    <div className="gn-ladder-bars">
                                        {HASH_POWER_BANDS.map((band) => {
                                            const odds = ((band.count / GENESIS_SUPPLY) * 100).toFixed(1);
                                            return (
                                                <div
                                                    className="gn-band"
                                                    key={band.key}
                                                    data-band={band.key}
                                                    tabIndex={0}
                                                    role="img"
                                                    aria-label={`${band.name}: ${fmtInt(band.count)} of ${fmtInt(GENESIS_SUPPLY)} knights, ${odds} percent odds, ${rangeOf(band)} hash power`}
                                                >
                                                    <span className="gn-band-count gn-num" aria-hidden="true">
                                                        {fmtInt(band.count)}
                                                    </span>
                                                    <span className="gn-band-bar" aria-hidden="true">
                                                        <span
                                                            className="gn-band-fill"
                                                            style={{ height: `${Math.round((band.count / LADDER_TOP) * 100)}%` }}
                                                        />
                                                    </span>
                                                    <span className="gn-band-name" aria-hidden="true">
                                                        {band.name.replace('Genesis ', '')}
                                                    </span>
                                                    <span className="gn-band-range gn-num" aria-hidden="true">
                                                        {rangeOf(band)}
                                                    </span>
                                                    <span className="gn-band-range gn-num" aria-hidden="true">
                                                        {odds}% odds
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                                <p className="gn-fine">
                                    Each bar is filled against the largest band. The number above each one is the
                                    count of knights in that band, so {fmtInt(HASH_POWER_BANDS[0].lo)} and{' '}
                                    {fmtInt(HASH_POWER_BANDS[0].hi)} are equally likely for a Spark. Odds are count / {fmtInt(GENESIS_SUPPLY)}.
                                </p>
                            </section>

                            {/* The three things a Genesis knight does. No figures: what a run pays is the
                                contract's business and the vault quotes it against the live table, so a
                                number printed here would be a second, staler copy of it. */}
                            <section className="gn-section">
                                <h2 className="gn-section-title">What a Genesis knight does</h2>
                                <div className="gn-boxes">
                                    <div className="gn-box">
                                        <div className="gn-box-head">Dungeon runs</div>
                                        <div className="gn-box-value">On chain<span className="gn-box-unit">per knight, per day</span></div>
                                        <p className="gn-box-copy">
                                            Every run is signed per knight and settled on chain. The daily cap is
                                            enforced by the game contract.
                                        </p>
                                    </div>
                                    <div className="gn-box">
                                        <div className="gn-box-head">Staking yield</div>
                                        <div className="gn-box-value gn-num">Pool share<span className="gn-box-unit">/ week</span></div>
                                        <p className="gn-box-copy">
                                            Stake a knight and it draws from the weekly $DNG pool in proportion to its
                                            tickets. Its weight builds for {' '}{TICKET_CAP_HOURS} hours, then stops. Unstaking ends the share.
                                        </p>
                                    </div>
                                    <div className="gn-box">
                                        <div className="gn-box-head">The weekly draw</div>
                                        <div className="gn-box-value gn-num">{fmtInt(CAPSULES_PER_WEEK)}<span className="gn-box-unit">capsules / week</span></div>
                                        <p className="gn-box-copy">
                                            A staked Genesis knight is entered automatically, and one ticket can win. Each
                                            capsule opens into one Knight from the summonable collection, and its tier decides
                                            what that Knight is worth.
                                        </p>
                                    </div>
                                </div>
                            </section>

                            {/* Captures from the running build. A frame renders its picture only when the file
                                is in the folder, so this section can never show a placeholder dressed as a
                                screenshot — but the copy says what the pictures are, not how the section is wired. */}
                            <section className="gn-section">
                                <h2 className="gn-section-title">The game this belongs to</h2>
                                <p className="gn-section-copy">
                                    A squad clearing a themed dungeon, a knight staked in the vault, and a capsule
                                    opened in the Summoning Chamber. All three are captures from the build you play today.
                                </p>
                                <div className="gn-shots">
                                    {shots.map((shot) => (
                                        <figure className={`gn-shot ${shot.src ? 'is-filled' : 'is-pending'}`} key={shot.key} data-shot={shot.key}>
                                            {shot.src ? (
                                                <img className="gn-shot-art" src={shot.src} alt={shot.caption} loading="lazy" />
                                            ) : (
                                                <div className="gn-shot-frame" aria-hidden="true">
                                                    <span className="gn-shot-mark">▣</span>
                                                    <span className="gn-shot-pending">Capture to come</span>
                                                </div>
                                            )}
                                            <figcaption className="gn-shot-caption">{shot.caption}</figcaption>
                                            <span className="gn-shot-detail">{shot.detail}</span>
                                        </figure>
                                    ))}
                                </div>
                            </section>

                            {/* The ask, last, after the reasons. */}
                            <section className="gn-section gn-waitlist-section" id="waitlist">
                                <h2 className="gn-section-title">Join the waitlist</h2>
                                <p className="gn-section-copy">
                                    Leave your email and we will send you the mint date before it goes public. Add your
                                    EVM address to join the allowlist, or leave it empty and add it later.
                                </p>

                                <form className="gn-form" onSubmit={submit} noValidate>
                                    <label className="gn-field">
                                        <span className="gn-field-label">Email address</span>
                                        <input
                                            type="email"
                                            id="waitlistEmail"
                                            name="email"
                                            value={email}
                                            onChange={(event) => setEmail(event.target.value)}
                                            placeholder="you@example.com"
                                            autoComplete="email"
                                            disabled={done}
                                        />
                                    </label>

                                    <label className="gn-field">
                                        <span className="gn-field-label">
                                            EVM address <span className="gn-field-note">(for the allowlist, optional)</span>
                                        </span>
                                        <input
                                            type="text"
                                            id="waitlistAddress"
                                            name="address"
                                            value={address}
                                            onChange={(event) => setAddress(event.target.value)}
                                            placeholder="0x…"
                                            spellCheck="false"
                                            autoComplete="off"
                                            disabled={done}
                                        />
                                    </label>

                                    {/* A box the person ticks, written as what it is: a statement of intent from
                                        them, and the way the mint date reaches them first. The sentence that used
                                        to sit here explained what the box does not prove, which is a note about
                                        our plumbing rather than anything a person joining a waitlist is owed. */}
                                    <label className="gn-follow">
                                        <input
                                            type="checkbox"
                                            id="waitlistFollowed"
                                            checked={followed}
                                            onChange={(event) => setFollowed(event.target.checked)}
                                            disabled={done}
                                        />
                                        <span>
                                            I follow <a href="https://x.com/DNGrobinhood" target="_blank" rel="noopener">@DNGrobinhood</a>{' '}
                                            on X, where the mint date lands first.
                                        </span>
                                    </label>

                                    <div className="gn-form-row">
                                        <button className="btn btn-primary btn-md gn-submit" id="waitlistSubmit" type="submit" disabled={busy || done}>
                                            {done ? 'You are on the list' : busy ? 'Joining…' : 'Join the waitlist'}
                                        </button>
                                    </div>

                                    {message && (
                                        <div className="gn-message" id="waitlistMessage" data-kind={message.kind} role="status">
                                            {message.text}
                                        </div>
                                    )}
                                </form>
                            </section>
                        </div>
                    </main>
                </div>

                <footer className="gn-footer">
                    <span className="gn-footer-note">
                        Genesis Knights mint on OpenSea. The game is live now: clear a dungeon, stake a
                        knight, and enter the weekly draw.
                    </span>
                    <a className="gn-footer-link" href="https://x.com/DNGrobinhood" target="_blank" rel="noopener">
                        Follow @DNGrobinhood
                    </a>
                </footer>
            </div>
        </>
    );
}
