// Privy sign-in, ALONGSIDE the injected extension — not instead of it.
//
// Both paths end at walletFromProvider() and produce the same
// { address, walletClient }, so nothing downstream knows or cares which one the
// user took. Publishers keep their funded MetaMask; buyers get email/social with
// an embedded wallet.
//
// Buyers need no gas: src/pay/buy.js only signs (stealth identity + EIP-3009) and
// the facilitator submits, so a brand-new embedded wallet with 0 ETH completes a
// purchase. A publisher signing in this way still has to fund the address before
// createResource/commitStateRoot will land — that's a chain fact, not something
// the login method changes.
//
// ponytail: the whole thing is opt-in on VITE_PRIVY_APP_ID. Unset → no provider
// is mounted, no hook runs, and the app is exactly what it was before. That's
// also what keeps `usePrivy()` from ever being called outside a provider, which
// throws.

import React, { useEffect } from "react";
import { PrivyProvider, usePrivy, useWallets } from "@privy-io/react-auth";
import { arbitrumSepolia } from "viem/chains";
import { walletFromProvider } from "../pay/wallet.js";

// Written as a literal so vite inlines it — see requireInlinedEnv in vite.config.js.
export const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID ?? "";
export const privyEnabled = !!PRIVY_APP_ID;

/**
 * Mounts the provider only when configured, so an unset app id is a no-op.
 *
 * `loginMethods` is a prop because the Telegram Mini App entry needs a different
 * set — inside Telegram's in-app browser Privy supports only email, SMS and
 * embedded wallets, so "google" and "wallet" are dead options there. Everything
 * else about the provider (the chain, the embedded-wallet policy) must NOT
 * differ between entries: the same person signing from the web app and from the
 * bot has to land on the same wallet, and that is decided here.
 */
export function PrivyRoot({ children, loginMethods = ["email", "google", "wallet"] }) {
    if (!privyEnabled) return children;
    return (
        <PrivyProvider
            appId={PRIVY_APP_ID}
            config={{
                // One chain, the one everything else is deployed on. Without this
                // the embedded wallet lands on mainnet and every switch prompt in
                // walletFromProvider fails.
                defaultChain: arbitrumSepolia,
                supportedChains: [arbitrumSepolia],
                // Email/social users get a wallet without ever hearing the word.
                // Someone arriving with MetaMask keeps using MetaMask.
                // v3 nests this per chain — a top-level `createOnLogin` is
                // silently ignored and defaults to "off", which leaves email
                // users with no wallet and so no way to pay.
                embeddedWallets: {
                    ethereum: { createOnLogin: "users-without-wallets" },
                    showWalletUIs: false,
                },
                loginMethods,
            }}
        >
            {children}
        </PrivyProvider>
    );
}

/**
 * The header button. Hands the resulting wallet up via `onWallet` so App keeps
 * owning wallet state — there is exactly one `wallet` in the app whichever way
 * it was obtained.
 */
function PrivyButton({ wallet, onWallet, onLogout, onError }) {
    const { ready, authenticated, login, logout } = usePrivy();
    const { wallets } = useWallets();

    // Prefer the embedded wallet: if someone linked MetaMask through Privy AND
    // has an embedded one, the embedded one is the account Privy will actually
    // sign with by default.
    const active = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];

    useEffect(() => {
        if (!authenticated || !active) return;
        // Already holding this address — don't rebuild the client on every render.
        if (wallet?.address?.toLowerCase() === active.address.toLowerCase()) return;
        let stale = false;
        (async () => {
            try {
                const provider = await active.getEthereumProvider();
                const w = await walletFromProvider(provider, active.address);
                if (!stale) onWallet(w);
            } catch (e) { if (!stale) onError(e.message); }
        })();
        return () => { stale = true; };
    }, [authenticated, active?.address]);

    if (!ready) return null;
    if (authenticated) {
        // Logging out has to drop the app's wallet AND the relay's staging session
        // together. Leaving the walletClient behind means the next signature
        // prompt comes from an account the user just left; leaving the relay
        // session behind means their staging library stays open to the tab.
        return <button className="ghost" onClick={() => { logout(); onLogout(); }}>Log out</button>;
    }
    return <button className="primary" onClick={login}>Sign in with email</button>;
}

/** Renders nothing when Privy isn't configured. */
export const PrivyLogin = (props) => (privyEnabled ? <PrivyButton {...props} /> : null);
