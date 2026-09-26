'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Script from 'next/script';
import BackLink from '../back-link';
import {
    connectWallet, fetchMe, forgetWallet, onAccountsChanged, readSession, savedAddress, shortAddress,
    walletCapabilities,
} from '../../lib/points-client';
import { describeEarn } from '../../lib/points-history';
import {
    CAPSULE_FLING, CAPSULE_SPIN, capsuleFling, capsuleSpinFrame,
} from '../../lib/points-config';
import { GENESIS_PFP, RARITY, knightPfp } from '../../lib/knights';
import { bandFor } from '../../lib/staking-config';
import { DEFAULT_CHAIN } from '../../lib/privy-chains';
import NftCard from '../nft-card';

/**
 * My Portfolio — one wallet, read from the chain, in four sections.
 *
 * WHY THIS PAGE EXISTS
 * --------------------
 * The answer to "what do I actually own?" was spread across four screens: DNG in the header pill
 * of whichever page you were on, knights in the Hall, Genesis and staking reward on the vault, and
 * points on the Points page — and none of them could tell you the total. The header's wallet menu
 * links here for that reason.
 *
 * WHAT IT READS, AND WHAT IT REFUSES TO
 * -------------------------------------
 * Every number on this page comes from a source that already exists and is already honest:
 *
 *   `/api/staking/holdings?collection=knights`  the knights you own, and what you have staked
 *   `/api/staking/holdings?collection=genesis`  the same, plus the collection's published supply
 *   `/api/wallet/balance`                       how much $DNG the wallet holds
 *   `/api/points/me`                            points, rank, today's entries, referrals
 *   `/api/game/history?address=`                what you have been paid, and when
 *
 * All five are server reads, and that is deliberate: the browser contributes the wallet's
 * *address* and nothing else. The first version asked the wallet's own provider for the balance —
 * one `eth_call`, the obvious thing — and produced a page whose four other sections showed real
 * chain data while its headline said "the wallet is not available in this browser", which is the
 * normal state of a browser with a saved address and no extension. The page therefore loads no
 * chain library at all.
 *
 * There is no second implementation of any of it, and no arithmetic that invents a number: the
 * lifetime total is the chain's events, the balance is `balanceOf`, and the pool share is the
 * pool's own view. Which is why each section fails on its own. A node that is down must not turn
 * "you own 47 knights" into "you own none", so a failed read says it failed and the rest of the
 * page stays up.
 *
 * It is read-only on purpose. Every section ends by linking to the page that owns its action —
 * claiming, staking and summoning all involve transactions, and one write path is enough to audit.
 */

const ASSETS = '/assets/points/';
const RARITY_ORDER = ['legendary', 'epic', 'rare', 'uncommon', 'common'];

/* ------------------------------------------------------------- the capsule's throw
 *
 * The turn is dragged by the pointer, and a drag that stops dead on release is a picture that has
 * been *placed* rather than one that has been *spun* — the whole thing is a wheel, and a wheel that
 * does not carry on has no weight. So a release hands its momentum to a decaying animation: the
 * frame position keeps advancing at the speed the hand was moving, slowing by a fixed fraction per
 * millisecond until it is at rest, and a new grab catches it mid-throw.
 *
 * **The numbers that decide how that feels are not in this file.** `CAPSULE_FLING` and
 * `capsuleFling` live in `lib/points-config.js`, beside the frames they act on, so that the coast is
 * a value `tools/check-portfolio.js` can *walk* — a release speed in, a duration and a distance out
 * — rather than four constants a harness can only match as text. What is left here is the browser
 * half of the throw: the pointer, the animation frame, and reduced motion.
 *
 * How long it lasts is the owner's decision and it is deliberately long. The first version settled
 * in about two seconds, which measured as a throw and read as a nudge; a normal flick now spends
 * close to six seconds getting there, and the hardest flick allowed is capped at about seven. The
 * curve in `points-config` is where those two figures are derived rather than typed.
 */

/** Ten pixels a frame: the picture is roughly one full turn wide, so the gesture and the object
    travel at the same speed under the thumb. */
const PX_PER_FRAME = 10;

const fmtInt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US') : '—');
const fmtDng = (n) => {
    const value = Number(n);
    if (!Number.isFinite(value)) return '—';
    return value.toLocaleString('en-US', { maximumFractionDigits: value < 100 ? 2 : 0 });
};

const shortWhen = (value) => {
    const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
    if (!Number.isFinite(ms)) return '—';
    const minutes = Math.round((Date.now() - ms) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
    return `${Math.round(minutes / 1440)}d ago`;
};

/** The empty read: `phase` is what the section renders from, `data` is what it shows. */
const blank = { phase: 'idle', data: null, error: null };

async function readJson(url, options) {
    const res = await fetch(url, { cache: 'no-store', ...(options || {}) });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || body?.reason || `Request failed (${res.status})`);
    return body;
}

export default function PortfolioClient() {
    const [address, setAddress] = useState(null);
    const [busy, setBusy] = useState(null);
    const [readAt, setReadAt] = useState(null);

    const [dng, setDng] = useState({ phase: 'idle', value: null, symbol: 'DNG', error: null });
    const [knights, setKnights] = useState(blank);
    const [genesis, setGenesis] = useState(blank);
    const [points, setPoints] = useState(blank);
    const [history, setHistory] = useState(blank);

    const walletPill = useRef(null);
    const handleDisconnectRef = useRef(() => {});

    // ------------------------------------------------------------------ the wallet
    //
    // The saved address is instant, but it is not the whole answer — and for the players this page
    // was opened up for it is not the answer at all. Someone who signs in with an email address on
    // the Points page has a wallet in the *seam* and nothing in localStorage, so reading the saved
    // key alone showed them "Connect a wallet" on a page about the wallet they were already using.
    //
    // So: the seam first (it is the authority everywhere else, and its own rule refuses to hand back
    // a wallet that would move the player off one they already use), the saved key second, and both
    // `privyAuthChanged` and `privyBridgeReady` re-ask — a sign-in that lands while this page is
    // open arrives through one of them.
    useEffect(() => {
        let alive = true;

        const read = async () => {
            try {
                const caps = await walletCapabilities();
                if (!alive) return;
                const who = caps?.address || savedAddress() || null;
                if (who) setAddress(who);
            } catch {
                // A wallet source that cannot answer is the saved key's problem to cover.
                if (alive) setAddress(savedAddress());
            }
        };

        setAddress(savedAddress());
        read();
        window.addEventListener('privyAuthChanged', read);
        window.addEventListener('privyBridgeReady', read);
        const offAccounts = onAccountsChanged((next) => setAddress(next));

        return () => {
            alive = false;
            window.removeEventListener('privyAuthChanged', read);
            window.removeEventListener('privyBridgeReady', read);
            offAccounts();
        };
    }, []);

    const load = useCallback(async (who) => {
        if (!who) return;
        setBusy('loading');
        setReadAt(null);

        const holdings = (collection) => readJson(
            `/api/staking/holdings?address=${encodeURIComponent(who)}&collection=${collection}`,
        );

        // Every section settles on its own, so one failure cannot blank the page. `Promise.allSettled`
        // is the point here rather than a convenience: the five reads are independent facts about one
        // wallet, and the page should show the four that worked.
        const [knightsRead, genesisRead, balanceRead, historyRead] = await Promise.allSettled([
            holdings('knights'),
            holdings('genesis'),
            readJson(`/api/wallet/balance?address=${encodeURIComponent(who)}`),
            readJson(`/api/game/history?address=${encodeURIComponent(who)}`),
        ]);

        const settle = (result, setter) => {
            if (result.status === 'rejected') {
                setter({ phase: 'error', data: null, error: result.reason?.message || 'The read failed.' });
                return null;
            }
            const body = result.value;
            if (body?.ok === false) {
                setter({ phase: 'error', data: null, error: body.reason || 'The chain could not be read just now.' });
                return null;
            }
            setter({ phase: 'ready', data: body, error: null });
            return body;
        };

        const knightBody = settle(knightsRead, setKnights);
        settle(genesisRead, setGenesis);
        settle(historyRead, setHistory);

        // The balance reports its own failure, like every other section.
        if (balanceRead.status === 'rejected' || balanceRead.value?.ok !== true) {
            setDng({
                phase: 'error',
                value: null,
                symbol: 'DNG',
                error: balanceRead.status === 'rejected'
                    ? (balanceRead.reason?.message || 'The balance could not be read.')
                    : (balanceRead.value?.reason || 'The balance could not be read.'),
            });
        } else {
            setDng({ phase: 'ready', value: balanceRead.value.amount, symbol: balanceRead.value.symbol, error: null });
        }

        // Points are a server session, not a wallet: a player who has never signed into the Points
        // Program is not an error, and the section says which of the two it is. `fetchMe` is the
        // shared helper, so a 401 here means exactly what it means on the Points page.
        //
        // The session's address is checked against the wallet on screen, and that guard is the
        // point of this branch rather than a nicety. A session is 30 days long and a wallet can
        // change in that time — connect a second wallet, or open this page after switching in the
        // extension — and `/api/points/me` answers for whoever *signed*, not for whoever is
        // connected now. Without this, one wallet's points would be printed under another wallet's
        // knights, which is the same lie the holdings route goes out of its way to refuse.
        const session = readSession();
        if (!session) {
            setPoints({ phase: 'anon', data: null, error: null });
        } else if (String(session.address).toLowerCase() !== String(who).toLowerCase()) {
            setPoints({ phase: 'other', data: null, error: null, sessionAddress: session.address });
        } else {
            try {
                setPoints({ phase: 'ready', data: await fetchMe(), error: null });
            } catch (error) {
                const notSignedIn = error?.status === 401;
                setPoints({ phase: notSignedIn ? 'anon' : 'error', data: null, error: notSignedIn ? null : error.message });
            }
        }

        void knightBody;
        setReadAt(new Date());
        setBusy(null);
    }, []);

    useEffect(() => {
        if (address) load(address);
    }, [address, load]);

    const handleDisconnect = () => {
        forgetWallet();
        setAddress(null);
        setDng({ phase: 'idle', value: null, symbol: 'DNG', error: null });
        setKnights(blank);
        setGenesis(blank);
        setPoints(blank);
        setHistory(blank);
        setReadAt(null);
        if (window.Arya?.hide) window.Arya.hide();
    };
    handleDisconnectRef.current = handleDisconnect;

    const handleConnect = async () => {
        setBusy('connect');
        try {
            // Null means nothing was connected — the Privy login was closed, or it is still
            // open. A sign-in that lands later arrives through the bridge, so there is
            // nothing to report here.
            const who = await connectWallet();
            if (who) setAddress(who);
        } catch {
            // The menu shows the reason for a failed connect; here the page has room to say it too.
            setBusy(null);
        } finally {
            setBusy(null);
        }
    };

    // The header's wallet menu, attached to the pill this route renders.
    useEffect(() => {
        const pill = walletPill.current;
        if (!pill) return undefined;
        let cancelled = false;
        const attach = () => {
            if (cancelled || !window.WalletMenu) return false;
            window.WalletMenu.attach(pill, { onDisconnect: handleDisconnectRef.current });
            return true;
        };
        if (!attach()) {
            let tries = 0;
            const timer = setInterval(() => {
                if (attach() || tries++ > 40) clearInterval(timer);
            }, 100);
            return () => { cancelled = true; clearInterval(timer); };
        }
        return () => { cancelled = true; };
    }, []);

    // ------------------------------------------------------------------- what it shows
    // The chain label comes from the same definition the provider and the add-chain request use,
    // so a deployment that moves to mainnet moves this line with it.
    const chain = readAt ? DEFAULT_CHAIN.name : null;
    const knightList = knights.data?.knights || [];
    const genesisList = genesis.data?.knights || [];
    const stake = genesis.data?.stake || null;

    const byTier = RARITY_ORDER.reduce((acc, tier) => {
        acc[tier] = knightList.filter((k) => k.rarity === tier).length;
        return acc;
    }, {});

    const ownedHashPower = genesisList.reduce((sum, k) => sum + (Number(k.hashPower) || 0), 0);
    const stakedCount = {
        knights: knights.data?.stake?.staked?.length || 0,
        genesis: genesis.data?.stake?.staked?.length || 0,
    };
    const claimable = (side) => side?.stake?.claim?.payable ?? side?.stake?.claim?.settled ?? null;
    const claimableTotal = [knights.data, genesis.data]
        .map((side) => claimable(side))
        .filter((value) => typeof value === 'number')
        .reduce((sum, value) => sum + value, 0);

    const supply = genesis.data?.supply || null;

    // The points log, newest first as the server hands it over. `recentTotal` counts what is held
    // rather than what was shown, so the header cannot claim twelve events when there are forty.
    const recentLog = points.phase === 'ready' ? points.data?.recent || [] : [];
    const recentTotal = points.phase === 'ready'
        ? (points.data?.recentTotal ?? recentLog.length)
        : 0;

    // The capsules this wallet has won, newest first, taken straight off the same state the Points
    // page renders. One source, so the count on this page and the ledger on that one cannot
    // disagree — and nothing here re-derives a status the server already worked out.
    const capsules = points.phase === 'ready' ? (points.data?.giveaway?.capsules || []) : [];
    const capsuleCount = capsules.length;
    const countOf = (status) => capsules.filter((row) => row.status === status).length;
    const capsuleTally = {
        toClaim: countOf('won'),
        claimed: countOf('claimed'),
        sent: countOf('sent'),
        missed: countOf('missed'),
    };

    // ------------------------------------------------------------------------ render
    const pageStyles = (
        <>
            <link rel="stylesheet" href="/theme.css?v=8" />
            <link rel="stylesheet" href="/css/portfolio.css?v=5" />
            <link rel="stylesheet" href="/css/nft-ui.css?v=1" />
            {/* No ethers: every figure on this page is read by the server, so the page itself never
                calls the chain. `wallet-source.js` is still here for the wallet's own session and
                the menu, which is what connects and disconnects. */}
            <Script src="/wallet-source.js?v=3" strategy="afterInteractive" />
            <Script src="/wallet-menu.js?v=1" strategy="afterInteractive" />
        </>
    );

    if (!address) {
        return (
            <>
                {pageStyles}
                <div className="page portfolio-page">
                    <Header pillRef={walletPill} address={null} onDisconnect={handleDisconnect} balance={null} />
                    <main className="pf-main">
                        <section className="pf-empty">
                            {/* The 2K chest is 1.9 MB and this box is 96px, so it is served as a
                                192px WebP generated from it — same picture, 11 KB, alpha kept. */}
                            <img src="/assets/hall/portfolio-chest.webp" alt="" className="pf-empty-art" width={96} height={82} />
                            <h1 className="pf-empty-title">Your Portfolio</h1>
                            <p className="pf-empty-text">
                                Connect a wallet and this page reads it: your $DNG balance, every knight you own
                                on both collections, what is staked and what you have been paid, your Genesis
                                hash power and your Points Program standing. Nothing here is stored about you —
                                it is read from the chain and the game&rsquo;s API each time you open it.
                            </p>
                            <button className="btn btn-primary btn-md" onClick={handleConnect} disabled={busy === 'connect'}>
                                <img src="/assets/ui/sword.png" className="btn-icon-img" alt="" />
                                {busy === 'connect' ? 'Connecting…' : 'Connect Wallet'}
                            </button>
                        </section>
                    </main>
                </div>
            </>
        );
    }

    return (
        <>
            {pageStyles}
            <div className="page portfolio-page">
                <Header
                    pillRef={walletPill}
                    address={address}
                    onDisconnect={handleDisconnect}
                    balance={dng.phase === 'ready' ? `${fmtDng(dng.value)} ${dng.symbol || 'DNG'}` : null}
                />

                <main className="pf-main">
                    {/* Identity strip — whose wallet this is, on which chain, and when it was read. */}
                    <section className="pf-identity">
                        <div className="pf-identity-who">
                            <span className="pf-address" title={address}>{shortAddress(address)}</span>
                            <button
                                type="button"
                                className="pf-copy"
                                onClick={() => navigator.clipboard?.writeText(address)}
                                title="Copy the full address"
                            >
                                Copy
                            </button>
                        </div>
                        {/* The chain, the read time and the refresh control are developer furniture:
                            they name a testnet and a timestamp to a player who came here for their
                            points. Blurred and inert rather than deleted, so the page does not
                            change shape when the mainnet names replace them. */}
                        <div className="pf-identity-meta pf-blur" aria-hidden="true">
                            <span>{chain}</span>
                            <span className="pf-dot-sep">·</span>
                            <span>{readAt ? `read ${readAt.toLocaleTimeString()}` : busy === 'loading' ? 'reading…' : 'not read yet'}</span>
                            <button type="button" className="pf-refresh" onClick={() => load(address)} disabled={busy === 'loading'}>
                                {busy === 'loading' ? 'Reading…' : 'Refresh'}
                            </button>
                        </div>
                    </section>

                    <div className="pf-grid">
                        {/* -------------------------------------------------- $DNG */}
                        {/* Blurred with a label, rather than hidden: the panel is real and its numbers
                            are real, they are just not live yet, and a player should be able to see
                            what is coming rather than an empty box. `aria-hidden` on the body means a
                            screen reader is told the same thing the eye is — the notice, not figures
                            nobody is meant to read yet. */}
                        <section className="pf-card pf-soon">
                            <h2 className="pf-card-title">
                                <img src="/assets/ui/shield.png" alt="" className="pf-card-icon" /> $DNG
                                <span className="pf-soon-chip">Coming soon</span>
                            </h2>
                            <div className="pf-soon-body" aria-hidden="true">
                            <div className="pf-hero">
                                <span className="pf-hero-value">
                                    {dng.phase === 'ready' ? fmtDng(dng.value) : '—'}
                                </span>
                                <span className="pf-hero-label">{dng.symbol || 'DNG'} in this wallet</span>
                            </div>
                            {dng.phase === 'error' && <p className="pf-warn">{dng.error}</p>}

                            <dl className="pf-rows">
                                <Row label="Staked knights" value={knights.phase === 'ready' ? fmtInt(stakedCount.knights) : '—'} />
                                <Row label="Staked Genesis" value={genesis.phase === 'ready' ? fmtInt(stakedCount.genesis) : '—'} />
                                <Row
                                    label="Claimable now"
                                    value={knights.phase === 'ready' || genesis.phase === 'ready'
                                        ? `${fmtDng(claimableTotal)} DNG`
                                        : '—'}
                                    hint="from both staking pools"
                                    live
                                />
                                <Row
                                    label="Lifetime claimed"
                                    value={history.phase === 'ready' ? `${fmtDng(history.data?.totals?.claimed)} DNG` : history.phase === 'error' ? 'unreadable' : '—'}
                                    hint={history.phase === 'ready' ? `${fmtInt(history.data?.totals?.claims)} claim(s) · ${fmtInt(history.data?.totals?.runs)} run(s)` : null}
                                    live
                                />
                            </dl>
                            {history.phase === 'error' && <p className="pf-warn">{history.error}</p>}
                            <div className="pf-actions">
                                <a className="pf-link" href="/staking">Open the Staking Vault</a>
                                <a className="pf-link" href="/game">Enter a dungeon</a>
                            </div>
                            </div>
                            <p className="pf-soon-note">
                                Your $DNG balance, what is staked and what is claimable will read here when
                                this panel opens.
                            </p>
                        </section>

                        {/* ---------------------------------------------- Knights */}
                        <section className="pf-card">
                            <h2 className="pf-card-title">
                                <img src="/assets/ui/sword.png" alt="" className="pf-card-icon" /> Knights
                                <span className="pf-card-count">{knights.phase === 'ready' ? fmtInt(knights.data?.balance) : '—'}</span>
                            </h2>
                            {knights.phase === 'error' ? (
                                <p className="pf-warn">{knights.error}</p>
                            ) : (
                                <>
                                    <div className="nft-tier-grid" role="list" aria-label="Knights by rarity tier">
                                        {RARITY_ORDER.map((tier) => {
                                            const meta = RARITY[tier.toUpperCase()];
                                            return (
                                                <div className={`nft-tier nft-rarity-${tier}`} role="listitem" key={tier}>
                                                    <img
                                                        src={knightPfp(tier)}
                                                        alt={`${meta.name} knight portrait`}
                                                        className="nft-tier-art"
                                                        loading="lazy"
                                                        decoding="async"
                                                        width={128}
                                                        height={128}
                                                    />
                                                    <span className="nft-tier-name" style={{ color: meta.color }}>
                                                        {meta.name}
                                                    </span>
                                                    <span className="nft-tier-count nft-num">{fmtInt(byTier[tier])}</span>
                                                    <span className="nft-tier-odds nft-num">
                                                        {meta.hashPower} HP · {Math.round(meta.dropRate * 100)}% roll
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                    {knightList.length > 0 && (
                                        <div className="nft-grid" aria-label="Your top knights">
                                            {[...knightList]
                                                .sort((a, b) => (b.hashPower || 0) - (a.hashPower || 0))
                                                .slice(0, 6)
                                                .map((k) => {
                                                    const meta = RARITY[String(k.rarity || '').toUpperCase()];
                                                    return (
                                                        <NftCard
                                                            key={k.tokenId}
                                                            art={knightPfp(k.rarity)}
                                                            badge={meta?.name}
                                                            title={k.name || `Knight #${k.tokenId}`}
                                                            tokenId={k.tokenId}
                                                            hp={k.hashPower ?? meta?.hashPower}
                                                            hpMin={15}
                                                            hpMax={100}
                                                            rarity={k.rarity}
                                                            metaTop={meta ? `${meta.dungeonReward} DNG / run · ${meta.dailyRuns} runs` : null}
                                                            metaBottom={meta ? `${Math.round(meta.dropRate * 100)}% drop` : null}
                                                        />
                                                    );
                                                })}
                                        </div>
                                    )}
                                    {knights.phase === 'ready' && knightList.length === 0 && (
                                        <div className="nft-empty">
                                            <span className="nft-empty-title">No Knights yet</span>
                                            <p className="nft-empty-text">
                                                Summon your first squad to clear dungeons and earn $DNG. Five tiers from Common to Legendary — every roll is on chain.
                                            </p>
                                            <div className="nft-empty-cta">
                                                <a className="pf-link" href="/mint">Summon a Knight</a>
                                                <a className="pf-link" href="/genesis">See Genesis (1,024 cap)</a>
                                            </div>
                                        </div>
                                    )}
                                    {knights.data && !knights.data.complete && (
                                        <p className="pf-note">{knights.data.note}</p>
                                    )}
                                </>
                            )}
                            {/* Blurred with the rest of the gated half: both of these lead into the
                                game, which on the public host is behind the password. A button that
                                bounces a stranger to a password screen is worse than one that is
                                visibly not for them yet. */}
                            <div className="pf-actions pf-blur" aria-hidden="true">
                                <a className="pf-link" href="/mint">Summoning Chamber</a>
                                <a className="pf-link" href="/menu">Knight&rsquo;s Hall</a>
                            </div>
                        </section>

                        {/* ---------------------------------------------- Genesis */}
                        <section className="pf-card pf-soon">
                            <h2 className="pf-card-title">
                                <img src={GENESIS_PFP} alt="" className="pf-card-icon pf-card-icon-round" /> Genesis
                                <span className="pf-card-count">{genesis.phase === 'ready' ? fmtInt(genesis.data?.balance) : '—'}</span>
                                <span className="pf-soon-chip">Coming soon</span>
                            </h2>
                            <div className="pf-soon-body" aria-hidden="true">
                            {genesis.phase === 'error' ? (
                                <p className="pf-warn">{genesis.error}</p>
                            ) : (
                                <>
                                    <dl className="pf-rows">
                                        <Row
                                            label="Hash power owned"
                                            value={genesisList.length ? fmtInt(ownedHashPower) : genesis.phase === 'ready' ? '0' : '—'}
                                            hint={genesisList.length ? 'summed from the collection' : null}
                                        />
                                        <Row
                                            label="Tickets this week"
                                            value={stake?.tickets?.mine != null ? fmtInt(stake.tickets.mine) : stake ? '—' : '—'}
                                            hint={stake?.tickets?.poolTotal != null ? `pool total ${fmtInt(stake.tickets.poolTotal)}` : null}
                                        />
                                        <Row label="Stakers in the pool" value={stake?.tickets?.stakerCount != null ? fmtInt(stake.tickets.stakerCount) : '—'} />
                                    </dl>
                                    {stake?.tickets?.poolReason && <p className="pf-note">{stake.tickets.poolReason}</p>}
                                </>
                            )}
                            {supply?.ok && (
                                <div className="pf-supply">
                                    <div className="pf-supply-head">
                                        <span className="pf-supply-label">Supply minted</span>
                                        <span className="pf-supply-numbers">{fmtInt(supply.minted)} / {fmtInt(supply.max)}</span>
                                    </div>
                                    <div className="pf-supply-track">
                                        <div className="pf-supply-fill" style={{ width: `${supply.max ? (supply.minted / supply.max) * 100 : 0}%` }} />
                                    </div>
                                    {/* The contract's own band table, not a second copy of it: the
                                        names, the ranges and the counts all come back from the
                                        collection, so this list cannot disagree with what minted. */}
                                    <ul className="pf-bands">
                                        {(supply.bands || []).map((band) => (
                                            <li key={band.name}>
                                                <span className="pf-band-name">{band.name}</span>
                                                <span className="pf-band-range">{band.lo}–{band.hi} hp</span>
                                                <span className="pf-band-left">{fmtInt(band.remaining)} left</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {genesis.phase === 'ready' && genesisList.length > 0 && (
                                <div className="nft-grid" aria-label="Your Genesis knights">
                                    {[...genesisList]
                                        .sort((a, b) => (b.hashPower || 0) - (a.hashPower || 0))
                                        .slice(0, 4)
                                        .map((k) => {
                                            const band = bandFor(k.hashPower);
                                            return (
                                                <NftCard
                                                    key={k.tokenId}
                                                    art={GENESIS_PFP}
                                                    badge={band ? band.name : 'Genesis'}
                                                    title={k.name || `Genesis #${k.tokenId}`}
                                                    tokenId={k.tokenId}
                                                    hp={k.hashPower}
                                                    hpMin={300}
                                                    hpMax={1000}
                                                    rarity={null}
                                                    isGenesis
                                                    metaTop={band ? `${band.lo}–${band.hi} HP band` : 'Genesis collection'}
                                                    metaBottom={k.hashPower != null ? `${k.hashPower} tickets / hour` : null}
                                                />
                                            );
                                        })}
                                </div>
                            )}
                            {genesis.phase === 'ready' && !genesisList.length && !stake?.staked?.length && (
                                <div className="nft-empty">
                                    <span className="nft-empty-title">No Genesis — 1,024 ever</span>
                                    <p className="nft-empty-text">
                                        Genesis Knights are the fixed-supply collection with 300–1,000 hash power, weekly $DNG yield and the only raffle entry.
                                        {supply?.ok ? ` ${fmtInt(supply.minted)} of ${fmtInt(supply.max)} minted.` : ' Mint happens on OpenSea, not here.'}
                                    </p>
                                    <div className="nft-empty-cta">
                                        <a className="pf-link" href="/genesis">View collection + odds</a>
                                        <a className="pf-link" href="/staking">Open the vault</a>
                                    </div>
                                </div>
                            )}
                            <div className="pf-actions">
                                <a className="pf-link" href="/staking">Genesis in the vault</a>
                            </div>
                            </div>
                            <p className="pf-soon-note">
                                Genesis hash power, this week&rsquo;s raffle tickets and the pool will read here
                                when this panel opens.
                            </p>
                        </section>

                        {/* ----------------------------------------------- Points */}
                        <section className="pf-card">
                            <h2 className="pf-card-title">
                                <img src={`${ASSETS}Gold_coin_badge_with_PTS_2K_20260919011438-autocrop-hair.png`} alt="" className="pf-card-icon" /> Points
                            </h2>
                            {points.phase === 'anon' && (
                                <>
                                    <p className="pf-note">
                                        Not signed in to the Points Program for this browser. Points are tied to a
                                        wallet rather than a browser, so signing in once makes them appear here.
                                    </p>
                                    <div className="pf-actions">
                                        <a className="pf-link" href="/points">Open the Points Program</a>
                                    </div>
                                </>
                            )}
                            {points.phase === 'other' && (
                                <>
                                    <p className="pf-note">
                                        This browser is signed in to the Points Program as a different
                                        wallet ({shortAddress(points.sessionAddress)}), so its points are not
                                        shown here. Sign in again from the Points page with this wallet to have
                                        them appear.
                                    </p>
                                    <div className="pf-actions">
                                        <a className="pf-link" href="/points">Open the Points Program</a>
                                    </div>
                                </>
                            )}
                            {points.phase === 'error' && <p className="pf-warn">{points.error}</p>}
                            {points.phase === 'ready' && points.data && (
                                <>
                                    <div className="pf-hero">
                                        <span className="pf-hero-value">{fmtInt(points.data.points)}</span>
                                        <span className="pf-hero-label">
                                            points
                                            {points.data.rank ? ` · rank #${fmtInt(points.data.rank)}` : ''}
                                        </span>
                                    </div>
                                    <dl className="pf-rows">
                                        <Row
                                            label="Vault entries today"
                                            value={`${(points.data.clearedToday || []).length} / 3`}
                                            hint={points.data.entryComplete ? 'cleared' : `${points.data.entryTotalToday ?? 0} so far`}
                                        />
                                        <Row label="Lifetime entries" value={fmtInt(points.data.entries)} />
                                        <Row
                                            label="Referrals"
                                            value={fmtInt((points.data.referrals || []).length)}
                                            hint={`${fmtInt(points.data.referralEarned)} points earned`}
                                        />
                                    </dl>
                                    <div className="pf-actions">
                                        <a className="pf-link" href="/points">Open the Points Program</a>
                                    </div>
                                </>
                            )}
                        </section>

                        {/* ------------------------------------------ My capsules */}
                        {/*
                            The one prize on this site nobody has to buy. It is also the only
                            section here that is not a chain read: a win is recorded on the wallet
                            by the daily draw, so this is the same ledger the Points page shows —
                            counted, and with the thing itself drawn above it.

                            The picture is why the section exists. A capsule is a closed box with
                            something glowing inside, which is exactly what a number cannot say,
                            so the art turns in the round under the reader's thumb — see
                            `CapsuleSpin` — and the number below it says how many are theirs.

                            Read-only, like everything on this page: claiming a win is a
                            signature, and that path belongs to the Points Program where the
                            window and the form are explained.
                        */}
                        <section className="pf-card pf-capsules">
                            <h2 className="pf-card-title">
                                <img src={`${ASSETS}capsule-panel.png`} alt="" className="pf-card-icon" /> My capsules
                            </h2>

                            <CapsuleSpin />

                            {points.phase === 'ready' ? (
                                <>
                                    <div className="pf-hero pf-capsule-count">
                                        <span className="pf-hero-value">{fmtInt(capsuleCount)}</span>
                                        <span className="pf-hero-label">
                                            {capsuleCount === 1 ? 'capsule won' : 'capsules won'}
                                            {capsules[0] ? ` · last ${capsules[0].when}` : ''}
                                        </span>
                                    </div>
                                    {capsuleCount > 0 && (
                                        <dl className="pf-rows">
                                            {capsuleTally.toClaim > 0 && (
                                                <Row
                                                    label="To claim"
                                                    value={fmtInt(capsuleTally.toClaim)}
                                                    hint="by 00:00 UTC"
                                                />
                                            )}
                                            {capsuleTally.claimed > 0 && (
                                                <Row label="Claimed, being sent" value={fmtInt(capsuleTally.claimed)} />
                                            )}
                                            {capsuleTally.sent > 0 && <Row label="Sent" value={fmtInt(capsuleTally.sent)} />}
                                            {capsuleTally.missed > 0 && (
                                                <Row
                                                    label="Not claimed in time"
                                                    value={fmtInt(capsuleTally.missed)}
                                                    hint="still on our list"
                                                />
                                            )}
                                        </dl>
                                    )}
                                    <p className="pf-note">
                                        Ten are drawn every day, to the ten wallets topping that UTC day's
                                        board. A win has to be claimed on the day it is drawn.
                                        {capsuleTally.toClaim > 0
                                            ? ' Yours is in the Points Program — claim it there.'
                                            : ' Finish a full run to be in the next one.'}
                                    </p>
                                    <div className="pf-actions">
                                        <a className="pf-link" href="/points">
                                            {capsuleTally.toClaim > 0 ? 'Claim your capsule' : 'Open the Points Program'}
                                        </a>
                                    </div>
                                </>
                            ) : (
                                <p className="pf-note">
                                    {points.phase === 'anon'
                                        ? 'Capsules are part of the Points Program, which is a wallet rather than a browser: sign in there once, and every capsule you win appears here.'
                                        : points.phase === 'other'
                                            ? `Capsules belong to the wallet signed in on the Points Program (${shortAddress(points.sessionAddress)}), so they are not counted under this one.`
                                            : 'Reading your capsules…'}
                                </p>
                            )}
                        </section>

                        {/* --------------------------------------------- Activity */}
                        {/* Points, not dungeon runs. What this panel used to list — runs and their $DNG
                            claims — happens in the vault and in the game, both of which are behind the
                            password on this host; a public page that reads it is a page whose main
                            panel is empty for everybody who is not signed in on the other host.
                            Points activity is what a Points player came here for, and it comes from
                            the server's own log of what it paid, so a row and the balance above it
                            are the same events. */}
                        <section className="pf-card pf-card-wide">
                            <h2 className="pf-card-title">
                                <img src="/assets/ui/castle.png" alt="" className="pf-card-icon" /> Recent activity
                                {recentTotal > 0 && (
                                    <span className="pf-card-count">{fmtInt(recentTotal)} events</span>
                                )}
                            </h2>
                            {points.phase === 'error' && <p className="pf-warn">{points.error}</p>}
                            {points.phase === 'other' && (
                                <p className="pf-note">
                                    Points activity belongs to the wallet this browser is signed in with
                                    ({shortAddress(points.sessionAddress)}), so it is not shown under this one.
                                </p>
                            )}
                            {points.phase === 'anon' && (
                                <p className="pf-note">
                                    Sign in on the Points Program, and every point you earn is listed here.
                                </p>
                            )}
                            {points.phase === 'ready' && (recentLog.length === 0 ? (
                                <p className="pf-note">
                                    {points.data?.points > 0
                                        ? 'Nothing logged yet — history starts with your next points. What was earned before this panel existed is not itemised.'
                                        : 'No points yet. Clear a vault entry on the Points Program and it appears here.'}
                                </p>
                            ) : (
                                <ul className="pf-activity pf-activity-points">
                                    {recentLog.map((entry) => (
                                        <li key={`${entry.at}-${entry.reason}`}>
                                            <span className="pf-act-when">{shortWhen(entry.at)}</span>
                                            <span className="pf-act-what">{describeEarn(entry.reason)}</span>
                                            {/* Signed, not assumed: the log carries the spend
                                                as a negative row, and `+{-1000}` would read as a
                                                typo rather than as a redemption. */}
                                            <span className={`pf-act-reward${entry.points < 0 ? ' is-spend' : ''}`}>
                                                {entry.points < 0 ? '\u2212' : '+'}{fmtInt(Math.abs(entry.points))} PTS
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            ))}
                            {points.phase !== 'ready' && points.phase !== 'error' && points.phase !== 'anon'
                                && points.phase !== 'other' && <p className="pf-note">Reading your points…</p>}
                        </section>
                    </div>

                    <p className="pf-footnote">
                        Every figure on this page is read from Robinhood Chain and the game&rsquo;s own API each
                        time it loads. Nothing is cached against your wallet, and nothing here can move a token.
                    </p>
                </main>
            </div>
        </>
    );
}

/**
 * The header the rest of the site has: the way back, the title, the wallet and the menu.
 *
 * Same contract as the vault and the Points page — the address chip disconnects, and the pill
 * carries the menu — because a header that behaves differently on one route is a header a player
 * has to learn twice.
 *
 * The two controls say different things on purpose. The chip is *who* is connected; the pill is
 * the figure the page is about, which is where the vault puts its weekly pool and the Points page
 * its standing. Printing the address in both was the first version, and it read as a stutter —
 * the same six characters twice in one row, with nothing to tell them apart.
 */
function Header({ pillRef, address, onDisconnect, balance }) {
    return (
        <header className="header">
            <div className="header-left">
                <BackLink />
                <button className="btn btn-ghost btn-sm" onClick={() => { window.location.href = '/'; }}>
                    <img src="assets/ui/exit cross.png" className="btn-icon-img" alt="" /> Kingdom Gate
                </button>
            </div>
            <div className="header-title">MY PORTFOLIO</div>
            <div className="header-actions">
                {address && (
                    <button className="btn btn-ghost btn-sm wallet-chip" onClick={onDisconnect} title="Click to disconnect">
                        <span className="wallet-chip-dot" aria-hidden="true" />
                        {shortAddress(address)}
                    </button>
                )}
                <div className="wallet-pill" ref={pillRef}>
                    <span>{address ? (balance || '—') : 'CONNECT'}</span>
                </div>
            </div>
        </header>
    );
}

/**
 * The capsule, in the round — the one interactive thing on this page.
 *
 * The prize for a top-ten day is a closed box with something glowing inside it, and a number cannot
 * say that. What the art came as was an eight-second 3D turn, which is a 72 MB ProRes file nobody
 * should be asked to download to look at a picture: it is exported once into `CAPSULE_SPIN`'s
 * frames, and this swaps between them. Stills rather than a `<video>` because a drag has to answer
 * on the frame it is asked for, and seeking is not something a page gets to do instantly.
 *
 * Three ways in, because the picture is not decoration and a reader who cannot drag should still
 * see it turn: a pointer drag, the arrow keys once it has focus, and one unhurried turn on arrival.
 * The turn happens **once** and then stops — a picture that keeps animating behind the reader's
 * eyes is a page that never settles — and a reader who has asked for reduced motion never sees it
 * move at all. The frames are warmed after the first paint, so the drag is never the thing that
 * waits for the network.
 *
 * **A release carries its momentum.** Letting go mid-flick throws the wheel: it keeps turning at the
 * speed the hand was moving and slows down over a couple of seconds, and a new grab catches it where
 * it is. That is the difference between a picture that has been dragged and one that has been spun —
 * a wheel with weight — and it is why the position is a float rather than a frame number. The
 * constants above are the feel; the arrival turn, the keys and reduced motion are not affected by it.
 */
function CapsuleSpin({ spin = CAPSULE_SPIN }) {
    const [frame, setFrame] = useState(1);
    const [dragging, setDragging] = useState(false);
    const [auto, setAuto] = useState(true);
    const dragFrom = useRef(null);
    const flingFrame = useRef(null);
    // The position is a *float*, and it is the only copy of where the wheel is. Frames are what the
    // picture is drawn from, not what it moves in: a drag of one pixel is a tenth of a frame, and a
    // throw spends most of its life between whole frames — with an integer position the slow end of
    // a spin would either stutter between two frames or stop dead the moment it could not advance a
    // whole one.
    const pos = useRef(1);
    // Frames per millisecond, smoothed over the last few pointer events so one jittery sample cannot
    // decide the whole throw.
    const velocity = useRef(0);
    const movedAt = useRef(null);

    /** Has the reader asked for less motion? Asked at the moment of the gesture, not at mount. */
    const calmMotion = () => typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

    /** Any frame number at all, wrapped into 1…`frames`. */
    const wrap = (value) => ((value - 1) % spin.frames + spin.frames) % spin.frames + 1;

    /** Point the picture at a position on the wheel. Whole frames are all it can be drawn at. */
    const show = (value) => setFrame(wrap(Math.round(value)));

    /** Stop a throw in flight — a new grab, a key, or the component going away. */
    const stopFling = () => {
        if (flingFrame.current === null) return;
        cancelAnimationFrame(flingFrame.current);
        flingFrame.current = null;
    };

    useEffect(() => stopFling, []);

    useEffect(() => {
        if (!auto) return undefined;
        if (calmMotion()) return undefined;
        let stepped = 0;
        const timer = setInterval(() => {
            stepped += 1;
            if (stepped >= spin.frames) {
                // A whole turn, then the still frame it started on.
                clearInterval(timer);
                pos.current = 1;
                setFrame(1);
                setAuto(false);
                return;
            }
            pos.current = wrap(pos.current + 1);
            setFrame(pos.current);
        }, 90);
        return () => clearInterval(timer);
    }, [auto, spin.frames]);

    // Warmed after the first paint rather than before it: the page is readable immediately, and the
    // drag is what the download is for.
    useEffect(() => {
        const warmed = [];
        for (let i = 1; i <= spin.frames; i += 1) {
            const image = new Image();
            image.src = capsuleSpinFrame(i, spin);
            warmed.push(image);
        }
        return () => { warmed.length = 0; };
    }, [spin]);

    /** Stop the arrival turn and any throw in flight the moment the reader takes over. */
    const takeOver = () => {
        setAuto(false);
        stopFling();
    };

    /**
     * Let go, and let the wheel keep going.
     *
     * `requestAnimationFrame` rather than a timer: this is an animation, and the browser's own clock
     * is the one that stops it when the tab is hidden. `dt` is clamped because a frame that arrives
     * after the tab was in the background reports a gap of seconds, and an unclamped step would
     * teleport the capsule several turns in one frame rather than easing to a stop.
     */
    const fling = (from) => {
        if (calmMotion()) return;
        let speed = from;
        let last = performance.now();
        const tick = (now) => {
            const dt = Math.min(64, now - last);
            last = now;
            pos.current += speed * dt;
            show(pos.current);
            speed *= Math.pow(CAPSULE_FLING.friction, dt);
            if (Math.abs(speed) < CAPSULE_FLING.stop) {
                flingFrame.current = null;
                return;
            }
            flingFrame.current = requestAnimationFrame(tick);
        };
        flingFrame.current = requestAnimationFrame(tick);
    };

    const onPointerDown = (event) => {
        takeOver();
        setDragging(true);
        // Snapped to the frame on screen, so catching a spin mid-throw does not jump the picture to
        // wherever the float happened to be between two frames.
        dragFrom.current = { x: event.clientX, pos: Math.round(pos.current) };
        movedAt.current = null;
        velocity.current = 0;
        try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* not capturable */ }
    };

    const onPointerMove = (event) => {
        if (!dragFrom.current) return;
        const next = dragFrom.current.pos - (event.clientX - dragFrom.current.x) / PX_PER_FRAME;
        const now = performance.now();
        const previous = movedAt.current;
        if (previous && now > previous.t) {
            const instant = (next - previous.pos) / (now - previous.t);
            velocity.current = velocity.current * 0.6 + instant * 0.4;
        }
        movedAt.current = { pos: next, t: now };
        pos.current = next;
        show(next);
    };

    const endDrag = (event) => {
        if (!dragFrom.current) return;
        dragFrom.current = null;
        setDragging(false);
        // A flick is what the hand was doing when it let go. `capsuleFling` is what decides whether
        // the release was a throw at all and how hard it may be: a careful placement comes back as
        // zero and is left exactly where it was put, and a swipe that outruns the cap is thrown at
        // the cap rather than for a hundred turns.
        const thrown = capsuleFling(velocity.current);
        if (thrown.speed) fling(thrown.speed);
        velocity.current = 0;
        movedAt.current = null;
        try {
            if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
            }
        } catch { /* already released */ }
    };

    const onKeyDown = (event) => {
        const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
        if (!step) return;
        event.preventDefault();
        takeOver();
        pos.current += step;
        show(pos.current);
    };

    return (
        <div
            className={`pf-spin ${dragging ? 'is-dragging' : ''}`}
            role="img"
            aria-label="A Knight capsule, turning. Drag it, or use the arrow keys, to spin it."
            tabIndex={0}
            data-arya="capsule-spin"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onKeyDown}
        >
            <img
                className="pf-spin-frame"
                src={capsuleSpinFrame(frame, spin)}
                alt=""
                width={384}
                height={384}
                decoding="async"
                draggable={false}
            />
        </div>
    );
}

function Row({ label, value, hint, live = false }) {
    return (
        <div className="pf-row">
            <dt>{label}</dt>
            <dd className="nft-live" aria-live={live ? 'polite' : undefined} aria-atomic={live ? 'true' : undefined}>
                {value}
                {hint ? <span className="pf-row-hint">{hint}</span> : null}
            </dd>
        </div>
    );
}
