# SWIRL Protocol

Non-custodial private native-asset and ERC-20 transfers using Groth16 proofs and `swirl1…` addresses.

## Components

- `apps/extension` — SWIRL Wallet browser extension and dApp bridge.
- `apps/web` — browser development and verification interface.
- `packages/wallet` — keys, encrypted notes, Merkle recovery and proof generation.
- `packages/contracts` — shared-vault contracts, native gateway and circuit sources.
- `packages/relay` — independently operated transaction Relayer with dynamic Gas quotes.
- `packages/indexer` — incremental event indexer with reorganization handling.
- `packages/poi` — independent Pre-Transaction and confirmed-transaction POI node.

## Implemented

- BIP39 recovery, separate spending/viewing keys and Bech32m `swirl1` addresses.
- Poseidon notes, a shared incremental Merkle tree and secret-derived nullifiers.
- Up-to-two-input/four-output Groth16 transactions with amount, token, chain, recipient and ciphertext binding.
- XChaCha20-Poly1305 note encryption with fresh ephemeral keys.
- Native assets and ERC-20 tokens in a shared vault; native gateway support and double-spend rejection.
- Shield, private Transfer, Unshield, direct submission and third-party Relay submission.
- Password-encrypted browser storage, viewing-key export and recovery without SWIRL services.
- Pre-Transaction POI validation and confirmed-transaction POI proofs.
- Fixed network profiles; Ethereum and Sepolia can load packaged public deployment configuration.

## Verify

Requires Node.js 20 or later.

```bash
npm install
npm test
npm run build
```

Additional local verification:

```bash
npm run verify:ui
npm run test:e2e
npm run verify:extension
npm run test:e2e:extension
npm run test:e2e:poi
npm run test:dapp:extension
```

The E2E scripts start isolated local services, deploy fresh contracts, exercise real proofs and stop their processes afterward. Browser scripts currently locate Microsoft Edge at its standard Windows installation path.

## Browser extension

```bash
npm run build -w @swirl/extension
```

Open `chrome://extensions` or `edge://extensions`, enable Developer mode, choose **Load unpacked**, and select `apps/extension/dist`.

The recovery phrase is the ultimate backup. The wallet supports creation, import, lock/unlock, encrypted persistence, public and private portfolios, Shield, public transfer, private Transfer and Unshield. No custom RPC or custom contract input is exposed.

## Independent services

Each service has its own source directory and environment template where applicable.

- Relayer: `packages/relay`; default listener `127.0.0.1:8787`.
- Indexer: `packages/indexer`; default listener `127.0.0.1:8788`.
- PPOI: `packages/poi`; default listener `127.0.0.1:8790`; see `.env.example`.

Never commit private keys, API credentials, server environment files or deployment state. Use dedicated service accounts and reviewed HTTPS reverse proxies.

## Deployment

`packages/contracts/scripts/deploy-production.ts` validates asset addresses, contract code, decimals, chain confirmation and trusted-setup identification. Start from `packages/contracts/.env.example`.

Public deployment JSON contains contract addresses and public service configuration only. Local deployment outputs, server configuration and proving build artifacts are intentionally excluded from source control.

## Security notes

- The included trusted setup is a single-contributor development setup. Use a public multi-party ceremony before valuable-asset deployment.
- No system provides absolute anonymity; network metadata, timing, amounts and user behavior can still create correlations.
- Relayers can censor or delay transactions but cannot change a valid proof's recipient, amount, outputs or ciphertext.
- Users can recover and withdraw directly with their recovery phrase, chain access and the published verification/proving artifacts.
- Keep applicable third-party license notices with redistributed dependencies and generated artifacts.

## Dependency review

On 2026-10-29, the full test suite passed 49 tests and all workspace builds completed. `npm audit --omit=dev` reported zero critical, high or moderate advisories. The remaining 15 low entries propagate from the single `elliptic@6.6.1` advisory GHSA-848j-6mx2-7j84 through `circomlibjs`/ethers 5 and browser crypto polyfills. No fixed `elliptic` release is currently available; SWIRL key generation, encryption and signing do not call `elliptic` directly. Re-run the audit before release and avoid forced breaking upgrades.
