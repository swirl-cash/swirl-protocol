import { useCallback, useEffect, useMemo, useState } from 'react';
import { ethers, type JsonRpcSigner } from 'ethers';
import {
  ArrowDownToLine, ArrowUpRight, Check, ChevronRight, CircleAlert, Copy, Eye,
  KeyRound, LoaderCircle, LockKeyhole, Plus, RefreshCw, ShieldCheck,
  Sparkles, WalletCards, X,
} from 'lucide-react';
import { createSwirlWallet, type SwirlWallet } from '@swirl/wallet';
import {
  connectBrowserWallet, contracts, getRelayQuote, loadDeployment, privateTransfer, shieldTokens,
  syncNotes, unshieldTokens, type Deployment, type OwnedNote, type RelayQuote, type SyncedNotes,
} from '../lib/protocol';
import { hasEncryptedWallet, saveEncryptedWallet, unlockEncryptedWallet } from '../lib/wallet-storage';
import '../App.css';

type Action = 'shield' | 'transfer' | 'unshield';

function short(value: string, left = 8, right = 6) {
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

function errorMessage(error: unknown) {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { shortMessage?: string; reason?: string; message?: string };
    return candidate.shortMessage || candidate.reason || candidate.message || 'Transaction failed';
  }
  return String(error);
}

export default function Home() {
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [wallet, setWallet] = useState<SwirlWallet | null>(null);
  const [signer, setSigner] = useState<JsonRpcSigner | null>(null);
  const [account, setAccount] = useState('');
  const [publicBalance, setPublicBalance] = useState<bigint | null>(null);
  const [synced, setSynced] = useState<SyncedNotes>({ notes: [], tree: undefined as never });
  const [leafCount, setLeafCount] = useState<number | null>(null);
  const [action, setAction] = useState<Action>('shield');
  const [amount, setAmount] = useState('100');
  const [transferRecipient, setTransferRecipient] = useState('');
  const [publicRecipient, setPublicRecipient] = useState('');
  const [selectedNote, setSelectedNote] = useState<OwnedNote | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [mnemonic, setMnemonic] = useState('');
  const [showPhrase, setShowPhrase] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [directSubmission, setDirectSubmission] = useState(false);
  const [relayQuote, setRelayQuote] = useState<RelayQuote | null>(null);
  const [storedWallet, setStoredWallet] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState<'save' | 'unlock' | null>(null);
  const [password, setPassword] = useState('');

  useEffect(() => {
    void loadDeployment().then(setDeployment);
    setStoredWallet(hasEncryptedWallet());
  }, []);

  useEffect(() => {
    let active = true;
    setRelayQuote(null);
    if (deployment && action !== 'shield' && !directSubmission && import.meta.env.VITE_RELAYER_URL) {
      void getRelayQuote(deployment).then((quote) => { if (active) setRelayQuote(quote); }).catch(() => undefined);
    }
    return () => { active = false; };
  }, [deployment, action, directSubmission]);

  const refresh = useCallback(async () => {
    if (!signer || !wallet || !deployment) return;
    setError('');
    try {
      const { vault, token } = contracts(signer, deployment);
      const address = await signer.getAddress();
      const [nextNotes, balance, leaves] = await Promise.all([
        syncNotes(vault, wallet), token.balanceOf(address), vault.nextLeafIndex(),
      ]);
      setSynced(nextNotes);
      setPublicBalance(balance);
      setLeafCount(Number(leaves));
      setAccount(address);
      setPublicRecipient((current) => current || address);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [deployment, signer, wallet]);

  useEffect(() => { void refresh(); }, [refresh]);

  const available = useMemo(
    () => synced.notes.filter((item) => !item.spent).reduce((sum, item) => sum + item.note.amount, 0n),
    [synced.notes],
  );
  const chainReady = Boolean(deployment && signer && wallet);

  async function run(label: string, operation: () => Promise<void>) {
    setBusy(label);
    setError('');
    setNotice('');
    try { await operation(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); }
  }

  async function createWallet() {
    await run('Generating independent keys', async () => {
      const created = await createSwirlWallet(deployment?.chainId ?? 31337);
      setWallet(created);
      setShowPhrase(true);
      setNotice('Wallet created locally. Back up the recovery phrase before using it.');
    });
  }

  async function restoreWallet() {
    await run('Restoring wallet', async () => {
      const restored = await createSwirlWallet(deployment?.chainId ?? 31337, mnemonic.trim());
      setWallet(restored);
      setRestoreOpen(false);
      setMnemonic('');
      setNotice('Wallet restored. Sync to recover encrypted notes from chain events.');
    });
  }

  async function submitPassword() {
    await run(passwordOpen === 'save' ? 'Encrypting wallet locally' : 'Unlocking encrypted wallet', async () => {
      if (passwordOpen === 'save') {
        if (!wallet) throw new Error('Create or restore a wallet first');
        await saveEncryptedWallet(wallet, password);
        setStoredWallet(true);
        setNotice('Encrypted wallet saved in this browser. Your password is never stored.');
      } else {
        const restored = await unlockEncryptedWallet(password);
        setWallet(restored);
        setNotice('Encrypted wallet unlocked. Connect your EVM wallet and sync notes.');
      }
      setPassword('');
      setPasswordOpen(null);
    });
  }

  function lockWallet() {
    setWallet(null);
    setSynced({ notes: [], tree: undefined as never });
    setSelectedNote(null);
    setShowPhrase(false);
    setNotice('Wallet locked in this tab. Your encrypted browser copy remains saved.');
  }

  async function connect() {
    if (!deployment) return setError('No local deployment found. Run the local deployment script first.');
    await run('Connecting EVM wallet', async () => {
      const connected = await connectBrowserWallet(deployment);
      setSigner(connected);
      setAccount(await connected.getAddress());
    });
  }

  async function submit() {
    if (!wallet || !signer || !deployment) return;
    await run(action === 'shield' ? 'Shielding on-chain' : 'Generating Groth16 proof', async () => {
      const parsed = ethers.parseUnits(amount || '0', 6);
      if (parsed <= 0n) throw new Error('Enter an amount greater than zero');
      if (action === 'shield') {
        await shieldTokens({ signer, deployment, wallet, grossAmount: parsed });
        setNotice('Shield confirmed. Your encrypted note is now in the vault.');
      } else if (action === 'transfer') {
        await privateTransfer({ signer, deployment, wallet, synced, recipient: transferRecipient, amount: parsed, directSubmission });
        setNotice('Private transfer confirmed. The input nullifiers are now spent.');
      } else {
        if (!selectedNote) throw new Error('Select an unspent note');
        await unshieldTokens({ signer, deployment, wallet, synced, note: selectedNote, recipient: publicRecipient, directSubmission });
        setNotice('Unshield confirmed. Public assets were sent to the recipient.');
      }
      await refresh();
    });
  }

  async function mint() {
    if (!signer || !deployment) return;
    await run('Minting test tokens', async () => {
      const address = await signer.getAddress();
      await (await contracts(signer, deployment).token.mint(address, ethers.parseUnits('10000', 6))).wait();
      setNotice('10,000 USDC minted on the development chain.');
      await refresh();
    });
  }

  function copyAddress() {
    if (!wallet) return;
    void navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  const actionDisabled = Boolean(busy) || !chainReady || action !== 'unshield' && !amount;

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" /><div className="ambient ambient-two" />
      <header className="topbar">
        <a className="brand" href="/" aria-label="SWIRL home">
          <span className="brand-mark"><span /><span /><span /></span>
          <span>SWIRL<span className="brand-dot">.</span></span>
        </a>
        <nav className="nav-links" aria-label="Protocol navigation">
          <a className="active" href="#wallet">Wallet</a><a href="#protocol">Protocol</a><a href="#security">Security</a>
        </nav>
        <div className="top-actions">
          <span className={`network-pill ${deployment ? 'online' : ''}`}><i />{deployment ? 'LOCAL DEVNET' : 'NO DEPLOYMENT'}</span>
          <button className="connect-button" onClick={connect} disabled={Boolean(busy) || !deployment}>
            {signer ? <><span className="account-dot" />{short(account)}</> : <><WalletCards size={15} />Connect wallet</>}
          </button>
        </div>
      </header>

      <main id="wallet" className="workspace">
        <section className="intro-row">
          <div>
            <div className="eyebrow"><Sparkles size={13} /> PRIVATE VALUE LAYER</div>
            <h1>Your assets.<br /><span>Your zero knowledge.</span></h1>
            <p>Shield, transfer and unshield ERC-20 assets with independently implemented Groth16 notes.</p>
          </div>
          <div className="dev-notice"><CircleAlert size={17} /><div><strong>Development environment</strong><span>Single-contributor setup · no mainnet funds</span></div></div>
        </section>

        <section className="wallet-grid">
          <div className="balance-column">
            <div className="glass-card balance-card">
              <div className="card-topline"><span>PRIVATE BALANCE</span><button className="icon-button" onClick={refresh} disabled={!chainReady || Boolean(busy)} aria-label="Sync notes"><RefreshCw size={16} /></button></div>
              <div className="balance-value">{wallet && signer ? ethers.formatUnits(available, 6) : '—'} <small>USDC</small></div>
              <div className="balance-meta"><span><i className="green-dot" />{synced.notes.filter((n) => !n.spent).length} spendable notes</span><span>{leafCount ?? '—'} tree leaves</span></div>
              <div className="balance-divider" />
              <div className="public-row"><span>Public wallet</span><strong>{publicBalance === null ? '—' : ethers.formatUnits(publicBalance, 6)} USDC</strong></div>
              <div className="public-row"><span>Development token</span><button className="text-button" onClick={mint} disabled={!signer || Boolean(busy)}>Mint test USDC <Plus size={13} /></button></div>
            </div>

            <div className="glass-card identity-card">
              <div className="card-topline"><span>SWIRL IDENTITY</span><KeyRound size={16} /></div>
              {wallet ? <>
                <div className="identity-status"><span className="identity-check"><Check size={15} /></span><div><strong>Keys active</strong><span>{storedWallet ? 'Unlocked in this tab · encrypted copy saved' : 'Generated and held in this tab'}</span></div></div>
                <button className="address-box" onClick={copyAddress} title={wallet.address}>
                  <code>{short(wallet.address, 15, 12)}</code>{copied ? <Check size={15} /> : <Copy size={15} />}
                </button>
                <button className="phrase-button" onClick={() => setShowPhrase(!showPhrase)}><Eye size={14} />{showPhrase ? 'Hide' : 'Reveal'} recovery phrase</button>
                {showPhrase && <div className="recovery-phrase">{wallet.mnemonic}</div>}
                <div className="identity-actions">
                  <button className="secondary-button full" onClick={() => setPasswordOpen('save')}><LockKeyhole size={14} />Save encrypted wallet</button>
                  {storedWallet && <button className="text-button" onClick={lockWallet}>Lock wallet</button>}
                </div>
              </> : <>
                <p className="muted-copy">Create an independent <code>swirl1</code> identity. Nothing is uploaded or stored by a server.</p>
                {storedWallet && <button className="primary-button full" onClick={() => setPasswordOpen('unlock')}><LockKeyhole size={15} />Unlock saved wallet</button>}
                <button className={storedWallet ? 'secondary-button full' : 'primary-button full'} onClick={createWallet} disabled={Boolean(busy)}><Plus size={16} />Create private wallet</button>
                <button className="secondary-button full" onClick={() => setRestoreOpen(true)}>Restore from recovery phrase</button>
              </>}
            </div>
          </div>

          <div className="glass-card action-card">
            <div className="action-tabs" role="tablist">
              {(['shield', 'transfer', 'unshield'] as Action[]).map((item) => <button key={item} role="tab" aria-selected={action === item} className={action === item ? 'selected' : ''} onClick={() => { setAction(item); setError(''); }}>{item === 'shield' ? 'Shield' : item === 'transfer' ? 'Private transfer' : 'Unshield'}</button>)}
            </div>
            <div className="action-content">
              <div className="action-heading">
                <span className="action-icon">{action === 'shield' ? <ArrowDownToLine /> : action === 'transfer' ? <ArrowUpRight /> : <LockKeyhole />}</span>
                <div><h2>{action === 'shield' ? 'Enter the private pool' : action === 'transfer' ? 'Send a private note' : 'Return to a public address'}</h2><p>{action === 'shield' ? 'A fresh encrypted note is created in your browser.' : action === 'transfer' ? 'The proof hides which input note is being spent.' : 'A real Groth16 proof authorizes the withdrawal.'}</p></div>
              </div>

              {action !== 'unshield' ? <>
                <label className="field-label">AMOUNT <span>USDC</span></label>
                <div className="amount-input"><input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} /><span>USDC</span></div>
                {action === 'shield' && <div className="fee-line"><span>Protocol fee · 0.25%</span><span>Net note: {amount ? (Number(amount) * 0.9975).toLocaleString() : '0'} USDC</span></div>}
              </> : <>
                <label className="field-label">SELECT AN UNSPENT NOTE</label>
                <div className="note-list">
                  {synced.notes.filter((item) => !item.spent).length === 0 && <div className="empty-notes">No spendable notes found for this identity.</div>}
                  {synced.notes.filter((item) => !item.spent).map((item) => <button key={item.note.leafIndex} className={`note-item ${selectedNote?.note.leafIndex === item.note.leafIndex ? 'chosen' : ''}`} onClick={() => setSelectedNote(item)}><span><i />Note #{item.note.leafIndex}</span><strong>{ethers.formatUnits(item.note.amount, 6)} USDC</strong></button>)}
                </div>
              </>}

              {action !== 'shield' && <>
                <label className="field-label">{action === 'transfer' ? 'RECIPIENT SWIRL ADDRESS' : 'PUBLIC EVM RECIPIENT'}</label>
                <input className="text-input" value={action === 'transfer' ? transferRecipient : publicRecipient} onChange={(e) => action === 'transfer' ? setTransferRecipient(e.target.value) : setPublicRecipient(e.target.value)} placeholder={action === 'transfer' ? 'swirl1…' : '0x…'} spellCheck={false} />
              </>}

              {import.meta.env.VITE_RELAYER_URL && action !== 'shield' && <label className="submission-mode">
                <input type="checkbox" checked={directSubmission} onChange={(event) => setDirectSubmission(event.target.checked)} />
                <span><strong>Submit directly with my wallet</strong><small>{directSubmission ? 'Your EVM wallet pays gas; the Relayer is bypassed.' : 'Off: the configured Relayer submits and pays gas.'}</small></span>
              </label>}
              {!directSubmission && action !== 'shield' && import.meta.env.VITE_RELAYER_URL && <div className="fee-line"><span>Relayer fee</span><span>{relayQuote ? `${ethers.formatUnits(relayQuote.feeAmount, 6)} USDC` : 'Loading quote…'}</span></div>}

              {error && <div className="message error-message"><CircleAlert size={16} /><span>{error}</span><button onClick={() => setError('')}><X size={14} /></button></div>}
              {notice && <div className="message success-message"><Check size={16} /><span>{notice}</span></div>}
              <button className="submit-button" onClick={submit} disabled={actionDisabled}>
                {busy ? <><LoaderCircle className="spin" size={17} />{busy}</> : <>{action === 'shield' ? 'Shield assets' : action === 'transfer' ? 'Prove & transfer' : 'Prove & unshield'}<ChevronRight size={17} /></>}
              </button>
              {!chainReady && <p className="action-hint">Create a SWIRL identity and connect an EVM wallet to enable transactions.</p>}
              <div className="proof-caption"><ShieldCheck size={14} /><span>Groth16 · BN254 · Poseidon · 16-level Merkle tree</span></div>
            </div>
          </div>
        </section>

        <section id="protocol" className="protocol-strip">
          <div><span>01</span><strong>Independent addresses</strong><p>Bech32m <code>swirl1</code> keys. No <code>0zk</code> compatibility.</p></div>
          <div><span>02</span><strong>Real zero knowledge</strong><p>Membership, ownership and amount conservation are circuit-enforced.</p></div>
          <div id="security"><span>03</span><strong>Local note decryption</strong><p>Ephemeral ECDH and authenticated encryption protect note contents.</p></div>
        </section>
      </main>

      <footer><span>SWIRL PROTOCOL · DEVELOPMENT BUILD</span><span>Not audited. Not for valuable assets.</span><span>v0.1.0</span></footer>

      {restoreOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setRestoreOpen(false)}><div className="modal" role="dialog" aria-modal="true" aria-label="Restore wallet" onMouseDown={(e) => e.stopPropagation()}><button className="modal-close" onClick={() => setRestoreOpen(false)}><X size={18} /></button><KeyRound size={24} /><h2>Restore SWIRL identity</h2><p>Enter your 24-word recovery phrase. Restoration happens locally in this tab.</p><textarea value={mnemonic} onChange={(e) => setMnemonic(e.target.value)} placeholder="word word word …" rows={4} autoFocus /><button className="primary-button full" onClick={restoreWallet} disabled={!mnemonic.trim() || Boolean(busy)}>Restore wallet</button></div></div>}
      {passwordOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setPasswordOpen(null)}><div className="modal" role="dialog" aria-modal="true" aria-label={passwordOpen === 'save' ? 'Save encrypted wallet' : 'Unlock saved wallet'} onMouseDown={(e) => e.stopPropagation()}><button className="modal-close" onClick={() => setPasswordOpen(null)}><X size={18} /></button><LockKeyhole size={24} /><h2>{passwordOpen === 'save' ? 'Encrypt this wallet' : 'Unlock saved wallet'}</h2><p>{passwordOpen === 'save' ? 'Your recovery phrase is encrypted with PBKDF2 and AES-256-GCM before it is saved in this browser. The password is never stored.' : 'Enter the encryption password. Decryption and key recovery happen only in this tab.'}</p><input className="text-input password-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Encryption password" aria-label="Encryption password" autoFocus /><button className="primary-button full" onClick={submitPassword} disabled={!password || Boolean(busy)}>{passwordOpen === 'save' ? 'Save encrypted wallet' : 'Unlock wallet'}</button></div></div>}
    </div>
  );
}
