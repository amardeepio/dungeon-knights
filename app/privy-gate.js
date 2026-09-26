'use client';

import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';

/**
 * Routes whose markup never asks for a wallet.
 *
 * A route belongs here only if nothing it serves reaches for `window.privyBridge`, `window.DKWallet`
 * or `wallet-source.js`. That is checkable rather than a judgement call, and the check is worth
 * redoing whenever a route is added here:
 *
 *   node -e "import('./lib/static-pages.js').then(m=>Object.entries(m.STATIC_PAGES)
 *     .forEach(([k,v])=>console.log(k, (v.scripts||[]).some(s=>s.includes('wallet-source')))))"
 *
 * `home` is the only entry that comes back `false`. The React routes are checked the same way, by
 * grepping their client for `<Script src="/wallet-source.js`. The apex is a coming-soon page whose
 * two links go to `/points` and `/genesis`, so it signs nobody in and asks for nothing.
 *
 * The failure mode this avoids is not a crash: `wallet-source.js` falls back to an injected
 * extension when no bridge appears. It is 19 MB of `@privy-io` plus the `viem` and `ethers` behind
 * it, downloaded and parsed by a visitor who will never see a wallet modal.
 */
const NO_WALLET_ROUTES = new Set(['/']);

/**
 * The SDK, in a chunk the routes above never fetch.
 *
 * `next/dynamic` rather than a static import, because a static import in the root layout is an edge
 * from *every* route to the whole SDK: the apex would keep it in its module graph, which is the
 * 12,000-module dev compile and the ~100 kB First Load JS on a page with two links in it.
 *
 * No `ssr: false`. The provider is server-rendered on the routes that use it, exactly as it was when
 * this was a static import in the layout — a wallet route must not lose its provider for a tick while
 * a chunk loads, because the game boots on `DOMContentLoaded` and asks for a wallet straight away.
 * The apex is excluded by returning `children` on both the server and the client pass, so it never
 * requests the chunk at all rather than requesting it and hiding it.
 */
const PrivyMounted = dynamic(() => import('./privy-mounted'), {
    loading: () => null,
});

export default function PrivyGate({ appId, children }) {
    const pathname = usePathname();

    // The same dormancy `providers.js` documents, decided here instead: with no App ID there is no
    // provider, so rendering the bridge would call `useWallets` and friends with nothing above them.
    // That was the source of a `useWallets was called outside the PrivyProvider component` warning on
    // every page load in local development.
    if (!appId) return children;
    if (NO_WALLET_ROUTES.has(pathname)) return children;

    return <PrivyMounted appId={appId}>{children}</PrivyMounted>;
}
