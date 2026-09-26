'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// Arya is the shared gate keeper across the game; a React route has to pull her in
// itself, the same way the Points page does.
import Script from 'next/script';
import BackLink from '../back-link';
import {
    connectWallet, forgetWallet, hasInjectedWallet, onAccountsChanged, savedAddress, shortAddress,
} from '../../lib/points-client';
import {
    CAPSULES_PER_WEEK, GENESIS_SUPPLY, HASH_POWER_BANDS, HASH_POWER_MAX, HASH_POWER_MIN,
    KNIGHTS_REFERENCE_SIZE, TICKET_CAP_HOURS, WEEK_MS, bandFor, ticketsPerHour, weekEnd,
} from '../../lib/staking-config';
import {
    COLLECTIONS, COLLECTION_LABELS, KNIGHTS_HASH_POWER,
    applyAction, knightsYieldAtReference, loadVault, refresh, SOURCE_PREVIEW,
} from '../../lib/staking-source';
// The transaction path. Imported here rather than reimplemented: a stake that reaches the chain
// is one approval plus one call, and the order and the guard rails around it are the same code
// `tools/check-staking-writes.js` drives without a browser.
import { claimRewards, stakeKnight, stakeMany, unstakeKnight } from '../../lib/staking-writes';
// The portraits. `lib/knights.js` holds the tier table, so the vault shows the same face for a
// tier that the Hall's roster and the Summoning Chamber do — one table, three screens. The
// choice of portrait is a function rather than a lookup written out here, so the same rule can
// be asserted without a browser (`tools/check-rarity.js`).
import { knightPortrait } from '../../lib/knights';

// The tier ladder's own range, for the same reason the Genesis side has one: a bar drawn against
// the wrong range is not a rough picture of the value, it is a bar that is always empty. Knights
// run 15–100 hash power where Genesis runs 300–1000, so a Knight measured on Genesis's scale
// pegged at zero — and did, until this was split.
const KNIGHTS_HP_MIN = Math.min(...KNIGHTS_HASH_POWER.map((tier) => tier.hashPower));
const KNIGHTS_HP_MAX = Math.max(...KNIGHTS_HASH_POWER.map((tier) => tier.hashPower));

const TABS = [
    { key: 'staked', label: 'Staked' },
    { key: 'raffle', label: 'Raffle' },
    { key: 'capsules', label: 'Capsules' },
];

// Arya's walkthrough of this page. It runs once per visit — a returning player presses
// Skip in one click — and the footer replays it on request.
const TOUR_ID = 'staking-v1';

const TICK_MS = 1000;
const SEEN_KEY = 'dk_staking_seen';

/**
 * Which of the vault's buttons are a transaction when the vault is real.
 *
 * Four of them, and the four that are missing are missing on purpose. Entering the draw is not
 * one: on chain the ticket ledger *is* the entry, and `GenesisStaking.ticketsInWeek` is what the
 * raffle is drawn from — so a button offering to "enter" would be offering a transaction no
 * contract has. Opening a capsule belongs to the Summoning Chamber, where the knight is revealed.
 */
const CHAIN_ACTIONS = new Set(['stake', 'stakeAll', 'unstake', 'claim']);

/** A hash is 66 characters; six and four are enough to recognise it and to paste into an explorer. */
function shortHash(hash) {
    return hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : '';
}

// The tallest band sets the scale for the ladder, so the bars compare against the
// collection rather than against each other.
const LADDER_TOP = Math.max(...HASH_POWER_BANDS.map((band) => band.count));

/**
 * Sort orders for the two knight lists. Power is the default because it is the number a
 * staker actually compares — it *is* the hourly ticket rate.
 *
 * `tickets` on an unstaked knight is zero rather than unknown, so a list sorted by
 * tickets reads as staked-first, which is the useful order for that question.
 */
const SORTS = [
    { key: 'power', label: 'Power' },
    { key: 'tickets', label: 'Tickets' },
    { key: 'name', label: 'Name' },
];

/**
 * The four lines the weekly budget is partitioned into, in the order the vault's
 * constructor takes them.
 *
 * The shares are not decoration: `RewardVault` is deployed with exactly these basis points
 * and refuses a set that does not sum to 10,000, so what the page draws is what the
 * contract enforces. Genesis's share is permanent — the uncapped Knights collection cannot
 * dilute it by growing.
 */
const ECONOMY_LINES = [
    { key: 'genesisDungeon', label: 'Genesis · dungeon', collection: 'genesis' },
    { key: 'genesisStaking', label: 'Genesis · staking', collection: 'genesis' },
    { key: 'knightsDungeon', label: 'Knights · dungeon', collection: 'knights' },
    { key: 'knightsStaking', label: 'Knights · staking', collection: 'knights' },
];

// The draw ring's circumference, so the fill is `C × (1 - weekProgress)`.
const RING_C = 2 * Math.PI * 19;

function sortKnights(list, sort) {
    const copy = [...list];
    if (sort === 'tickets') copy.sort((a, b) => (b.tickets || 0) - (a.tickets || 0) || b.hashPower - a.hashPower);
    else if (sort === 'name') copy.sort((a, b) => a.tokenId - b.tokenId);
    else copy.sort((a, b) => b.hashPower - a.hashPower || a.tokenId - b.tokenId);
    return copy;
}

// ---------------------------------------------------------------- the walkthrough
/**
 * What Arya reads out. Every line is a function so she describes the vault as it is right
 * now — how many knights are staked, whether the pool is set — rather than how it looked
 * when this was written.
 */
function tourSteps(live, actions) {
    // `collection` rides along so a step can tell which side of the vault it is describing:
    // the rules differ in exactly one place, and a tour that told a Knights holder about the
    // draw would be telling them about someone else's prize.
    const now = () => ({ collection: 'genesis', ...(live() || {}) });
    return [
        {
            kind: 'think',
            mood: 'Welcome',
            text: 'This is the Vault, where your knights earn while you are away — <strong>Genesis</strong> for yield and the weekly draw, <strong>Knights</strong> for yield only. Six steps — <strong>Next</strong> to follow me, <strong>Skip</strong> if you would rather explore.',
        },
        {
            kind: () => (now().connected ? 'ready' : 'alarm'),
            mood: 'The vault',
            target: '[data-arya="vault"]',
            text: () => {
                const v = now();
                if (!v.connected) {
                    return 'The vault needs a wallet before it will open. Connect one and I will show you what is inside.';
                }
                if (v.source === SOURCE_PREVIEW) {
                    return 'Your wallet is connected. These knights are <strong>preview data</strong> — the staking contracts are not deployed yet, so nothing here is on-chain and nothing you press spends anything. The page will switch to real holdings on its own once they exist.';
                }
                return 'Your wallet is connected and these are your real Genesis Knights, read from the chain.';
            },
        },
        {
            kind: 'brace',
            mood: 'My knights',
            target: '[data-arya="genesis"]',
            text: () => {
                const v = now();
                // The two sides bank the same thing under different names, so the tour reads
                // the collection it is actually standing on rather than assuming Genesis.
                if (v.collection === 'knights') {
                    return `A Knight's <strong>hash power</strong> is fixed by its tier — ${KNIGHTS_HASH_POWER.map((t) => t.hashPower).join(', ')} — and it is what it banks every hour it is staked. ${v.stakedCount
                        ? `You have <strong>${v.stakedCount}</strong> staked with <strong>${v.hashPower}</strong> combined power.`
                        : 'Stake one and its weight starts counting immediately.'} Same seven-day cap as Genesis, and unlike Genesis there is <strong>no draw</strong> on this side: Knights earn yield, and that is the whole of it.`;
                }
                return `Every Genesis Knight has a <strong>hash power</strong> between ${HASH_POWER_MIN.toLocaleString()} and ${HASH_POWER_MAX.toLocaleString()}, and it decides how fast it earns — a knight banks its hash power in tickets every hour it is staked. ${v.stakedCount
                    ? `You have <strong>${v.stakedCount}</strong> staked with <strong>${v.hashPower}</strong> combined power.`
                    : 'Stake one and its tickets start counting immediately.'} A knight stops earning tickets after a week, so the cap is seven days.`;
            },
        },
        {
            kind: 'ready',
            mood: 'The numbers',
            target: '[data-arya="tiles"]',
            text: () => {
                const v = now();
                if (v.poolDng === null) {
                    return 'The weekly pool has not loaded yet, so the DNG figures are blank rather than guessed. Your <em>share</em> of that pool is real either way and it grows every second while you watch.';
                }
                return `A pool of <strong>${v.poolDng.toLocaleString()} DNG</strong> is split each week in proportion to tickets, and <strong>${CAPSULES_PER_WEEK}</strong> capsules go to the draw. Both are claimable without unstaking. That pool is a <em>fixed share</em> of everything the vault releases, so the uncapped Knights collection cannot dilute it by growing.`;
            },
        },
        {
            kind: 'think',
            mood: 'The draw',
            target: '[data-arya="tabs"]',
            text: () => {
                const v = now();
                return `Three views: what you have <strong>Staked</strong>, the <strong>Raffle</strong> and your <strong>Capsules</strong>. One entry a week per knight, drawn Monday at 00:00 UTC. Your entries show their expected capsule share, so you can see the odds rather than guess at them.${v.phase === 'pending' ? ' The draw is running right now.' : ''}`;
            },
        },
        {
            kind: 'ready',
            mood: 'Fair warning',
            target: '[data-arya="footer"]',
            text: 'Two things worth saying plainly. Unstaking forfeits the tickets that knight earned — tickets only count while it is staked. And early on, with few knights in the pool, one player can take most of a draw. That is the formula working, not a fault. Ask me again any time from down here.',
        },
    ];
}

// ------------------------------------------------------------------- formatting
/**
 * A whole number, or an em dash when there is no number to print.
 *
 * The dash is load-bearing. Several of these figures are `null` on a chain-backed vault — a pool
 * total the page declined to read, a count the contracts do not publish — and `Math.round(null || 0)`
 * turns every one of them into a confident **0**. A missing number printed as zero is the exact
 * failure this page is built to avoid: "0 tickets in the draw" and "the draw is unreadable" are
 * opposite messages, and only one of them is true.
 */
function fmtInt(value) {
    if (value === null || value === undefined) return '—';
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number).toLocaleString() : '—';
}

function fmtHours(hours) {
    if (!Number.isFinite(hours) || hours < 0) return '—';
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
    if (hours < 48) return `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`;
    return `${Math.floor(hours / 24)}d ${Math.floor(hours % 24)}h`;
}

function fmtCountdown(ms, phase) {
    if (phase === 'pending') return 'Drawing…';
    const total = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
    return `${mins}m ${secs}s`;
}

/**
 * Pool share reads as a fraction of a percent for a while, so it needs its own scale.
 *
 * `null` is a share that could not be computed — the pool total it is a fraction *of* was not read —
 * and it prints as a dash rather than as 0%. The difference is not cosmetic: 0% says "you have no
 * chance in this draw", which is a much worse thing to tell someone than "this is not known".
 */
function fmtShare(fraction) {
    if (fraction === null || fraction === undefined) return '—';
    const pct = 100 * fraction;
    if (pct === 0) return '0%';
    if (pct < 0.01) return `${pct.toFixed(4)}%`;
    return `${pct.toFixed(2)}%`;
}

/**
 * An accrual figure needs more precision than a plain percentage.
 *
 * A weekly pool divided over 604,800 seconds moves a share by roughly 0.00007% each
 * second, which is invisible at two decimals — the number would sit still for half a
 * minute and look broken. Five decimals step about seven times a second, which is the
 * point: the staker can see it earning.
 */
function fmtSharePrecise(fraction, digits = 5) {
    if (fraction === null || fraction === undefined) return '—';
    return `${(100 * fraction).toFixed(digits)}%`;
}

function fmtDng(value) {
    if (value === null || value === undefined) return 'TBD';
    return `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DNG`;
}

/**
 * A plain percentage, for a ratio the reader compares rather than tracks.
 *
 * Deliberately not `fmtShare`: that one widens to four decimals below 0.01% because a pool
 * share starts microscopic. A comparison against a reference rate is always a whole number, so
 * a figure like `5.0000%` would imply a precision the underlying model does not have.
 */
function fmtPercent(fraction, digits = 1) {
    return `${(100 * (fraction || 0)).toFixed(digits)}%`;
}

export default function StakingClient() {
    const [phase, setPhase] = useState('boot');
    const [vault, setVault] = useState(null);
    const [address, setAddress] = useState(null);
    const [nowMs, setNowMs] = useState(() => Date.now());
    const [tab, setTab] = useState('staked');
    // Which collection's side of the vault is on screen. Genesis stakes for yield *and* the
    // weekly draw; Knights stake for yield only, because the draw's prize is a capsule and a
    // capsule mints a Knight. Both draw from the same weekly budget, each from its own line.
    const [collection, setCollection] = useState('genesis');
    // `load` has to read the collection it was called *for*, not the one captured when the
    // callback was created — a dependency would rebuild it and re-run the boot effect on
    // every switch, reloading the vault twice.
    const collectionRef = useRef('genesis');
    const [busy, setBusy] = useState(null);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [since, setSince] = useState(null);
    const [dismissedSince, setDismissedSince] = useState(false);
    // The three controls a player drives rather than reads: how the list is ordered, which
    // band of the ladder is selected, and what-if the weekly pool were a different size.
    const [sort, setSort] = useState('power');
    const [bandFilter, setBandFilter] = useState(null);
    const [hoverBand, setHoverBand] = useState(null);
    // The published economy, straight from `/api/staking/config`. Null only until the fetch
    // lands, or if it fails — in which case the pool tile still shows the derived default
    // and this panel is simply absent rather than wrong.
    const [economy, setEconomy] = useState(null);

    const tourOpened = useRef(false);
    const tabRefs = useRef({});
    // The config is fetched once, and the wallet load reuses it rather than asking twice.
    const configRef = useRef(null);
    const live = useMemo(() => (vault ? refresh(vault, nowMs) : null), [vault, nowMs]);

    // The published economy is a fact about the vault, not about the wallet — so it is
    // fetched on mount rather than on connect. Someone deciding whether to connect should
    // be able to read what the vault pays before they connect anything, and the panel used
    // to be absent for exactly the visitors most likely to be reading it.
    useEffect(() => {
        let cancelled = false;
        fetch('/api/staking/config')
            .then((r) => (r.ok ? r.json() : null))
            .then((config) => {
                if (cancelled) return;
                configRef.current = config;
                setEconomy(config?.economy ?? null);
            })
            .catch(() => {
                if (!cancelled) setEconomy(null);
            });
        return () => { cancelled = true; };
    }, []);

    // -------------------------------------------------------------- boot the wallet
    /**
     * A JSON fetch that throws on a bad status.
     *
     * Passed into `loadVault` so the module stays free of network code: it is imported by the
     * Node harness too, and a `fetch` call baked into it would make every check against it a
     * network test. The holdings read needs it — it is the one thing on this page that comes
     * from the chain rather than from arithmetic.
     */
    const fetchJson = useCallback(async (url) => {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`${url} answered ${response.status}`);
        return response.json();
    }, []);

    /**
     * Read the vault for a wallet.
     *
     * `quiet` keeps whatever is on screen while the new snapshot is fetched. It exists for
     * switching sides: a wallet is already loaded, so replacing the whole vault with
     * "OPENING THE VAULT" throws away a board the player was reading to show them a loader for
     * data that is usually already in hand. On a chain deployment that is a network round trip
     * of blank page, which is the moment a player is most likely to think the vault broke.
     */
    const load = useCallback(async (who, { quiet = false, fresh = false } = {}) => {
        if (!quiet) setPhase('loading');
        try {
            const config = configRef.current
                || await fetch('/api/staking/config').then((r) => (r.ok ? r.json() : null)).catch(() => null);
            const next = await loadVault(who, {
                config,
                nowMs: Date.now(),
                collection: collectionRef.current,
                fetchJson,
                // Set by the transaction path once the chain has accepted a write, so the read that
                // follows cannot answer from a cache built before the wallet changed anything.
                fresh,
            });
            setVault(next);
            setPhase('ready');
        } catch (err) {
            setError(err?.message || 'Could not open the vault.');
            setPhase('ready');
        }
    }, [fetchJson]);

    useEffect(() => {
        // The collection is read *before* the wallet loads, so a bookmarked `?collection=knights`
        // boots straight into the right vault rather than loading Genesis and then swapping.
        const fromUrl = new URLSearchParams(window.location.search).get('collection');
        if (fromUrl && COLLECTIONS.includes(fromUrl)) {
            collectionRef.current = fromUrl;
            setCollection(fromUrl);
        }

        const stored = savedAddress();
        if (stored) {
            setAddress(stored);
            load(stored);
        } else {
            setVault(null);
            setPhase('ready');
        }

        return onAccountsChanged((next) => {
            if (!next) {
                setAddress(null);
                setVault(null);
                return;
            }
            setAddress(next);
            load(next);
        });
    }, [load]);

    // The tab lives in the URL so a refresh, a back button or a shared link all land on
    // the view someone was actually looking at.
    useEffect(() => {
        const fromUrl = new URLSearchParams(window.location.search).get('tab');
        if (fromUrl && TABS.some((t) => t.key === fromUrl)) setTab(fromUrl);
    }, []);

    const selectTab = useCallback((key, { focus = false } = {}) => {
        setTab(key);
        const url = new URL(window.location.href);
        url.searchParams.set('tab', key);
        window.history.replaceState(null, '', url);
        if (focus) tabRefs.current[key]?.focus();
    }, []);

    /**
     * Switch sides of the vault.
     *
     * The tab is deliberately *kept*, including when it is one of the Genesis-only ones —
     * landing on the raffle tab with a Knights knight selected is the one moment a player is
     * in the right place to be told that the draw is Genesis-only, and switching them away
     * would hide the explanation behind a click they have no reason to make.
     */
    const selectCollection = useCallback((key) => {
        if (key === collectionRef.current || !COLLECTIONS.includes(key)) return;
        collectionRef.current = key;
        setCollection(key);
        setBandFilter(null);
        const url = new URL(window.location.href);
        url.searchParams.set('collection', key);
        window.history.replaceState(null, '', url);
        if (address) load(address, { quiet: true });
    }, [address, load]);

    // Arrow keys move relative to the tab that has *focus*, not the one that is selected.
    // The two usually agree, but when they do not — a script, an assistive tool or a
    // restored URL can focus a tab without selecting it — measuring from the selection
    // sends the caret somewhere the player was not looking.
    const onTabKeyDown = (event) => {
        const focusedKey = event.target?.closest?.('.sv-tab')?.dataset?.key || tab;
        const index = TABS.findIndex((t) => t.key === focusedKey);
        if (index === -1) return;
        const last = TABS.length - 1;
        let next = null;
        if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1;
        else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = last;
        if (next === null) return;
        event.preventDefault();
        selectTab(TABS[next].key, { focus: true });
    };

    // ------------------------------------------------------------------- the tick
    // One interval drives every live figure. It pauses while the tab is hidden, because
    // an accrual that keeps running off screen is a number nobody is reading.
    useEffect(() => {
        const id = setInterval(() => {
            if (typeof document !== 'undefined' && document.hidden) return;
            setNowMs(Date.now());
        }, TICK_MS);
        return () => clearInterval(id);
    }, []);

    // ------------------------------------------------- what changed while you were away
    // A staker coming back needs the one line that matters: what did the staking earn
    // since last time. Read before the new timestamp is written.
    useEffect(() => {
        if (!live?.connected || !live.wallet) {
            setSince(null);
            return;
        }
        const key = `${SEEN_KEY}:${live.wallet.toLowerCase()}`;
        let stored = null;
        try {
            stored = JSON.parse(window.localStorage.getItem(key) || 'null');
        } catch {
            stored = null;
        }
        if (stored?.at && Array.isArray(stored.tickets)) {
            const before = stored.tickets.reduce((sum, entry) => {
                const now = (live.staked || []).find((k) => k.tokenId === entry.tokenId);
                return sum + (now ? now.tickets - entry.tickets : 0);
            }, 0);
            if (before > 0 && Date.now() - stored.at > 3_600_000) {
                setSince({ tickets: before, away: Date.now() - stored.at });
            }
        }
    }, [live?.wallet, live?.connected]);

    useEffect(() => {
        if (!live?.connected || !live.wallet || phase !== 'ready') return;
        const key = `${SEEN_KEY}:${live.wallet.toLowerCase()}`;
        try {
            window.localStorage.setItem(key, JSON.stringify({
                at: Date.now(),
                tickets: (live.staked || []).map((k) => ({ tokenId: k.tokenId, tickets: k.tickets })),
            }));
        } catch {
            // A full or disabled localStorage must not break the page.
        }
    }, [phase, live?.wallet, live?.connected]);

    // --------------------------------------------------------------- Arya's walkthrough
    const liveRef = useRef(live);
    liveRef.current = live;

    // The header's wallet pill, and the page's own disconnect handler for the menu to call.
    // The handler is held in a ref because the menu attaches once, in an effect that must not
    // re-run every render — while `handleDisconnect` is rebuilt on each one.
    const walletPill = useRef(null);
    const handleDisconnectRef = useRef(() => {});

    // A first-time visitor gets the walkthrough; everyone else gets the page. The gate is
    // `/arya.js`'s own memory of this tour id — finishing, skipping or leaving mid-way all
    // mark it seen — so there is deliberately no `force` in this effect. `force` belongs to
    // the footer's "Ask Arya", which is how a returning player asks for it again.
    useEffect(() => {
        if (phase !== 'ready' || tourOpened.current) return undefined;
        let cancelled = false;
        const timer = setTimeout(() => {
            if (cancelled || tourOpened.current) return;
            const arya = window.Arya;
            if (!arya || arya.isTouring?.()) return;
            tourOpened.current = true;
            arya.tour(TOUR_ID, { steps: tourSteps(() => liveRef.current, {}) });
        }, 900);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [phase]);

    /**
     * The header's wallet menu, on the control this route renders.
     *
     * `onDisconnect` is the page's own handler, and that is the point of the option: the vault holds
     * its wallet in state, so a disconnect the page does not perform would clear localStorage and
     * leave the header still showing an address. The menu does not reach into React; React hands it
     * the one function that can put the page back to how it looks with nobody connected.
     */
    // The pill is rendered by the *ready* branch, not by the boot/loading one — so on a cold load
    // this effect first runs while the vault is still reading and `walletPill.current` is null, and
    // an effect that bails there never runs again: the page ends up with a control and no menu on
    // it, which is My Portfolio unreachable from the vault. Re-running when the pill appears is the
    // fix; waiting for the element rather than the phase name would be the other way to say it.
    const pillRendered = phase !== 'boot' && phase !== 'loading';

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
            // `/wallet-menu.js` is `afterInteractive`, so on a cold load it can arrive after this
            // effect. Polling a few times beats assuming a load order the framework chooses.
            let tries = 0;
            const timer = setInterval(() => {
                if (attach() || tries++ > 40) clearInterval(timer);
            }, 100);
            return () => { cancelled = true; clearInterval(timer); };
        }
        return () => { cancelled = true; };
    }, [pillRendered]);

    /** The footer's "Ask Arya" — the walkthrough again, on request, past the seen flag. */
    const askArya = () => {
        if (!window.Arya) return;
        window.Arya.tour(TOUR_ID, { steps: tourSteps(() => liveRef.current, {}), force: true });
    };

    // ------------------------------------------------------------------- the actions
    /**
     * Show a line for a while, then let it go.
     *
     * Guarded against its own timeout: a later message replaces an earlier one, and the older
     * timer must not then wipe the newer notice off the screen.
     */
    const flash = useCallback((message, ms = 6000) => {
        setNotice(message);
        if (!message) return;
        setTimeout(() => setNotice((current) => (current === message ? null : current)), ms);
    }, []);

    /**
     * Send a chain action, then re-read the vault from the chain.
     *
     * The reload is the point of the whole exercise: a stake moves the knight out of the wallet
     * and into the pool, so the only way to know the new state is to ask. It is asked **fresh**,
     * bypassing the route's 30-second cache, because reading back the state from before the
     * transaction is exactly what makes a working stake look like a vault that did nothing.
     */
    const sendChainAction = useCallback(async (action, payload, snapshot) => {
        const config = configRef.current;
        const nft = config?.collections?.[snapshot.collection]?.nft;
        const staking = snapshot.collection === 'knights'
            ? config?.addresses?.knightsStaking
            : config?.addresses?.staking;

        // Checked before a wallet is asked to sign anything, so a configuration gap reads as a
        // configuration gap rather than as a wallet that refused.
        if (!nft || !staking) {
            const message = `The ${snapshot.collection === 'knights' ? 'Knights' : 'Genesis'} staking pool is not configured for this network, so there is nothing to send this to.`;
            setError(message);
            if (window.Arya?.say) window.Arya.say('alarm', { message });
            return null;
        }

        const expectedChainId = config?.chainId || null;
        const before = snapshot.claim?.payable ?? null;
        const stage = ({ stage: at, step, hash }) => {
            if (at === 'sending') flash(`${step.label}…`, 60_000);
            else if (at === 'sent') flash(`${step.label} — sent ${shortHash(hash)}. Waiting for the chain…`, 60_000);
        };

        setError(null);
        setBusy(action);
        try {
            let done = 0;
            if (action === 'stake') {
                await stakeKnight({ staking, collection: nft, tokenId: payload.tokenId, onStage: stage, expectedChainId });
                done = 1;
            } else if (action === 'stakeAll') {
                // Every knight the wallet owns, in one approval. The approval is read once and
                // reused: re-reading it per knight would be one extra round trip per knight, and
                // the answer cannot change in the middle of a batch the same wallet is signing.
                const tokenIds = (snapshot.owned || []).map((knight) => knight.tokenId);
                if (!tokenIds.length) throw new Error('Nothing left to stake.');
                await stakeMany({ staking, collection: nft, tokenIds, onStage: stage, expectedChainId });
                done = tokenIds.length;
            } else if (action === 'unstake') {
                await unstakeKnight({ staking, tokenId: payload.tokenId, onStage: stage, expectedChainId });
                done = 1;
            } else if (action === 'claim') {
                await claimRewards({ staking, onStage: stage, expectedChainId });
                done = 1;
            }

            await load(snapshot.wallet, { quiet: true, fresh: true });

            const unit = snapshot.collection === 'knights' ? 'knight' : 'Genesis Knight';
            const message = action === 'claim'
                ? (before === null
                    ? 'Claimed. What the staking line could not pay stays claimable and pays out later.'
                    : `Claimed up to ${fmtDng(before)} from this week’s staking line. Anything it could not pay stays claimable.`)
                : `${done} ${unit}${done === 1 ? '' : 's'} ${action === 'unstake' ? 'back in your wallet' : 'staked'} — confirmed on chain.`;
            flash(message);
            if (window.Arya?.say) window.Arya.say('ready', { message });
            return { sent: true };
        } catch (err) {
            const message = err?.message || 'The transaction failed.';
            setError(message);
            flash(null);
            if (window.Arya?.say) window.Arya.say('alarm', { message });
            return null;
        } finally {
            setBusy(null);
        }
    }, [flash, load]);

    /**
     * What a button does.
     *
     * Two implementations behind one entry point, and which one runs is **the snapshot's own
     * answer** rather than the page's opinion: `writesToChain` is set only on a chain snapshot
     * whose side has both a reachable interface and a configured pool. Everything else — the
     * deterministic preview, and a real collection whose pool the page cannot reach — mutates
     * locally and says so, because a button that looks like a stake and reaches nothing is the one
     * failure this page must never have.
     */
    const run = useCallback(async (action, payload = {}) => {
        const current = liveRef.current;
        if (!current) return null;

        if (current.writesToChain && CHAIN_ACTIONS.has(action)) {
            return sendChainAction(action, payload, current);
        }

        setError(null);
        setBusy(action);
        const result = applyAction(current, action, payload, Date.now());
        setBusy(null);
        if (result.error) {
            setError(result.error);
            if (window.Arya?.say) window.Arya.say('alarm', { message: result.error });
            return null;
        }
        if (result.snapshot) setVault(result.snapshot);
        if (result.notice) flash(result.notice);
        if (result.redirect) {
            // A capsule opens in the Summoning Chamber, where the knight is revealed.
            setTimeout(() => { window.location.href = result.redirect; }, 1200);
        }
        if (window.Arya?.say) window.Arya.say('ready', { message: result.notice });
        return result;
    }, [flash, sendChainAction]);

    const handleConnect = async () => {
        setError(null);
        setBusy('connect');
        try {
            const who = await connectWallet();
            // Null is the Privy login being closed, or still open: nothing to load yet, and a
            // sign-in that lands later brings the wallet with it.
            if (!who) return;
            setAddress(who);
            await load(who);
        } catch (err) {
            setError(err?.message || 'The wallet refused to connect.');
        } finally {
            setBusy(null);
        }
    };

    const handleDisconnect = () => {
        forgetWallet();
        setAddress(null);
        setVault(null);
        if (window.Arya?.hide) window.Arya.hide();
    };
    handleDisconnectRef.current = handleDisconnect;

    // ------------------------------------------------------------------------ render
    const pageStyles = (
        <>
            {/* Versioned like every other sheet: an unversioned `/theme.css` is a CSS change
                that never reaches a returning player. */}
            <link rel="stylesheet" href="/theme.css?v=8" />
            <link rel="stylesheet" href="/css/staking.css?v=10" />
            <link rel="stylesheet" href="/css/arya.css?v=3" />
            <link rel="stylesheet" href="/css/nft-ui.css?v=1" />
            {/* ethers v5 UMD, the same pinned copy every legacy page loads — first in the list,
                because it is the one the others and this page sign with. It is loaded here rather
                than bundled, because a second copy compiled into the React chunk is how
                `parseEther` and `utils.parseEther` end up in one page. The write path checks for
                the global before it sends anything and says so plainly when it is not there yet. */}
            <Script src="/ethers-5.7.2.umd.min.js" strategy="afterInteractive" />
            <Script src="/arya.js?v=5" strategy="afterInteractive" />
            {/* The header's wallet pill gets the same menu every other page's control has. Attached
                by hand in an effect below, because a script scanning the DOM at load would run
                before this route has rendered anything. */}
            <Script src="/wallet-menu.js?v=1" strategy="afterInteractive" />
            <Script src="/wallet-source.js?v=3" strategy="afterInteractive" />
        </>
    );

    if (phase === 'boot' || phase === 'loading') {
        return (
            <>
                {pageStyles}
                <div className="page staking-page" style={{ background: 'var(--bg-dark)' }}>
                    <header className="header">
                        <div className="header-left">
                            <BackLink />
                            <button className="btn btn-ghost btn-sm" onClick={() => { window.location.href = '/'; }}>
                                <img src="assets/ui/exit cross.png" className="btn-icon-img" alt="" /> Kingdom Gate
                            </button>
                        </div>
                        <div className="header-title">STAKING VAULT</div>
                        <div className="header-actions" />
                    </header>
                    <div className="sv-main-row is-centered">
                        <div className="sv-empty">
                            <div className="sv-empty-title">Opening the vault</div>
                            <div className="sv-empty-text">Reading the vault — your knights{phase === 'boot' ? '' : ' and this week&rsquo;s stake'}…</div>
                        </div>
                    </div>
                </div>
            </>
        );
    }

    const connected = !!live?.connected;
    // Derived once, on purpose. Some write controls live in panels that are always
    // rendered — the inactive tabs stay mounted so their `aria-controls` resolve — and
    // those panels render when `live` is still null, i.e. for every first-time visitor
    // who has not connected yet. Reading `live.canWrite` there threw during render and
    // took the whole page down. Every write control now reads this flag instead.
    const canWrite = !!live?.canWrite;
    const isPreview = live?.source === SOURCE_PREVIEW;
    // Real holdings, no staking contract: the controls work, and every one of them is a
    // simulation. Read from the snapshot rather than derived here, because the page must not
    // decide for itself whether it can write.
    const simulated = !!live?.simulated;
    // Which side the *board* is showing — read from the snapshot, not from the click.
    //
    // Switching sides is deliberately quiet: the previous board stays up while the new one is
    // fetched, so a player never watches their vault blank out. But the selection flips instantly,
    // and deriving the labels from it captioned the old side's numbers with the new side's words —
    // a tile headed "The Genesis staking line" quoting the Knights pool, for as long as the read
    // took. The snapshot knows which collection it describes, so the labels and the numbers change
    // together, when the data arrives; the tab highlight follows the click a step ahead of them.
    const boardCollection = live?.collection || collection;
    const isKnights = boardCollection === 'knights';
    // What the chain read actually managed, when one was attempted. Kept whole rather than
    // reduced to a count, because the honest part is not how many knights came back — it is
    // whether that number is the *whole* answer.
    const holdings = live?.holdings || null;
    const collectionLabel = COLLECTION_LABELS[collection] || 'Genesis';
    const staked = live?.staked || [];
    const owned = live?.owned || [];
    const totals = live?.totals || {};
    const pool = live?.pool || {};
    const week = live?.week || {};
    const poolDng = live?.pool?.dng ?? null;

    // The ladder counts every knight the wallet holds — staked or not — because it is a
    // picture of what this wallet owns, not of what it is currently earning with.
    const mine = [...staked, ...owned];
    // One filter, two vocabularies: a Genesis knight is filtered by the hash-power band it
    // falls in, a Knights knight by the tier it was minted at. The keys never collide
    // (`spark`… vs `common`…), so one piece of state serves both and switching sides clears
    // nothing a player did not set.
    const groupOf = (knight) => (isKnights ? knight.rarity : bandFor(knight.hashPower)?.key);
    const matchesFilter = (knight) => !bandFilter || groupOf(knight) === bandFilter;
    const shownStaked = sortKnights(staked, sort).filter(matchesFilter);
    const shownOwned = sortKnights(owned, sort).filter(matchesFilter);
    const filterBand = !isKnights && bandFilter ? HASH_POWER_BANDS.find((band) => band.key === bandFilter) : null;
    const filterTier = isKnights && bandFilter ? KNIGHTS_HASH_POWER.find((tier) => tier.key === bandFilter) : null;
    // The ratio a Knights staker is actually exposed to: the pool is a fixed share of the
    // budget, so filling the uncapped collection divides it. D irectly from the model rather
    // than written into the copy, so it cannot drift from the economy page.
    const knightsReferenceSize = knightsYieldAtReference();

    // Tickets bank at exactly the hash power, so the staked total *is* the hourly rate.
    const hourlyTickets = totals.hashPower || 0;

    // The week ring: how much of the week between the last draw and the next has run.
    const weekOpenAt = weekEnd(nowMs) - WEEK_MS;
    const weekProgress = Math.min(1, Math.max(0, (nowMs - weekOpenAt) / WEEK_MS));

    const countdownMs = (week.drawAt || 0) - nowMs;
    // What the wallet can actually take, and on a chain-backed vault that is the pool's own
    // `claimableNow` — what `claim()` would pay right now, already clamped by this week's line.
    // The model's share of the published pool is the fallback, not the answer, because the
    // contract is the thing that decides. `null` means neither could be computed, which the
    // summary prints as a dash rather than as zero.
    const chainClaimable = typeof live?.claim?.payable === 'number' ? live.claim.payable : null;
    const myAccruedShare = staked.reduce((sum, knight) => sum + (knight.accruedShare || 0), 0);
    const claimable = chainClaimable !== null
        ? chainClaimable
        : (poolDng === null ? null : myAccruedShare * poolDng);
    // Whether this side's entries into the draw are a ledger the contract keeps. When they are, the
    // page explains that instead of offering an enter/withdraw button the chain has no call for.
    const entriesAutomatic = !!live?.entriesAutomatic;
    // Whether a button on this page signs a transaction. Read from the snapshot, never inferred
    // from the presence of an address: the same vault can be chain-backed and still unable to send
    // (a pool that is not configured), and copy that promised a transaction in that state would be
    // describing a different page.
    const realWrites = !!live?.writesToChain;
    // Whether the pool total behind `totals.myShare` was read. When it was not, the share is `null`
    // and every place that prints it says why rather than showing a percentage of nothing.
    const poolUnknown = totals.totalTickets === null || totals.totalTickets === undefined;

    // Claim, and the two things a player needs before pressing it.
    //
    // `claim()` is a **wallet-level** call — it settles every stake in one pass — so the button is
    // deliberately the same behind every card, and the title says so. It is disabled when the
    // pool's own `claimableNow` is zero, because that is precisely the state the contract reverts
    // in ("Nothing to claim"), and a button whose only outcome is a reverted transaction is worse
    // than one that explains itself.
    const claimTitle = live?.claim
        ? (chainClaimable === null
            ? 'The pool’s claimable figure could not be read just now.'
            : chainClaimable > 0
                ? `Claim ${fmtDng(chainClaimable)} — one call settles every knight this wallet has staked.`
                : (live.claim.pending > 0
                    ? 'This week’s staking line is already spent. What has accrued stays claimable and pays out as the line refills.'
                    : 'Nothing has accrued yet. Yield builds while a knight is staked.'))
        : (poolDng === null ? 'The weekly pool is not set yet' : 'Claim accrued DNG');
    const claimDisabled = !!live?.claim && chainClaimable === 0;

    // One sentence for a screen reader, instead of a tick every second.
    const liveSummary = connected
        ? `${collectionLabel} staked ${totals.stakedCount || 0}. ${isKnights ? 'Yield weight' : 'Tickets'} ${fmtInt(totals.myTickets)}. Pool share ${fmtShare(totals.myShare)}. ${poolDng === null ? 'Weekly pool not decided yet.' : `Claimable ${fmtDng(claimable)}.`}`
        : 'No wallet connected.';

    const connectLabel = (() => {
        if (busy === 'connect') return 'Waiting for your wallet…';
        if (!hasInjectedWallet()) return 'No Web3 wallet detected';
        return address && !connected ? `Sign in as ${shortAddress(address)}` : 'Connect Wallet';
    })();

    const previewBadge = isPreview && (
        <span className="sv-preview-badge" title="These holdings are placeholder data — the staking contracts are not deployed yet.">
            ● Preview data
        </span>
    );

    // Real knights, simulated staking. The badge is separate from the preview one on purpose:
    // "the knights are invented" and "the knights are real but the stake is not" are different
    // claims, and a player deciding whether to act needs to know which one they are looking at.
    const simulationBadge = simulated && (
        <span
            className="sv-sim-badge"
            title="Your knights are real, read from the collection. The staking contract is not deployed, so staking here is a simulation and sends no transaction."
        >
            ● Real knights · simulated staking
        </span>
    );

    // The third state, and the one that used to be impossible: a side whose buttons really do sign
    // transactions. It is stated rather than merely implied by the absence of a warning, because
    // "nothing warns me" and "I am about to sign a transaction" are very different things to put in
    // front of someone with a wallet open.
    const chainBadge = live?.writesToChain && (
        <span
            className="sv-chain-badge"
            title="Staking, unstaking and claiming on this page are transactions you sign in your wallet and that land on chain."
        >
            ● On chain · you sign
        </span>
    );

    return (
        <>
            {pageStyles}
            <div className="page staking-page" style={{ background: 'var(--bg-dark)' }}>

                <header className="header">
                    <div className="header-left">
                        <BackLink />
                        <button className="btn btn-ghost btn-sm" onClick={() => { window.location.href = '/'; }}>
                            <img src="assets/ui/exit cross.png" className="btn-icon-img" alt="" /> Kingdom Gate
                        </button>
                    </div>
                    <div className="header-title">STAKING VAULT</div>
                    <div className="header-actions" data-arya="wallet">
                        {connected && (
                            <button className="btn btn-ghost btn-sm wallet-chip" onClick={handleDisconnect} title="Click to disconnect">
                                <span className="wallet-chip-dot" aria-hidden="true" />
                                {shortAddress(live.wallet)}
                            </button>
                        )}
                        <div className="wallet-pill" ref={walletPill}>
                            <span className="sv-num">
                                {poolDng === null ? 'POOL · TBD' : `POOL · ${poolDng.toLocaleString()} DNG`}
                            </span>
                        </div>
                    </div>
                </header>

                <div className="sv-main-row">

                    {/* LEFT — the player's knights, on whichever side of the vault is selected */}
                    <aside className="side-panel sv-aside" data-arya="genesis">
                        <div className="side-panel-header">
                            <img src="assets/ui/shield.png" className="panel-header-icon" alt="" />
                            My {collectionLabel}
                            {previewBadge}
                            {simulationBadge}
                            {chainBadge}
                        </div>
                        <div className="side-panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

                            {/* The switch is the first thing in the panel, because the difference
                                between the two sides is the one thing a player has to know
                                before any number below means anything. */}
                            <div className="sv-collections" role="group" aria-label="Which collection to stake">
                                {COLLECTIONS.map((key) => (
                                    <button
                                        key={key}
                                        type="button"
                                        className={`sv-collection${collection === key ? ' is-on' : ''}`}
                                        data-collection={key}
                                        aria-pressed={collection === key}
                                        onClick={() => selectCollection(key)}
                                    >
                                        <span className="sv-collection-label">{COLLECTION_LABELS[key]}</span>
                                        <span className="sv-collection-sub">
                                            {key === 'genesis' ? 'Yield + the weekly draw' : 'Yield only — no draw'}
                                        </span>
                                    </button>
                                ))}
                            </div>

                            {isPreview && (
                                <p className="sv-preview-note">
                                    The staking contracts are not deployed yet, so this vault is showing a
                                    preview built from your address: the maths, the countdown and every
                                    interaction are real, the holdings are not. The Knights vault needs its
                                    own contract too, so both sides are preview alike.
                                </p>
                            )}

                            {/* How the list below was arrived at, stated rather than implied.
                                The collection has no on-chain list of owners, so a wallet's knights
                                can only be found from its transfer history and then confirmed one by
                                one. That method can come up short, and the two cases are different
                                enough to say differently: unreachable is a failure to try, incomplete
                                is a try that did not finish. Neither is allowed to look like a
                                complete answer. */}
                            {holdings && (
                                <p className={`sv-holdings-note${holdings.ok && holdings.complete ? '' : ' is-partial'}`}>
                                    {!holdings.ok ? (
                                        <>{holdings.reason}</>
                                    ) : owned.length === 0 && staked.length === 0 ? (
                                        <>
                                            This wallet holds no {isKnights ? 'knights' : 'Genesis Knights'}
                                            {holdings.balance
                                                ? <> — though the collection reports {fmtInt(holdings.balance)},
                                                    {' '}so nothing could be confirmed. Treat that as a failed read, not an empty wallet.</>
                                                : '.'}
                                        </>
                                    ) : (
                                        <>
                                            {fmtInt(owned.length + staked.length)} knight(s) read straight from the
                                            collection, each confirmed against its owner.
                                            {!holdings.complete && (
                                                <>
                                                    {' '}<strong>
                                                        This collection cannot be enumerated, and it reports{' '}
                                                        {fmtInt(holdings.balance)} owned — so treat this list as short.
                                                    </strong>
                                                </>
                                            )}
                                        </>
                                    )}
                                </p>
                            )}

                            {/* On the Knights side the ladder is a tier table rather than a
                                distribution: the collection is uncapped, so there are no band
                                counts to draw. What a Knight *can* hold is fixed by its tier
                                — hash power is its dungeon capacity ÷ 4 — so the five powers
                                are the only thing about the collection its owner can plan
                                around. Same filter state, same tap-to-filter behaviour. */}
                            {isKnights && (
                                <div className="sv-ladder" data-arya="ladder">
                                    <div className="sv-ladder-head">
                                        <span className="sv-ladder-title">Tier ladder</span>
                                        <span className="sv-ladder-rule sv-num">power = tier ÷ 4</span>
                                    </div>
                                    <div
                                        className="sv-tier-ladder"
                                        role="group"
                                        aria-label="Hash power by tier. Selecting one filters your own knights."
                                    >
                                        {KNIGHTS_HASH_POWER.map((tier) => {
                                            const here = mine.filter((k) => k.rarity === tier.key).length;
                                            const active = bandFilter === tier.key;
                                            return (
                                                <button
                                                    key={tier.key}
                                                    type="button"
                                                    className={`sv-tier-row${active ? ' is-active' : ''}${here ? ' has-mine' : ''}`}
                                                    data-tier={tier.key}
                                                    aria-pressed={active}
                                                    aria-label={`${tier.name}: ${tier.hashPower} hash power, dropped ${(tier.dropRate * 100).toFixed(1)}% of the time, banking ${tier.hashPower} weight an hour while staked`}
                                                    onClick={() => setBandFilter(active ? null : tier.key)}
                                                >
                                                    <span className="sv-tier-name">
                                                        <span className="sv-tier-dot" style={{ background: tier.color }} aria-hidden="true" />
                                                        {tier.name}
                                                    </span>
                                                    <span className="sv-tier-bar" aria-hidden="true">
                                                        <span className="sv-tier-fill" style={{ width: `${tier.hashPower}%` }} />
                                                    </span>
                                                    <span className="sv-tier-hp sv-num">{tier.hashPower} HP</span>
                                                    {here > 0 && <span className="sv-tier-mine sv-num">{here}</span>}
                                                </button>
                                            );
                                        })}
                                    </div>
                                    <p className="sv-ladder-caption">
                                        {filterTier ? (
                                            <>Showing only <strong>{filterTier.name}</strong> below. Select it again to clear.</>
                                        ) : (
                                            <>
                                                The pool here is a <strong>fixed share of the weekly budget</strong>, and the
                                                collection has no supply limit — so the more Knights there are, the less each
                                                one earns, without a floor. At {fmtInt(KNIGHTS_REFERENCE_SIZE)} Knights a staked
                                                Knight earns{' '}
                                                <strong>{fmtPercent(knightsReferenceSize.ratioOfReference)}</strong> of the rate it
                                                earns while the population is at the reference, and half that at twice the size.
                                            </>
                                        )}
                                    </p>
                                </div>
                            )}

                            {/* The published distribution, drawn. The band counts *are* the promise
                                the collection is sold on, so the ladder is a picture of the
                                contract rather than decoration — and it doubles as the filter
                                for the lists below, which is what makes it worth a tap. */}
                            {!isKnights && (
                            <div className="sv-ladder" data-arya="ladder">
                                <div className="sv-ladder-head">
                                    <span className="sv-ladder-title">Power ladder</span>
                                    <span className="sv-ladder-rule sv-num">1 HP = 1 ticket / hour</span>
                                </div>
                                <div
                                    className="sv-ladder-bars"
                                    role="group"
                                    aria-label={`Hash power bands across the ${fmtInt(GENESIS_SUPPLY)} Genesis Knights. Selecting one filters your own knights.`}
                                >
                                    {HASH_POWER_BANDS.map((band) => {
                                        const here = mine.filter((k) => bandFor(k.hashPower)?.key === band.key).length;
                                        const active = bandFilter === band.key;
                                        return (
                                            <button
                                                key={band.key}
                                                type="button"
                                                className={`sv-band${active ? ' is-active' : ''}${here ? ' has-mine' : ''}`}
                                                data-band={band.key}
                                                aria-pressed={active}
                                                aria-label={`${band.name}: ${band.lo} to ${band.hi} hash power, ${band.count} of the ${fmtInt(GENESIS_SUPPLY)} knights, earning ${band.lo} to ${band.hi} tickets an hour`}
                                                onMouseEnter={() => setHoverBand(band)}
                                                onMouseLeave={() => setHoverBand(null)}
                                                onFocus={() => setHoverBand(band)}
                                                onBlur={() => setHoverBand(null)}
                                                onClick={() => setBandFilter(active ? null : band.key)}
                                            >
                                                <span className="sv-band-count sv-num" aria-hidden="true">{band.count}</span>
                                                <span className="sv-band-bar" aria-hidden="true">
                                                    <span
                                                        className="sv-band-fill"
                                                        style={{ height: `${Math.round((band.count / LADDER_TOP) * 100)}%` }}
                                                    />
                                                    {here > 0 && (
                                                        <span
                                                            className="sv-band-mine"
                                                            style={{ height: `${Math.max(10, Math.round((here / band.count) * 100))}%` }}
                                                        />
                                                    )}
                                                </span>
                                                <span className="sv-band-name" aria-hidden="true">{band.name.replace('Genesis ', '')}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                                <p className="sv-ladder-caption">
                                    {hoverBand ? (
                                        <>
                                            <strong>{hoverBand.name}</strong> · {hoverBand.lo}-{hoverBand.hi} HP ·{' '}
                                            {hoverBand.count} knights · {hoverBand.lo}-{hoverBand.hi} tickets/hour
                                            {mine.some((k) => bandFor(k.hashPower)?.key === hoverBand.key) && (
                                                <> · <strong>{mine.filter((k) => bandFor(k.hashPower)?.key === hoverBand.key).length} of yours</strong></>
                                            )}
                                        </>
                                    ) : filterBand ? (
                                        <>Showing only <strong>{filterBand.name}</strong> below. Select it again to clear.</>
                                    ) : (
                                        <>Select a band to filter your knights. The bars are how many of the {fmtInt(GENESIS_SUPPLY)} sit in each.</>
                                    )}
                                </p>
                            </div>
                            )}

                            {!connected ? (
                                <div className="sv-empty">
                                    <div className="sv-empty-title">The vault is closed</div>
                                    <div className="sv-empty-text">
                                        {isKnights
                                            ? `Connect a wallet to see your Knights and stake them for yield. No supply limit on this collection, and no draw on this side — that is Genesis territory.`
                                            : 'Connect a wallet to see your Genesis Knights, stake them, and enter the weekly draw.'}
                                    </div>
                                    <button
                                        className="btn btn-primary btn-md"
                                        onClick={handleConnect}
                                        disabled={!hasInjectedWallet() || busy === 'connect'}
                                    >
                                        {connectLabel}
                                    </button>
                                    {!hasInjectedWallet() && (
                                        <div className="sv-empty-text">
                                            No wallet in this browser. Install MetaMask (or any Web3 wallet) and reload.
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <>
                                    {since && !dismissedSince && (
                                        <div className="sv-banner is-good" role="status">
                                            <span>
                                                Since your last visit, {fmtHours(since.away / 3_600_000)} ago, your
                                                knights earned <strong className="sv-num">+{fmtInt(since.tickets)}</strong> tickets.
                                            </span>
                                            <button className="sv-banner-x" onClick={() => setDismissedSince(true)} aria-label="Dismiss">✕</button>
                                        </div>
                                    )}

                                    <div className="sv-summary">
                                        <div className="sv-summary-head">
                                            <div className="sv-summary-wallet">
                                                <span className="wallet-chip-dot" aria-hidden="true" />
                                                {shortAddress(live.wallet)}
                                            </div>
                                            {isPreview && <span className="sv-chip">Preview</span>}
                                        </div>
                                        <div className="sv-summary-grid">
                                            <div className="sv-summary-cell">
                                                <span className="sv-summary-label">Staked</span>
                                                <span className="sv-summary-value is-gold sv-num" aria-hidden="true">
                                                    {totals.stakedCount || 0} <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>/ {totals.ownedCount || 0}</span>
                                                </span>
                                            </div>
                                            <div className="sv-summary-cell">
                                                <span className="sv-summary-label">Total tickets</span>
                                                <span className="sv-summary-value is-gold sv-num" aria-hidden="true">{fmtInt(totals.myTickets)}</span>
                                            </div>
                                            <div className="sv-summary-cell">
                                                <span className="sv-summary-label">Pool share</span>
                                                <span className="sv-summary-value sv-num" aria-hidden="true">{fmtShare(totals.myShare)}</span>
                                            </div>
                                            <div className="sv-summary-cell">
                                                <span className="sv-summary-label">Claimable</span>
                                                <span className={`sv-summary-value sv-num ${poolDng === null ? '' : 'is-gold'}`} aria-hidden="true">
                                                    {poolDng === null ? 'TBD' : fmtDng(claimable)}
                                                </span>
                                            </div>
                                        </div>
                                        {/* The live line. It has to move every second or the vault looks
                                            idle, and while the pool is undecided the only honest thing
                                            that can move is the share of it. */}
                                        <p className="sv-accruing sv-num" aria-hidden="true">
                                            {poolDng === null
                                                ? <>Accruing now · {fmtSharePrecise(myAccruedShare)} of the pool</>
                                                : <>Accruing now · {fmtDng(claimable)}</>}
                                            {hourlyTickets > 0 && <> · {fmtInt(hourlyTickets)} {isKnights ? 'weight' : 'tickets'}/hour</>}
                                        </p>
                                    </div>

                                    <p className="sv-sr-only" aria-live="polite">{liveSummary}</p>

                                    {/* Ordering for the two lists. It only earns its space once
                                        there is more than one knight to order. */}
                                    {mine.length > 1 && (
                                        <div className="sv-controls">
                                            <span className="sv-controls-label">Sort</span>
                                            <div className="sv-seg" role="group" aria-label={`Sort your ${collectionLabel} knights`}>
                                                {SORTS.map((entry) => (
                                                    <button
                                                        key={entry.key}
                                                        type="button"
                                                        className="sv-seg-btn"
                                                        aria-pressed={sort === entry.key}
                                                        onClick={() => setSort(entry.key)}
                                                    >
                                                        {entry.label}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* The way out of a filter, and it deliberately lives *outside* the
                                        Sort row above. It used to sit inside that row, which only
                                        renders once there is more than one knight — so a wallet
                                        holding none or one could select a band, watch the list empty,
                                        and have nothing on screen to undo it. A filter with no way out
                                        is a trap regardless of how many knights are behind it, so the
                                        escape is not allowed to depend on the list it escaped from. */}
                                    {(filterBand || filterTier) && (
                                        <div className="sv-controls">
                                            <span className="sv-controls-label">Filter</span>
                                            <button
                                                type="button"
                                                className="sv-chip is-filter"
                                                onClick={() => setBandFilter(null)}
                                                title="Show every knight again"
                                            >
                                                {filterBand?.name || filterTier?.name} ✕
                                            </button>
                                        </div>
                                    )}

                                    {/* Unstaked first: the action a player most often wants is the
                                        one that is not possible from a list of staked knights. */}
                                    <div className="sv-bulk">
                                        <span className="sv-bulk-note">
                                            {owned.length
                                                ? `${owned.length} knight${owned.length === 1 ? '' : 's'} ready to stake`
                                                : staked.length
                                                    ? 'Every knight this wallet holds is staked'
                                                    : 'Nothing here to stake'}
                                        </span>
                                        {owned.length > 1 && (
                                            <button className="btn btn-secondary btn-sm" onClick={() => run('stakeAll')} disabled={!canWrite || !!busy}>
                                                Stake all
                                            </button>
                                        )}
                                    </div>

                                    {!owned.length && !staked.length && (
                                        <div className="sv-empty">
                                            <div className="sv-empty-title">No {collectionLabel} Knights</div>
                                            <div className="sv-empty-text">
                                                {isKnights
                                                    ? 'This wallet holds no Knights on this contract. Knights come out of capsules, opened in the Summoning Chamber.'
                                                    : `This wallet holds none of the ${fmtInt(GENESIS_SUPPLY)} Genesis Knights. Those are the only knights this side of the vault accepts.`}
                                            </div>
                                        </div>
                                    )}

                                    {!!filterBand && !shownStaked.length && !shownOwned.length && (
                                        <div className="sv-empty">
                                            <div className="sv-empty-title">No {filterBand.name} knights</div>
                                            <div className="sv-empty-text">
                                                None of your knights sit in the {filterBand.lo}–{filterBand.hi} HP band.
                                                Your {mine.length} knight{mine.length === 1 ? '' : 's'} are in other bands.
                                            </div>
                                        </div>
                                    )}

                                    {!!shownOwned.length && (
                                        <div className="sv-card-list">
                                            {shownOwned.map((knight) => (
                                                <GenesisCard
                                                    key={knight.tokenId}
                                                    knight={knight}
                                                    collection={collection}
                                                    simulated={simulated}
                                                    busy={busy}
                                                    canWrite={canWrite}
                                                    onStake={() => run('stake', { tokenId: knight.tokenId })}
                                                />
                                            ))}
                                        </div>
                                    )}

                                    {!!shownStaked.length && (
                                        <div className="sv-card-list">
                                            {shownStaked.map((knight) => (
                                                <GenesisCard
                                                    key={knight.tokenId}
                                                    knight={knight}
                                                    staked
                                                    collection={collection}
                                                    simulated={simulated}
                                                    busy={busy}
                                                    canWrite={canWrite}
                                                    nowMs={nowMs}
                                                    onClaim={() => run('claim', { tokenId: knight.tokenId })}
                                                    onUnstake={() => run('unstake', { tokenId: knight.tokenId })}
                                                    // The claim state travels into the card as well as the
                                                    // table. It did not once: the card's own Claim button
                                                    // ignored `claimDisabled`, so the button that is
                                                    // actually on screen offered a transaction the contract
                                                    // reverts ("Nothing to claim") while the table's copy
                                                    // was correctly disabled — the same action described
                                                    // two different ways on one page.
                                                    claimDisabled={claimDisabled}
                                                    claimTitle={claimTitle}
                                                />
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </aside>

                    {/* RIGHT — the numbers and the draw */}
                    <main className="side-panel sv-vault">
                        <div className="side-panel-header">
                            <img src="assets/ui/castle.png" className="panel-header-icon" alt="" />
                            Staking Vault
                        </div>
                        <div className="side-panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

                            <div className="sv-tiles" data-arya="tiles">
                                <div className="sv-tile">
                                    <span className="sv-tile-label">{isKnights ? 'Weekly yield pool' : 'Weekly pool'}</span>
                                    <span className="sv-tile-value sv-num" aria-hidden="true">
                                        {poolDng === null ? 'TBD' : poolDng.toLocaleString()}
                                    </span>
                                    <span className="sv-tile-sub">
                                        {poolDng === null
                                            ? 'Loading this week’s pool.'
                                            : isKnights
                                                ? 'The Knights staking line, split by staked weight.'
                                                : 'The Genesis staking line, split by ticket share.'}
                                    </span>
                                </div>
                                <div className="sv-tile">
                                    <span className="sv-tile-label">{isKnights ? 'Yield weight' : 'Capsules left'}</span>
                                    <span className="sv-tile-value sv-num" aria-hidden="true">
                                        {isKnights
                                            ? fmtInt(totals.hashPower)
                                            : pool.left === null
                                                // The contract does not publish how many of this week's
                                                // capsules have already been awarded, so on a
                                                // chain-backed vault this is a dash rather than a
                                                // repeating "200 left" that would be true only on
                                                // the first minute of the week.
                                                ? '—'
                                                : <>{pool.left} <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>/ {pool.capsulesPerWeek ?? CAPSULES_PER_WEEK}</span></>}
                                    </span>
                                    <span className="sv-tile-sub">
                                        {isKnights
                                            ? 'The weekly draw is Genesis-only — a capsule mints a Knight, so this side earns yield and nothing else.'
                                            : poolUnknown
                                                ? 'The ticket total this week’s share is measured against could not be read, so your odds are not shown rather than guessed.'
                                                : <>Your share of the draw: {fmtShare(totals.myShare)} → {fmtInt(totals.expectedCapsules)} expected</>}
                                    </span>
                                </div>
                                <div className={`sv-tile ${week.phase === 'pending' ? 'is-drawing' : ''} ${week.phase === 'final' ? 'is-final' : ''}`}>
                                    <span className="sv-tile-label">{isKnights ? 'Accruing now' : 'Next draw'}</span>
                                    <span className="sv-tile-row">
                                        {isKnights ? (
                                            <span className="sv-tile-value sv-num" aria-hidden="true">
                                                {claimable === null ? '—' : fmtDng(claimable)}
                                            </span>
                                        ) : (
                                        <>
                                        {/* The week, drawn: the ring fills from the last draw to
                                            the next one, so the countdown has a shape as well as
                                            a number. */}
                                        <svg className="sv-ring" viewBox="0 0 44 44" aria-hidden="true">
                                            <circle className="sv-ring-track" cx="22" cy="22" r="19" />
                                            <circle
                                                className="sv-ring-fill"
                                                cx="22"
                                                cy="22"
                                                r="19"
                                                transform="rotate(-90 22 22)"
                                                strokeDasharray={RING_C}
                                                strokeDashoffset={RING_C * (1 - weekProgress)}
                                            />
                                        </svg>
                                        <span className="sv-tile-value sv-num" aria-hidden="true">
                                            {/* A countdown needs a draw date, and there is none until a
                                                wallet loads the week. `0m 0s` would read as "drawing
                                                now", which is a claim this page cannot make. */}
                                            {week.drawAt ? fmtCountdown(countdownMs, week.phase) : '—'}
                                        </span>
                                        </>
                                        )}
                                    </span>
                                    <span className="sv-tile-sub">
                                        {isKnights
                                            ? 'Yield grows every second a Knight is staked, and it is claimable without unstaking.'
                                            : week.phase === 'pending'
                                                ? 'This week’s winners are being drawn.'
                                                : week.drawAt
                                                    ? `Week ${week.number} · Monday 00:00 UTC${week.phase === 'final' ? ' · final hour' : ''}`
                                                    : 'Connect a wallet to load this week’s draw'}
                                    </span>
                                </div>
                            </div>

                            {/* What the vault releases, and how it is split.

                                This panel used to be a slider labelled "if the weekly pool were" — it
                                existed because the pool was genuinely undecided. It is now derived from
                                the economy model the contracts are deployed from, so inviting a guess
                                would be less honest than showing the partition the vault enforces. */}
                            {economy && (
                                <div className="sv-econ" data-arya="economy">
                                    <div className="sv-econ-head">
                                        <span className="sv-econ-title">How the vault pays out</span>
                                        <span
                                            className="sv-econ-scale sv-num"
                                            title="Every published reward is the reference table multiplied by this. It only falls when participation outruns the budget, and one scale moves every number together — so the tier ratios and the 90% rule hold at whatever level is fundable."
                                        >
                                            SCALE ×{(economy.epochScale ?? 1).toFixed(2)}
                                        </span>
                                    </div>

                                    <div className="sv-econ-budget">
                                        <span className="sv-econ-budget-value sv-num">{fmtInt(economy.weeklyBudget)}</span>
                                        <span className="sv-econ-budget-unit">
                                            DNG released each week · {fmtInt(economy.dailyBudget)} a day
                                        </span>
                                    </div>

                                    <div className="sv-econ-lines">
                                        {ECONOMY_LINES.map((line) => {
                                            const share = economy.shares?.[line.key] ?? 0;
                                            const budget = economy.lineBudgets?.[line.key] ?? 0;
                                            return (
                                                <div
                                                    className="sv-econ-line"
                                                    key={line.key}
                                                    data-collection={line.collection}
                                                    data-active={line.collection === collection ? 'yes' : 'no'}
                                                >
                                                    <span className="sv-econ-line-label">{line.label}</span>
                                                    <span className="sv-econ-line-bar" aria-hidden="true">
                                                        <span className="sv-econ-line-fill" style={{ width: `${(share * 100).toFixed(1)}%` }} />
                                                    </span>
                                                    <span className="sv-econ-line-share sv-num">{(share * 100).toFixed(1)}%</span>
                                                    <span className="sv-econ-line-dng sv-num">{fmtInt(budget)}</span>
                                                </div>
                                            );
                                        })}
                                    </div>

                                    <dl className="sv-econ-facts">
                                        <div>
                                            <dt>Staking vs playing</dt>
                                            <dd>
                                                <strong className="sv-num">{Math.round((economy.stakingShareOfDungeon ?? 0) * 100)}%</strong> of
                                                dungeon income, per collection
                                            </dd>
                                        </div>
                                        <div>
                                            <dt>Vault horizon</dt>
                                            <dd>
                                                <strong className="sv-num">
                                                    {economy.horizonDays ? (economy.horizonDays / 365.25).toFixed(1) : '—'} years
                                                </strong>{` `}
                                                at the reference · {fmtInt(economy.rewardVaultDng)} DNG held
                                            </dd>
                                        </div>
                                        <div>
                                            <dt>If everyone played</dt>
                                            <dd>
                                                <strong className="sv-num">{fmtInt(economy.worstCaseHorizonDays)} days</strong>, scale falling
                                                to ×{(economy.worstCaseScale ?? 0).toFixed(2)}
                                            </dd>
                                        </div>
                                        <div>
                                            <dt>Capsule open</dt>
                                            <dd>
                                                <strong className="sv-num">{fmtInt(economy.capsuleOpenPriceAtZero)} DNG</strong> rising to{` `}
                                                {fmtInt(economy.capsuleOpenPriceAtReference)} at {fmtInt(economy.knightsReferenceSize)} Knights
                                            </dd>
                                        </div>
                                    </dl>

                                    <p className="sv-econ-fine">
                                        The published table is sized for {fmtInt(economy.reference?.genesisActive)} Genesis and{` `}
                                        {fmtInt(economy.reference?.knightsActive)} Knights playing daily — about{` `}
                                        {Math.round((((economy.reference?.utilisation?.genesis ?? 0)
                                            + (economy.reference?.utilisation?.knights ?? 0)) / 2) * 100)}% of each
                                        collection. Past that, one scale moves every figure down together, so the tier
                                        ratios and the staking rule survive. The budget is capped at the vault balance
                                        ÷ {fmtInt(economy.minWeeks)} weeks, so it can never promise more than it holds.
                                    </p>
                                </div>
                            )}

                            <div className="sv-tabs" role="tablist" aria-label="Staking views" data-arya="tabs" onKeyDown={onTabKeyDown}>
                                {TABS.map((entry) => {
                                    const count = entry.key === 'staked' ? staked.length
                                        : entry.key === 'raffle' ? (live?.entries?.length || 0)
                                            : (live?.capsules || []).reduce((sum, c) => sum + c.count, 0);
                                    return (
                                        <button
                                            key={entry.key}
                                            ref={(el) => { tabRefs.current[entry.key] = el; }}
                                            className="sv-tab"
                                            role="tab"
                                            data-key={entry.key}
                                            id={`sv-tab-${entry.key}`}
                                            aria-selected={tab === entry.key}
                                            aria-controls={`sv-panel-${entry.key}`}
                                            tabIndex={tab === entry.key ? 0 : -1}
                                            onClick={() => selectTab(entry.key)}
                                        >
                                            {entry.label}
                                            {count > 0 && <span className="sv-tab-count">{count}</span>}
                                        </button>
                                    );
                                })}
                            </div>

                            {/* Every panel is rendered and the inactive two are hidden. Rendering
                                only the active one would leave the other tabs' `aria-controls`
                                pointing at nothing. */}
                            <section className="sv-panel" id="sv-panel-staked" role="tabpanel" aria-labelledby="sv-tab-staked" hidden={tab !== 'staked'}>
                                    {!staked.length ? (
                                        <div className="sv-empty">
                                            <div className="sv-empty-title">Nothing staked yet</div>
                                            <div className="sv-empty-text">
                                                {isKnights
                                                    ? `Stake a Knight and one thing starts: a share of the weekly yield pool that grows every second. There is no draw on this side — that is Genesis territory. ${realWrites ? 'Staking is a transaction, so you approve the vault once and then stake.' : 'Staking here is a simulation, so nothing you press reaches the chain.'}`
                                                    : `Stake a Genesis Knight and two things start at once: tickets for the weekly draw, and a share of the weekly DNG pool that grows every second. ${realWrites ? 'Staking is a transaction — you approve the vault once, then stake.' : 'Staking here is a simulation, so nothing you press reaches the chain.'}`}
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="sv-rows">
                                                <div className="sv-row sv-row-head">
                                                    <span>Knight</span>
                                                    <span className="sv-col-hide-narrow">Power</span>                                                            <span className="sv-col-hide-narrow">{isKnights ? 'Weight' : 'Tickets'}</span>
                                                    <span>Accrued share</span>
                                                    <span />
                                                </div>
                                                {staked.map((knight) => (
                                                    <div className="sv-row" key={knight.tokenId}>
                                                        <span className="sv-row-name">
                                                            <span className="sv-art" data-rarity={knight.rarity || 'genesis'} aria-hidden="true">
                                                                {knightPortrait(knight, isKnights)
                                                                    ? <img src={knightPortrait(knight, isKnights)} alt="" />
                                                                    : <span className="sv-art-glyph">✦</span>}
                                                            </span>
                                                            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                                                {knight.name}
                                                                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                                                                    staked {fmtHours((nowMs - knight.stakedAt) / 3_600_000)}
                                                                </span>
                                                            </span>
                                                        </span>
                                                        <span className="sv-row-num sv-col-hide-narrow">{knight.hashPower} HP</span>
                                                        <span className="sv-row-num sv-col-hide-narrow">{fmtInt(knight.tickets)}</span>
                                                        <span className="sv-row-num is-gold sv-num" aria-hidden="true">
                                                            {fmtShare(knight.accruedShare)}
                                                            {/* A real stake has no per-knight DNG to show, because the contract
                                                                publishes only the wallet's total — so the share stands alone
                                                                rather than being followed by a figure the pool cannot pay. */}
                                                            {knight.accruedDng !== null && knight.accruedDng !== undefined
                                                                && ` · ${fmtDng(knight.accruedDng)}`}
                                                        </span>
                                                        <span className="sv-row-actions">
                                                            <button
                                                                className="btn btn-secondary btn-sm"
                                                                onClick={() => run('claim', { tokenId: knight.tokenId })}
                                                                disabled={!canWrite || !!busy || claimDisabled}
                                                                title={claimTitle}
                                                            >
                                                                Claim
                                                            </button>
                                                            <button
                                                                className="btn btn-danger btn-sm"
                                                                onClick={() => run('unstake', { tokenId: knight.tokenId })}
                                                                disabled={!canWrite || !!busy}
                                                                title="Return the knight to your wallet. Its tickets are forfeited."
                                                            >
                                                                Unstake
                                                            </button>
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                            <p className="sv-summary-label">
                                                Tickets cap at {live?.limits?.capHours || 168} hours of staking. Unstaking forfeits
                                                the tickets that knight earned.
                                            </p>
                                        </>
                                    )}
                            </section>

                            <section className="sv-panel" id="sv-panel-raffle" role="tabpanel" aria-labelledby="sv-tab-raffle" hidden={tab !== 'raffle'}>
                                {isKnights ? (
                                    /* The refusal is a panel rather than a hidden tab: the tab stays
                                       visible and selectable so this is *findable*, and the reason
                                       is the most useful thing on the page for a Knights holder
                                       who is looking for a draw they were never in. */
                                    <div className="sv-empty" data-state="raffle-genesis-only">
                                        <div className="sv-empty-title">The weekly draw is Genesis-only</div>
                                        <div className="sv-empty-text">
                                            Its prize is a capsule, and a capsule mints a Knight — so a Knights stake
                                            entering it would be paid twice from the same faucet. This side stakes for{' '}
                                            <strong>yield</strong> instead: {fmtInt(poolDng || 0)} DNG a week at the reference,
                                            split by staked weight, claimable without unstaking.
                                        </div>
                                        <button className="btn btn-primary btn-md" onClick={() => selectCollection('genesis')}>
                                            Stake a Genesis Knight instead
                                        </button>
                                    </div>
                                ) : (
                                    <>
                                    <div className="sv-bulk">
                                        <span className="sv-bulk-note">
                                            {entriesAutomatic
                                                ? `Entered by staking · ${fmtInt(totals.myTickets)} tickets this week${poolUnknown ? ' · the pool total could not be read, so no odds are shown' : ''}`
                                                : live?.entries?.length
                                                    ? `${live.entries.length} of ${staked.length} knights entered · ${fmtInt(totals.myTickets)} tickets`
                                                    : 'No knights entered in this week’s draw'}
                                        </span>
                                        {/* Two controls that only exist where entering is something a wallet can do.
                                            On chain, tickets accrue to the stake and the draw reads the ledger — so the
                                            pair is replaced by the sentence above rather than left to send a
                                            transaction that has no contract behind it. */}
                                        {!entriesAutomatic && (
                                            <>
                                                <button className="btn btn-primary btn-sm" onClick={() => run('enterAll')} disabled={!canWrite || !!busy || !staked.length}>
                                                    Enter all
                                                </button>
                                                <button className="btn btn-secondary btn-sm" onClick={() => run('withdrawAll')} disabled={!canWrite || !!busy || !live?.entries?.length}>
                                                    Withdraw all
                                                </button>
                                            </>
                                        )}
                                    </div>

                                    {!staked.length ? (
                                        <div className="sv-empty">
                                            <div className="sv-empty-title">The draw needs a staked knight</div>
                                            <div className="sv-empty-text">
                                                Tickets are earned by staking, and only staked knights can hold an entry.
                                                Stake one first and it can enter the next draw.
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="sv-rows">
                                            <div className="sv-row sv-row-head">
                                                <span>Knight</span>
                                                <span className="sv-col-hide-narrow">Power</span>
                                                <span className="sv-col-hide-narrow">{isKnights ? 'Weight' : 'Tickets'}</span>
                                                <span>Expected</span>
                                                <span />
                                            </div>
                                            {staked.map((knight) => {
                                                const expected = totals.totalTickets
                                                    ? (knight.tickets / totals.totalTickets) * CAPSULES_PER_WEEK
                                                    : null;
                                                return (
                                                    <div className="sv-row" key={knight.tokenId}>
                                                        <span className="sv-row-name">
                                                            {knight.name}
                                                            {(knight.entered || entriesAutomatic) && <span className="sv-chip is-in">In draw</span>}
                                                        </span>
                                                        <span className="sv-row-num sv-col-hide-narrow">{knight.hashPower} HP</span>
                                                        <span className="sv-row-num sv-col-hide-narrow">{fmtInt(knight.tickets)}</span>
                                                        <span className="sv-row-num is-gold" title="Expected capsules if the draw were held now">
                                                            {expected === null ? '—' : expected.toFixed(1)}
                                                        </span>
                                                        <span className="sv-row-actions">
                                                            {/* Where the tickets are a ledger the draw reads, there is no
                                                                entry to make: the stake *is* the entry, and offering a button
                                                                would invent a mechanism no contract has. */}
                                                            {entriesAutomatic ? (
                                                                <span className="sv-chip is-in" title="On chain the ticket ledger is the entry — your staked knights are in this week's draw by staking, with no transaction to send.">
                                                                    In draw
                                                                </span>
                                                            ) : knight.entered ? (
                                                                <button className="btn btn-secondary btn-sm" onClick={() => run('withdrawRaffle', { tokenId: knight.tokenId })} disabled={!canWrite || !!busy}>
                                                                    Withdraw
                                                                </button>
                                                            ) : (
                                                                <button className="btn btn-primary btn-sm" onClick={() => run('enterRaffle', { tokenId: knight.tokenId })} disabled={!canWrite || !!busy}>
                                                                    Enter
                                                                </button>
                                                            )}
                                                        </span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}

                                    <div className="panel-section-title">
                                        THIS WEEK&rsquo;S BOARD · {poolUnknown ? 'POOL TOTAL NOT READ' : `${fmtInt(pool.totalTickets)} TICKETS`}
                                    </div>
                                    <div className="sv-rows">
                                        <div className="sv-board-row sv-row-head">
                                            <span>#</span>
                                            <span>Player</span>
                                            <span>Tickets</span>
                                            <span>Share</span>
                                        </div>
                                        {connected && (
                                            <div className="sv-board-row is-me">
                                                <span className="sv-board-rank">—</span>
                                                <span style={{ fontWeight: 600 }}>
                                                    {shortAddress(live.wallet)} <span className="sv-chip is-in">You</span>
                                                </span>
                                                <span className="sv-row-num is-gold">{fmtInt(totals.myTickets)}</span>
                                                <span className="sv-row-num is-gold">{fmtShare(totals.myShare)}</span>
                                            </div>
                                        )}
                                        {(live?.board || []).map((row, index) => (
                                            <div className="sv-board-row" key={row.address}>
                                                <span className="sv-board-rank">{index + 1}</span>
                                                <span>{row.short}</span>
                                                <span className="sv-row-num">{fmtInt(row.tickets)}</span>
                                                <span className="sv-row-num">
                                                    {fmtShare(pool.totalTickets ? row.tickets / pool.totalTickets : 0)}
                                                </span>
                                            </div>
                                        ))}
                                        {!(live?.board || []).length && (
                                            <div className="sv-board-row">
                                                <span className="sv-board-rank">—</span>
                                                <span style={{ color: 'var(--text-muted)' }}>No other entries yet</span>
                                                <span /><span />
                                            </div>
                                        )}
                                    </div>

                                    <div className="panel-section-title">
                                        PAST DRAWS
                                    </div>
                                    <div className="sv-rows">
                                        {(live?.history || []).map((row) => (
                                            <div className="sv-board-row" key={row.week}>
                                                <span className="sv-board-rank">W{row.week}</span>
                                                <span>{row.short}</span>
                                                <span className="sv-row-num is-gold">{row.capsules} capsules</span>
                                                <span className="sv-row-num">{fmtInt(row.tickets)} tickets</span>
                                            </div>
                                        ))}
                                    </div>
                                    <p className="sv-summary-label">
                                        The draw takes 200 winning ticket numbers from the whole pool and awards one
                                        capsule each. With few knights staked, one entry can take most of a week.
                                    </p>
                                    </>
                                )}
                            </section>

                            <section className="sv-panel" id="sv-panel-capsules" role="tabpanel" aria-labelledby="sv-tab-capsules" hidden={tab !== 'capsules'}>
                                {isKnights ? (
                                    <div className="sv-empty" data-state="capsules-genesis-only">
                                        <div className="sv-empty-title">Capsules are the Genesis draw&rsquo;s prize</div>
                                        <div className="sv-empty-text">
                                            A capsule is awarded to a staked Genesis Knight and opened in the Summoning
                                            Chamber, where it mints a Knight. This side of the vault is where those
                                            Knights come to earn — {fmtInt(poolDng || 0)} DNG a week, split by staked
                                            weight.
                                        </div>
                                        <button className="btn btn-secondary btn-md" onClick={() => { window.location.href = '/mint'; }}>
                                            Open capsules in the Summoning Chamber
                                        </button>
                                    </div>
                                ) : (
                                    <>
                                    <p className="sv-summary-label">
                                        Capsules are won in the draw and opened in the Summoning Chamber, where the
                                        knight inside is revealed. These are the published tables: every outcome is a tier
                                        the reward contracts pay, and each sums to exactly 100.
                                    </p>
                                    <div className="sv-capsule-grid">
                                        {(live?.capsules || []).map((capsule) => (
                                            <div className={`sv-capsule ${capsule.count ? '' : 'is-empty'}`} key={capsule.key}>
                                                <div className="sv-capsule-head">
                                                    <span className="sv-art" data-rarity={capsule.rarity} aria-hidden="true">
                                                        <span className="sv-art-glyph">◆</span>
                                                    </span>
                                                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                                                        <span className="sv-card-name" style={{ fontSize: 12 }}>{capsule.name}</span>
                                                        <span className="sv-card-meta">{capsule.count ? `${capsule.count} owned` : 'none yet'}</span>
                                                    </span>
                                                    <span className="sv-capsule-count sv-num" aria-hidden="true">{capsule.count}</span>
                                                </div>
                                                <div className="sv-odds">
                                                    {capsule.odds.map((row) => (
                                                        <div className="sv-odds-row" key={row.rarity}>
                                                            <span>{row.rarity}</span>
                                                            <span>{row.pct}%</span>
                                                        </div>
                                                    ))}
                                                </div>
                                                <button
                                                    className="btn btn-primary btn-sm w-full"
                                                    disabled={!capsule.count || !canWrite || !!busy}
                                                    onClick={() => run('openCapsule', { key: capsule.key })}
                                                >
                                                    Open capsule
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                    </>
                                )}
                            </section>

                            {/* The reason a control might not do what it looks like it does. It
                                fires for two different situations and they must not read the same:
                                a simulated stake (the button works, nothing reaches the chain) and
                                an inert side (the button is disabled). */}
                            {(simulated || (!canWrite && connected)) && live.writeBlockedReason && (
                                <div className={`sv-banner${simulated ? ' is-sim' : ''}`}>
                                    <span>{live.writeBlockedReason}</span>
                                </div>
                            )}
                        </div>
                    </main>
                </div>

                <footer className="sv-footer" data-arya="footer">
                    <span className="sv-footer-note">
                        {connected
                            ? `Week ${week.number} · ${staked.length} staked · draw Monday 00:00 UTC`
                            : 'Connect a wallet to stake Genesis Knights and enter the weekly draw'}
                    </span>
                    <button className="btn btn-ghost btn-sm sv-arya-btn" onClick={askArya}>
                        <span className="sv-arya-mark" aria-hidden="true">?</span> Ask Arya
                    </button>
                </footer>
            </div>

            {error && (
                <div className="sv-banner is-error sv-banner-float" role="alert">
                    <span>{error}</span>
                    <button className="sv-banner-x" onClick={() => setError(null)} aria-label="Dismiss">✕</button>
                </div>
            )}
            {notice && <div className="sv-banner sv-banner-float" role="status"><span>{notice}</span></div>}
        </>
    );
}

/**
 * One Genesis Knight.
 *
 * `staked` decides whether it is showing what the knight is earning or what it could
 * earn, and the staked face is the one with live numbers on it.
 */
function GenesisCard({
    knight, staked = false, busy, canWrite, simulated = false, nowMs,
    onStake, onClaim, onUnstake, collection = 'genesis',
    claimDisabled = false, claimTitle = null,
}) {
    // The card is the same card on both sides — a stake is a stake — but what the hours
    // *bank* is not: Genesis banks tickets into the weekly draw, Knights bank weight into
    // the yield split. Naming it correctly is the difference between a number and a promise.
    const unit = collection === 'knights' ? 'weight' : 'tickets';
    const isKnightsCard = collection === 'knights';
    const hours = staked ? (nowMs - knight.stakedAt) / 3_600_000 : 0;
    // The bar measures position inside the **collection's own** published range, not the raw
    // number. Both halves matter: a raw value pegs the bar full for every Genesis knight, and
    // the other collection's range pegs it empty for every Knight.
    const powerMin = isKnightsCard ? KNIGHTS_HP_MIN : HASH_POWER_MIN;
    const powerMax = isKnightsCard ? KNIGHTS_HP_MAX : HASH_POWER_MAX;
    const powerPct = Math.min(100, Math.max(0,
        (((knight.hashPower || 0) - powerMin) / (powerMax - powerMin)) * 100));
    // The label is the honest one for the collection. Genesis publishes *bands* — checkable, and
    // the thing its staking is priced on — while a Knight is labelled by the **tier** it was
    // minted at, which is what its hash power comes from. `bandFor` returns nothing for 15–100,
    // so using it on both sides left every real Knight wearing no label at all.
    const band = isKnightsCard ? null : bandFor(knight.hashPower);
    const tierLabel = isKnightsCard ? (knight.tierName || null) : null;
    const portrait = knightPortrait(knight, isKnightsCard);
    const rate = ticketsPerHour(knight.hashPower);
    const capped = hours >= TICKET_CAP_HOURS;
    const capPct = Math.min(100, (hours / TICKET_CAP_HOURS) * 100);

    return (
        <div className={`sv-card ${staked ? 'is-staked' : ''}`} data-band={band?.key}>
            <div className="sv-card-head">
                <span className="sv-art" data-band={band?.key} data-rarity={knight.rarity || 'genesis'} aria-hidden="true">
                    {portrait ? <img src={portrait} alt="" /> : <span className="sv-art-glyph">✦</span>}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="sv-card-name">{knight.name}</span>
                    <span className="sv-card-meta">
                        <span className="sv-power" style={{ flex: 1 }}>
                            <span className="sv-power-track" aria-hidden="true">
                                <span className="sv-power-fill" style={{ width: `${powerPct}%` }} />
                            </span>
                            <span className="sv-num">{knight.hashPower} HP</span>
                        </span>
                        {band && <span className="sv-chip" data-band={band.key}>{band.name}</span>}
                        {tierLabel && <span className="sv-chip is-tier" data-tier={knight.rarity}>{tierLabel}</span>}
                        {staked && knight.entered && <span className="sv-chip is-in">In draw</span>}
                        {staked && simulated && (
                            <span className="sv-chip is-sim" title="No staking contract is deployed — this stake is a simulation and nothing was sent to the chain.">
                                Simulated
                            </span>
                        )}
                    </span>
                </span>
            </div>

            {staked && (
                <div className="sv-card-stats">
                    <span className="sv-stat">
                        <span className="sv-stat-label">Staked for</span>
                        <span className="sv-stat-value sv-num" aria-hidden="true">{fmtHours(hours)}</span>
                    </span>
                    <span className="sv-stat">
                        {/* The label follows the unit the two sides actually bank. It read
                            "Tickets" on a Knights card, where the number is yield weight — a
                            staked Knight earns no tickets at all, because the draw is Genesis's. */}
                        <span className="sv-stat-label">{unit === 'weight' ? 'Weight' : 'Tickets'}</span>
                        <span className="sv-stat-value is-gold sv-num" aria-hidden="true">{fmtInt(knight.tickets)}</span>
                    </span>
                    <span className="sv-stat">
                        <span className="sv-stat-label">Accruing</span>
                        <span className="sv-stat-value is-gold sv-num" aria-hidden="true">
                            {knight.accruedDng === null
                                ? fmtSharePrecise(knight.accruedShare)
                                : fmtDng(knight.accruedDng)}
                        </span>
                    </span>
                </div>
            )}

            {/* Tickets are time, and the cap is the one deadline a staker has to plan
                around — so it is drawn rather than implied. */}
            {staked && (
                <div className="sv-cap" title={`A staked knight banks ${unit} for ${TICKET_CAP_HOURS} hours, then stops until it is restaked`}>
                    <span className="sv-cap-track" aria-hidden="true">
                        <span className={`sv-cap-fill${capped ? ' is-capped' : ''}`} style={{ width: `${capPct}%` }} />
                    </span>
                    <span className="sv-cap-note sv-num" aria-hidden="true">
                        {capped
                            ? `${fmtInt(rate)} ${unit}/hour · cap reached, no more bank`
                            : `${fmtInt(rate)} ${unit}/hour · ${fmtInt(TICKET_CAP_HOURS - hours)}h left`}
                    </span>
                </div>
            )}

            <div className="sv-card-actions">
                {staked ? (
                    <>
                        <button
                            className="btn btn-secondary btn-sm"
                            onClick={onClaim}
                            disabled={!canWrite || !!busy || claimDisabled}
                            title={claimTitle || undefined}
                        >
                            Claim
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={onUnstake} disabled={!canWrite || !!busy}>Unstake</button>
                    </>
                ) : (
                    <button className="btn btn-primary btn-sm" onClick={onStake} disabled={!canWrite || !!busy}>
                        {busy === 'stake' ? 'Staking…' : 'Stake'}
                    </button>
                )}
            </div>
        </div>
    );
}
