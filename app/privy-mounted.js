'use client';

import Providers from './providers';
import PrivyBridge from './privy-bridge';

/**
 * Privy, mounted, in one piece.
 *
 * This exists so `privy-gate.js` can reach the whole SDK through a single dynamic import. The App
 * ID still arrives from the server — `app/layout.js` reads `PRIVY_APP_ID` and passes it down — so
 * nothing about the "one value, read on the server, never `NEXT_PUBLIC_`" decision changes. Only the
 * *timing* of the import moves, and only on the routes listed in the gate.
 *
 * Both halves are here rather than in the gate because they have to be inside the same dynamic chunk:
 * the bridge's hooks are only legal beneath the provider, and splitting them across a boundary is
 * how you get a provider that mounts in one tick and a bridge that looks for it in the last.
 */
export default function PrivyMounted({ appId, children }) {
    return (
        <Providers appId={appId}>
            <PrivyBridge />
            {children}
        </Providers>
    );
}
