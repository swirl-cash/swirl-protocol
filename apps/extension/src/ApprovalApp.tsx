import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, FileSignature, Globe2, LoaderCircle, LockKeyhole, Send, ShieldCheck, WalletCards, X } from 'lucide-react';
import { HDNodeWallet, JsonRpcProvider, NonceManager, ethers, type BigNumberish, type TransactionRequest } from 'ethers';
import { type SwirlWallet } from '@swirl/wallet';
import { hasEncryptedWallet, unlockEncryptedWallet } from './lib/storage';
import { activateNetwork, loadNetwork, loadNetworks, rpcReady } from './lib/network';
import { EXTENSION_SOURCE, type ApprovalDecision, type PendingApproval } from './lib/dapp-types';
import { sendRuntimeMessage } from './lib/runtime';
import { errorMessage } from './lib/feedback';

const short = (value: string) => `${value.slice(0, 10)}…${value.slice(-8)}`;
function messageText(value: unknown): string {
  if (typeof value !== 'string') return JSON.stringify(value, null, 2);
  if (/^0x[0-9a-f]*$/i.test(value) && value.length % 2 === 0) {
    try { return ethers.toUtf8String(value); } catch { return value; }
  }
  return value;
}
function titleFor(method: PendingApproval['method']) {
  if (method === 'eth_requestAccounts') return 'Connect this dApp?';
  if (method === 'wallet_switchEthereumChain') return 'Switch network?';
  if (method === 'personal_sign') return 'Sign this message?';
  return 'Confirm transaction';
}

export default function ApprovalApp() {
  const id = new URLSearchParams(window.location.search).get('id') ?? '';
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [networkNames, setNetworkNames] = useState(new Map<number, string>());
  const [wallet, setWallet] = useState<SwirlWallet | null>(null);
  const [hasWallet, setHasWallet] = useState(true);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [finished, setFinished] = useState(false);
  const [broadcastHash, setBroadcastHash] = useState('');

  useEffect(() => {
    void Promise.all([
      sendRuntimeMessage({ source: EXTENSION_SOURCE, type: 'approval:get', id }),
      loadNetworks(), hasEncryptedWallet(),
    ]).then(([response, networks, exists]) => {
      if (response?.error) throw new Error(response.error);
      if (!response?.pending || response.pending.id !== id) throw new Error('This approval expired or has already been handled');
      setPending(response.pending); setNetworkNames(new Map(networks.map((item) => [item.chainId, item.name]))); setHasWallet(exists);
    }).catch((cause) => setError(errorMessage(cause)));
  }, [id]);

  const evm = useMemo(() => wallet ? HDNodeWallet.fromPhrase(wallet.mnemonic) : null, [wallet]);
  const chainName = pending ? networkNames.get(pending.chainId) ?? `Chain ${pending.chainId}` : '';
  const transaction = pending?.method === 'eth_sendTransaction' && pending.params[0] && typeof pending.params[0] === 'object'
    ? pending.params[0] as Record<string, unknown> : null;
  const rawMessage = pending?.method === 'personal_sign' ? pending.params[0] : null;

  async function unlock(event: FormEvent) {
    event.preventDefault();
    if (!pending) return;
    setBusy('Decrypting…'); setError('');
    try {
      const next = await unlockEncryptedWallet(password, pending.chainId);
      setWallet(next); setPassword('');
      if (evm === null) {
        const account = HDNodeWallet.fromPhrase(next.mnemonic).address;
        const response = await sendRuntimeMessage({ source: EXTENSION_SOURCE, type: 'wallet:unlocked', account });
        if (response?.error) throw new Error(response.error);
      }
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); }
  }

  async function decide(decision: ApprovalDecision) {
    const response = await sendRuntimeMessage({ source: EXTENSION_SOURCE, type: 'approval:decision', id, decision });
    if (response?.error) throw new Error(response.error);
    setFinished(true); window.close();
  }

  async function approve() {
    if (!pending || !evm) return;
    setBusy(pending.method === 'eth_sendTransaction' ? 'Broadcasting…' : pending.method === 'personal_sign' ? 'Signing…' : 'Approving…'); setError('');
    try {
      if (pending.method === 'eth_requestAccounts') return await decide({ approved: true, account: evm.address });
      if (pending.method === 'wallet_switchEthereumChain') {
        const profile = (await loadNetworks()).find((item) => item.chainId === pending.chainId);
        if (!profile || !rpcReady(profile)) throw new Error('The requested network is not fully configured');
        const provider = new JsonRpcProvider(profile.rpcUrl);
        const actual = await provider.getNetwork();
        if (Number(actual.chainId) !== pending.chainId) throw new Error(`RPC chain mismatch: expected ${pending.chainId}, received ${actual.chainId}`);
        await activateNetwork(pending.chainId);
        return await decide({ approved: true });
      }
      if (pending.method === 'personal_sign') {
        const requestedAccount = pending.params[1];
        if (typeof requestedAccount !== 'string' || requestedAccount.toLowerCase() !== evm.address.toLowerCase()) throw new Error('The requested signing account does not match this wallet');
        if (typeof rawMessage !== 'string') throw new Error('Invalid personal_sign message');
        const signature = await evm.signMessage(/^0x[0-9a-f]*$/i.test(rawMessage) ? ethers.getBytes(rawMessage) : rawMessage);
        return await decide({ approved: true, signature });
      }
      if (!transaction) throw new Error('Invalid transaction request');
      const active = await loadNetwork();
      if (active.chainId !== pending.chainId) throw new Error(`Switch SWIRL to ${chainName} before confirming this transaction`);
      if (!rpcReady(active)) throw new Error('The active network is not fully configured');
      if (transaction.from && (typeof transaction.from !== 'string' || transaction.from.toLowerCase() !== evm.address.toLowerCase())) throw new Error('The transaction sender does not match this wallet');
      const provider = new JsonRpcProvider(active.rpcUrl);
      const actual = await provider.getNetwork();
      if (Number(actual.chainId) !== pending.chainId) throw new Error(`RPC chain mismatch: expected ${pending.chainId}, received ${actual.chainId}`);
      const request: TransactionRequest = {
        to: transaction.to === null ? null : transaction.to as string | undefined,
        value: (transaction.value ?? 0) as BigNumberish,
        data: (transaction.data ?? transaction.input ?? '0x') as string,
        chainId: pending.chainId,
      };
      for (const key of ['gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce', 'type', 'accessList'] as const) {
        if (transaction[key] !== undefined) (request as Record<string, unknown>)[key] = transaction[key];
      }
      const signer = new NonceManager(evm.connect(provider));
      const sent = await signer.sendTransaction(request);
      setBroadcastHash(sent.hash);
      try { await decide({ approved: true, transactionHash: sent.hash }); }
      catch (cause) {
        setWallet(null);
        throw new Error(`Transaction ${sent.hash} was already broadcast. Do not retry. Acknowledgement failed: ${errorMessage(cause)}`);
      }
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); }
  }

  async function reject() {
    setBusy('Rejecting…'); setError('');
    try { await decide({ approved: false }); }
    catch (cause) { setError(errorMessage(cause)); setBusy(''); }
  }

  if (broadcastHash) return <main className="wallet-shell approval-shell">
    <header className="app-header"><div className="brand"><img className="brand-logo" src="./icons/logo-mark.png" alt="" /><span>SWIRL <span className="brand-wallet">Wallet</span></span></div><span className="local-badge"><span /> APPROVAL</span></header>
    <section className="form-view"><div className="hero-symbol compact"><Check size={29} /></div><p className="eyebrow">TRANSACTION BROADCAST</p><h1>Already sent</h1><p className="section-copy">The network accepted this transaction for broadcasting. Check its status before taking any further action.</p><p className="recovery-phrase viewing-key">{broadcastHash}</p>{error && <p className="error-message" role="alert">{error}</p>}<button className="primary-button" onClick={() => window.close()}>Close window</button></section>
  </main>;

  return <main className="wallet-shell approval-shell">
    <header className="app-header"><div className="brand"><img className="brand-logo" src="./icons/logo-mark.png" alt="" /><span>SWIRL <span className="brand-wallet">Wallet</span></span></div><span className="local-badge"><span /> APPROVAL</span></header>
    {!pending && <section className="form-view"><div className="hero-symbol compact"><LockKeyhole size={29} /></div><h1>Request unavailable</h1>{error ? <p className="error-message" role="alert">{error}</p> : <p className="section-copy">Loading the dApp request…</p>}</section>}
    {pending && !wallet && <section className="form-view">
      <div className="approval-origin"><span className="approval-origin-icon"><Globe2 size={19} /></span><div><strong>{new URL(pending.origin).hostname}</strong><small>{pending.origin}</small></div></div>
      <h1>{hasWallet ? 'Unlock to review' : 'Wallet required'}</h1>
      <p className="section-copy">{hasWallet ? `${titleFor(pending.method)} Unlocking decrypts your wallet only in this approval window.` : 'Create or import a wallet from the main SWIRL window, then retry the dApp request.'}</p>
      {hasWallet ? <form onSubmit={(event) => void unlock(event)}>
        <label className="field-label" htmlFor="approval-password">Password</label>
        <input id="approval-password" className="text-field" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus required />
        {error && <p className="error-message approval-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={Boolean(busy)} type="submit">{busy ? <LoaderCircle className="spin" size={16} /> : <LockKeyhole size={16} />}{busy || 'Unlock & review'}</button>
      </form> : <button className="primary-button" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('index.html') })}><WalletCards size={16} /> Open SWIRL wallet</button>}
      <button className="secondary-button" onClick={() => void reject()} disabled={Boolean(busy)}><X size={15} /> Reject request</button>
    </section>}
    {pending && wallet && evm && <section>
      <p className="eyebrow">EXTERNAL REQUEST</p><h1 className="approval-method">{titleFor(pending.method)}</h1>
      <div className="approval-origin"><span className="approval-origin-icon"><Globe2 size={19} /></span><div><strong>{new URL(pending.origin).hostname}</strong><small>{pending.origin}</small></div></div>
      <div className="approval-details">
        <div className="approval-detail"><span>Network</span><strong>{chainName} · {pending.chainId}</strong></div>
        <div className="approval-detail"><span>Account</span><strong title={evm.address}>{short(evm.address)}</strong></div>
        {pending.method === 'personal_sign' && <div><p className="field-label">MESSAGE</p><pre className="approval-message">{messageText(rawMessage)}</pre></div>}
        {transaction && <>
          <div className="approval-detail"><span>To</span><strong title={String(transaction.to ?? 'Contract creation')}>{transaction.to ? short(String(transaction.to)) : 'Contract creation'}</strong></div>
          <div className="approval-detail"><span>Native value</span><strong>{ethers.formatEther(String(transaction.value ?? '0x0'))}</strong></div>
          <div><p className="field-label">CALL DATA</p><pre className="approval-message">{String(transaction.data ?? transaction.input ?? '0x')}</pre></div>
        </>}
      </div>
      <div className="approval-warning">{pending.method === 'eth_sendTransaction' ? <Send size={16} /> : pending.method === 'personal_sign' ? <FileSignature size={16} /> : <ShieldCheck size={16} />}<span>{pending.method === 'eth_requestAccounts' ? 'This shares your public EVM address with the dApp. It never shares your recovery phrase or private key.' : pending.method === 'wallet_switchEthereumChain' ? 'Switch only if you trust this dApp. Balances and private notes are loaded separately for every chain.' : pending.method === 'personal_sign' ? 'Signatures can carry meaning beyond this window. Reject any message you do not fully understand.' : 'This transaction can change on-chain state. Review the recipient, value and call data before broadcasting.'}</span></div>
      {error && <p className="error-message approval-error" role="alert">{error}</p>}
      {finished ? <p className="notice-message">Decision submitted. You can close this window.</p> : <div className="approval-actions"><button className="secondary-button" onClick={() => void reject()} disabled={Boolean(busy)}><X size={15} /> Reject</button><button className="primary-button" onClick={() => void approve()} disabled={Boolean(busy)}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{busy || (pending.method === 'eth_sendTransaction' ? 'Confirm & send' : pending.method === 'personal_sign' ? 'Sign message' : 'Approve')}</button></div>}
    </section>}
  </main>;
}
