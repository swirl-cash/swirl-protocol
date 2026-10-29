import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ethers, HDNodeWallet, type Signer } from 'ethers';
import QRCode from 'qrcode';
import {
  Activity, ArrowDownToLine, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleAlert, CircleHelp, Copy, Eye, EyeOff,
  FileText, Fuel, Globe2, KeyRound, LoaderCircle, LockKeyhole, Plus, RefreshCw, Settings2, ShieldCheck, WalletCards, X,
} from 'lucide-react';
import { AssetCollection, PortfolioHome, type AssetBucket, type PortfolioEntry } from './components/Portfolio';
import { LegalView, type LegalKind } from './components/LegalView';
import './wallet-overhaul.css';
import './feedback.css';
import './backup.css';
import { createSwirlWallet, type SwirlWallet } from '@swirl/wallet';
import { createEncryptedWallet, hasEncryptedWallet, unlockEncryptedWallet } from './lib/storage';
import {
  DEFAULT_NETWORK, activateNetwork, loadNetwork, loadNetworks, protocolReady, rpcReady,
  type NetworkConfig,
} from './lib/network';
import { addActivity, listActivity, type ActivityRecord } from './lib/activity';
import { sendRuntimeMessage } from './lib/runtime';
import {
  connectNetwork, estimatePrivateTransferRelayFee, getRelayFeeConfig, getRelayQuote, isNoteSpendable,
  mintTestTokens, poiClientFor, privateTransfer, publicTransfer, shieldTokens, spendableNotes, syncNotes, unshieldTokens,
  type OwnedNote, type PrivateTransactionResult, type RelayQuote, type SyncedNotes,
} from './lib/protocol';
import { retryPendingPOI, savePendingPOI, submitPendingPOI } from './lib/poi';
import { assetUsdPrice } from './lib/prices';
import { assertGasAvailable, gasAddress, gasSnapshot, gasWallet, createProvider, nativeSymbol, topUpGasAccount, type GasEstimate } from './lib/gas';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type SubmissionPreference, type WalletSettings } from './lib/settings';
import { errorMessage, transactionExplorer } from './lib/feedback';

type Mode = 'loading' | 'welcome' | 'create' | 'import' | 'unlock' | 'backup' | 'wallet';
type WalletTab = 'assets' | 'receive' | 'activity' | 'settings';
type Action = 'shield' | 'transfer' | 'unshield';

const emptySynced = (): SyncedNotes => ({ notes: [], tree: undefined as never });
const short = (value: string, left = 10, right = 8) => `${value.slice(0, left)}…${value.slice(-right)}`;

function Brand() {
  return <div className="brand"><img className="brand-logo" src="./icons/logo-mark.png" alt="" /><span>SWIRL <span className="brand-wallet">Wallet</span></span></div>;
}
function PasswordFields({ password, confirmation, setPassword, setConfirmation }: {
  password: string; confirmation: string; setPassword: (value: string) => void; setConfirmation: (value: string) => void;
}) {
  return <>
    <label className="field-label" htmlFor="wallet-password">Encryption password</label>
    <input id="wallet-password" className="text-field" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 12 characters" required />
    <label className="field-label" htmlFor="wallet-confirmation">Confirm password</label>
    <input id="wallet-confirmation" className="text-field" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="Repeat your password" required />
  </>;
}
function SettingsSection({ id, title, subtitle, icon, children }: {
  id: string; title: string; subtitle: string; icon: React.ReactNode; children: React.ReactNode;
}) {
  return <details id={id} className="settings-card"><summary><span className="settings-icon">{icon}</span><span className="settings-summary-copy"><strong>{title}</strong><small>{subtitle}</small></span><ChevronDown className="settings-chevron" size={15} /></summary><div className="settings-detail">{children}</div></details>;
}

export default function App() {
  const [mode, setMode] = useState<Mode>('loading');
  const [wallet, setWallet] = useState<SwirlWallet | null>(null);
  const [tab, setTab] = useState<WalletTab>('assets');
  const [assetView, setAssetView] = useState<AssetBucket>('home');
  const [legalDocument, setLegalDocument] = useState<LegalKind | null>(null);
  const [portfolioEntries, setPortfolioEntries] = useState<Record<string, PortfolioEntry>>({});
  const [portfolioSyncing, setPortfolioSyncing] = useState(false);
  const [addressKind, setAddressKind] = useState<'private' | 'evm'>('private');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [mnemonic, setMnemonic] = useState('');
  const [walletExists, setWalletExists] = useState(false);
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [transactionNotice, setTransactionNotice] = useState<{ notice: string; hash: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [showPhrase, setShowPhrase] = useState(false);
  const [copied, setCopied] = useState(false);
  const [config, setConfig] = useState<NetworkConfig>(DEFAULT_NETWORK);
  const [assetSymbol, setAssetSymbol] = useState('');
  const [networks, setNetworks] = useState<NetworkConfig[]>([]);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [signer, setSigner] = useState<Signer | null>(null);
  const [account, setAccount] = useState('');
  const [publicBalance, setPublicBalance] = useState<bigint | null>(null);
  const [synced, setSynced] = useState<SyncedNotes>(emptySynced);
  const [leafCount, setLeafCount] = useState<number | null>(null);
  const [tokenSymbol, setTokenSymbol] = useState('');
  const [decimals, setDecimals] = useState(18);
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [action, setAction] = useState<Action>('shield');
  const [transferKind, setTransferKind] = useState<'public' | 'private'>('private');
  const [amount, setAmount] = useState('0');
  const [recipient, setRecipient] = useState('');
  const [selectedNote, setSelectedNote] = useState<OwnedNote | null>(null);
  const [settings, setSettings] = useState<WalletSettings>(DEFAULT_SETTINGS);
  const [relayQuote, setRelayQuote] = useState<RelayQuote | null>(null);
  const [relayQuoteError, setRelayQuoteError] = useState('');
  const [gasBalance, setGasBalance] = useState<bigint | null>(null);
  const [gasEstimates, setGasEstimates] = useState<GasEstimate[]>([]);
  const [gasAmount, setGasAmount] = useState('0');
  const [gasOperations, setGasOperations] = useState(5);
  const [gasOperation, setGasOperation] = useState<'transfer' | 'unshield'>('transfer');
  const [gasError, setGasError] = useState('');
  const [showViewingKey, setShowViewingKey] = useState(false);
  const [lastActivity, setLastActivity] = useState(Date.now());
  const qrRef = useRef<HTMLCanvasElement>(null);
  const refreshId = useRef(0);
  const portfolioRefreshId = useRef(0);
  const gasRefreshId = useRef(0);
  const maxRequestId = useRef(0);
  const poiRetrying = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    void Promise.all([loadNetwork(), loadNetworks(), loadSettings(), hasEncryptedWallet()]).then(([network, catalog, preferences, exists]) => {
      setConfig(network); setNetworks(catalog); setSettings(preferences); setWalletExists(exists); setMode(exists ? 'unlock' : 'welcome');
    }).catch((cause) => {
      setError(errorMessage(cause)); setMode('welcome');
    });
  }, []);

  const evmAccount = useMemo(() => wallet ? HDNodeWallet.fromPhrase(wallet.mnemonic) : null, [wallet]);
  const evmAddress = evmAccount?.address ?? '';
  const evmPrivateKey = evmAccount?.privateKey ?? '';
  const dedicatedGasAddress = useMemo(() => wallet ? gasAddress(wallet.mnemonic) : '', [wallet]);
  const receiveAddress = addressKind === 'private' ? wallet?.address ?? '' : evmAddress;
  const asset = config.assets.find((item) => item.symbol === assetSymbol) ?? config.assets[0];
  const configReady = protocolReady(config) && Boolean(asset);
  const relayerSupported = Boolean(asset && config.relayerUrl && config.relayerVault.toLowerCase() === asset.vault.toLowerCase());
  const directSubmission = settings.submission !== 'relayer' || !relayerSupported;
  const gasSubmission = settings.submission === 'gas' && directSubmission;
  const relayerFeeAction = settings.submission === 'relayer' && relayerSupported
    && ((action === 'transfer' && transferKind === 'private') || (action === 'unshield' && asset?.kind !== 'native'));
  const nativeCurrency = nativeSymbol(config.chainId);
  const submissionLabel = settings.submission === 'relayer' ? 'Relayer' : settings.submission === 'gas' ? 'Gas account' : 'Main wallet';
  const submissionExplanation = settings.submission === 'relayer'
    ? 'Relayer pays network Gas. You pay its quoted token fee from your private balance.'
    : settings.submission === 'gas'
      ? gasBalance !== null && gasBalance > 0n ? 'Your dedicated Gas account pays network fees for private transactions.' : `Your Gas account needs ${nativeCurrency}. Top it up above before submitting private transactions.`
      : 'Your main EVM wallet pays network Gas directly. No Relayer fee is added.';
  const visibleNetworks = networks.filter((item) => item.chainId !== 31337 && (item.chainId === config.chainId || !settings.hiddenChainIds.includes(item.chainId)));
  const noticeTransactionUrl = transactionNotice?.notice === notice ? transactionExplorer(config.chainId, transactionNotice.hash) : '';

  useEffect(() => {
    let active = true;
    setRelayQuote(null); setRelayQuoteError('');
    if (relayerFeeAction && asset) {
      void getRelayFeeConfig(config, asset).then(async (feeConfig) => {
        if (feeConfig.dynamicGasFee) {
          if (active) setRelayQuoteError('Calculated from current Gas before submission');
          return null;
        }
        return getRelayQuote(config, asset);
      }).then((quote) => { if (active && quote) setRelayQuote(quote); })
        .catch((cause) => { if (active) setRelayQuoteError(errorMessage(cause)); });
    }
    return () => { active = false; };
  }, [relayerFeeAction, config, asset]);

  useEffect(() => {
    if (wallet && qrRef.current && receiveAddress) {
      void QRCode.toCanvas(qrRef.current, receiveAddress, { width: 196, margin: 2, color: { dark: '#101713', light: '#e9fff2' } });
    }
  }, [wallet, receiveAddress, tab]);

  const refresh = useCallback(async () => {
    if (!wallet || !asset || !configReady || mode !== 'wallet') return;
    const requestId = ++refreshId.current;
    setSyncing(true); setError('');
    try {
      const connected = await connectNetwork(config, wallet, asset);
      const balanceRequest = asset.kind === 'native' ? connected.provider.getBalance(connected.account) : connected.token.balanceOf(connected.account);
      const [nextNotes, balance, leaves, onChainDecimals, history] = await Promise.all([
        syncNotes(connected.vault, wallet, config.indexerUrl, poiClientFor(config, asset)), balanceRequest,
        connected.vault.nextLeafIndex(), connected.token.decimals(),
        listActivity(config.chainId, connected.account, asset.token),
      ]);
      if (requestId !== refreshId.current) return;
      if (Number(onChainDecimals) !== asset.decimals) throw new Error(`${asset.symbol} decimals do not match the packaged deployment`);
      const token = BigInt(asset.token);
      const assetNotes = nextNotes.notes.filter((item) => item.note.token === token);
      setSigner(connected.signer); setAccount(connected.account); setSynced({ ...nextNotes, notes: assetNotes }); setPublicBalance(balance);
      setLeafCount(Number(leaves)); setTokenSymbol(asset.symbol); setDecimals(asset.decimals); setActivities(history);
      setSelectedNote((current) => current ? assetNotes.find((item) => item.note.leafIndex === current.note.leafIndex && isNoteSpendable(item, Boolean(config.poiNodeUrl))) ?? null : null);
    } catch (cause) {
      if (requestId !== refreshId.current) return;
      setSigner(null); setPublicBalance(null); setSynced(emptySynced()); setLeafCount(null); setError(errorMessage(cause));
    } finally { if (requestId === refreshId.current) setSyncing(false); }
  }, [asset, config, configReady, mode, wallet]);

  useEffect(() => { void refresh(); }, [refresh]);

  const refreshPortfolio = useCallback(async () => {
    const requestId = ++portfolioRefreshId.current;
    if (!wallet || mode !== 'wallet' || !protocolReady(config)) {
      setPortfolioEntries({}); setPortfolioSyncing(false); return;
    }
    setPortfolioSyncing(true);
    const results = await Promise.all(config.assets.map(async (item) => {
      try {
        const connected = await connectNetwork(config, wallet, item);
        const balanceRequest = item.kind === 'native' ? connected.provider.getBalance(connected.account) : connected.token.balanceOf(connected.account);
        const [nextNotes, balance, price, onChainDecimals] = await Promise.all([
          syncNotes(connected.vault, wallet, config.indexerUrl, poiClientFor(config, item)), balanceRequest,
          assetUsdPrice(item, config.chainId), connected.token.decimals(),
        ]);
        if (Number(onChainDecimals) !== item.decimals) throw new Error(`${item.symbol} decimals do not match the packaged deployment`);
        const availableNotes = nextNotes.notes.filter((note) => !note.spent && note.note.token === BigInt(item.token));
        const entry: PortfolioEntry = {
          publicAmount: balance, privateAmount: availableNotes.reduce((sum, note) => sum + note.note.amount, 0n),
          noteCount: availableNotes.length, price, loaded: true,
        };
        return [item.token, entry] as const;
      } catch (cause) {
        const entry: PortfolioEntry = { publicAmount: 0n, privateAmount: 0n, noteCount: 0, price: 0, loaded: false, error: errorMessage(cause) };
        return [item.token, entry] as const;
      }
    }));
    if (requestId !== portfolioRefreshId.current) return;
    setPortfolioEntries(Object.fromEntries(results)); setPortfolioSyncing(false);
  }, [config, mode, wallet]);
  useEffect(() => { void refreshPortfolio(); }, [refreshPortfolio]);

  useEffect(() => {
    if (!wallet || !asset || !config.poiNodeUrl || !configReady || mode !== 'wallet' || poiRetrying.current) return;
    let active = true;
    poiRetrying.current = true;
    void retryPendingPOI(wallet, config, asset).then((result) => {
      if (!active) return;
      if (result.completed > 0) setNotice(`${result.completed} confirmed transaction${result.completed === 1 ? '' : 's'} now have valid PPOI outputs.`);
      if (result.failed > 0) setError(`PPOI is still pending for ${result.failed} confirmed transaction${result.failed === 1 ? '' : 's'}: ${result.errors[0]}`);
    }).catch((cause) => { if (active) setError(`PPOI retry failed: ${errorMessage(cause)}`); })
      .finally(() => { poiRetrying.current = false; });
    return () => { active = false; };
  }, [asset, config, configReady, mode, wallet]);

  const refreshGas = useCallback(async () => {
    if (!wallet || mode !== 'wallet' || !rpcReady(config)) return;
    const requestId = ++gasRefreshId.current;
    setGasError('');
    try {
      const snapshot = await gasSnapshot(config, wallet.mnemonic);
      if (requestId !== gasRefreshId.current) return;
      setGasBalance(snapshot.balance); setGasEstimates(snapshot.estimates);
    } catch {
      if (requestId !== gasRefreshId.current) return;
      setGasBalance(null); setGasEstimates([]);
      setGasError(config.chainId === 31337 ? 'Local Hardhat is unavailable. Start the local chain, then retry.' : `${config.name} RPC is unavailable. Try again or switch networks.`);
    }
  }, [config, mode, wallet]);
  useEffect(() => { void refreshGas(); }, [refreshGas]);

  function updateSettings(patch: Partial<WalletSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    void saveSettings(next).catch((cause) => setError(errorMessage(cause)));
  }
  function changeSubmission(submission: SubmissionPreference) {
    updateSettings({ submission }); setError('');
    setNotice(submission === 'relayer'
      ? 'Relayer selected. It pays network Gas; the token fee is shown before submission.'
      : submission === 'gas'
        ? gasBalance !== null && gasBalance > 0n ? 'Gas account selected. It will pay network Gas for private transactions.' : `Gas account selected. Top it up with ${nativeCurrency} before private transactions.`
        : 'Main wallet selected. It will pay network Gas directly; no Relayer fee is added.');
  }
  function clearSensitiveForm() { setPassword(''); setConfirmation(''); setMnemonic(''); setError(''); }
  function changeMode(next: Mode) { clearSensitiveForm(); setNotice(''); setOverwriteConfirmed(false); setBackupConfirmed(false); setMode(next); }
  async function notifyBackground(type: 'wallet:unlocked' | 'wallet:locked', account?: string) {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) return;
    await sendRuntimeMessage({ source: 'swirl-extension', type, account });
  }
  async function createWallet(event: FormEvent, importing: boolean) {
    event.preventDefault();
    if (password !== confirmation) return setError('Passwords do not match');
    if (walletExists && !overwriteConfirmed) return setError('Confirm that you want to replace the wallet saved in this browser');
    setBusy('Securing wallet…'); setError('');
    try {
      const next = await createEncryptedWallet(password, importing ? mnemonic : undefined, config.chainId);
      setWallet(next); setWalletExists(true); clearSensitiveForm(); setBackupConfirmed(false); setMode('backup');
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); }
  }
  async function finishBackup() {
    if (!wallet || !backupConfirmed) return;
    setBusy('Opening wallet…'); setError('');
    try {
      await notifyBackground('wallet:unlocked', HDNodeWallet.fromPhrase(wallet.mnemonic).address);
      setMode('wallet'); setTab('assets'); setAssetView('home'); setLastActivity(Date.now());
      setNotice('Wallet ready. Your recovery phrase and private key remain available under Settings → Security & recovery.');
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); }
  }
  async function unlock(event: FormEvent) {
    event.preventDefault(); setBusy('Decrypting…'); setError('');
    try {
      const next = await unlockEncryptedWallet(password, config.chainId);
      await notifyBackground('wallet:unlocked', HDNodeWallet.fromPhrase(next.mnemonic).address);
      setWallet(next); clearSensitiveForm(); setMode('wallet'); setAssetView('home'); setNotice(''); setLastActivity(Date.now());
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); }
  }
  function lock() {
    void notifyBackground('wallet:locked').catch(() => undefined);
    setWallet(null); setSigner(null); setAccount(''); setSynced(emptySynced()); setPublicBalance(null);
    setPortfolioEntries({}); setAssetView('home'); setLegalDocument(null);
    setGasBalance(null); setGasEstimates([]); setGasError(''); setShowViewingKey(false);
    setActivities([]); setSelectedNote(null); setShowPhrase(false); setNotice(''); setError(''); setMode('unlock');
  }
  useEffect(() => {
    if (mode !== 'wallet') return;
    const markActivity = () => setLastActivity(Date.now());
    const events = ['pointerdown', 'keydown', 'touchstart'] as const;
    events.forEach((event) => window.addEventListener(event, markActivity, { passive: true }));
    const timer = window.setInterval(() => {
      if (!busyRef.current && settings.autoLockMinutes > 0 && Date.now() - lastActivity >= settings.autoLockMinutes * 60_000) lock();
    }, 1000);
    return () => {
      window.clearInterval(timer);
      events.forEach((event) => window.removeEventListener(event, markActivity));
    };
  }, [mode, settings.autoLockMinutes, lastActivity]);
  async function copyValue(value: string) {
    setError('');
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true); setNotice('Copied to clipboard.');
      window.setTimeout(() => setCopied(false), 1400);
    } catch (cause) { setCopied(false); setError(`Copy failed. Select and copy the value manually. ${errorMessage(cause)}`); }
  }
  function resetNetworkView() {
    refreshId.current += 1; gasRefreshId.current += 1;
    setSigner(null); setAccount(''); setSynced(emptySynced()); setPublicBalance(null); setActivities([]);
    setGasBalance(null); setGasEstimates([]); setGasError('');
    setLeafCount(null); setSelectedNote(null); setTokenSymbol(''); setDecimals(18);
  }
  async function selectNetwork(chainId: number) {
    setBusy('Switching network…'); setError(''); setNotice('');
    try {
      const next = await activateNetwork(chainId);
      portfolioRefreshId.current += 1; setPortfolioEntries({});
      resetNetworkView(); setAssetSymbol(next.assets[0]?.symbol ?? ''); setConfig(next); setNetworks(await loadNetworks());
      if (wallet && wallet.chainId !== next.chainId) setWallet(await createSwirlWallet(next.chainId, wallet.mnemonic));
      setNetworkOpen(false); setTab('assets'); setAssetView('home'); setLegalDocument(null);
      setNotice(protocolReady(next)
        ? `Switched to ${next.name}.`
        : `Switched to ${next.name}. Ordinary EVM transfers are available; SWIRL private pools are not deployed on this chain yet.`);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); }
  }
  function selectAsset(symbol: string) {
    if (symbol === asset?.symbol) return;
    resetNetworkView(); setAssetSymbol(symbol); setRecipient(''); setAmount('0'); setError(''); setNotice('');
  }
  function openAssetBucket(bucket: Exclude<AssetBucket, 'home'>) {
    setAssetView(bucket); setAction(bucket === 'public' ? 'shield' : 'transfer');
    setTransferKind(bucket === 'public' ? 'public' : 'private'); setRecipient(''); setSelectedNote(null); setError(''); setNotice('');
  }
  async function fillMaxTransfer() {
    if (!asset) return;
    const requestId = ++maxRequestId.current;
    setError('');
    try {
      let maximum: bigint;
      if (transferKind === 'public') {
        maximum = publicBalance ?? 0n;
        if (asset.kind === 'native' && maximum > 0n) {
          const feeData = await createProvider(config).getFeeData();
          const unitFee = feeData.maxFeePerGas ?? feeData.gasPrice;
          if (!unitFee || unitFee <= 0n) throw new Error('Network Gas price is unavailable');
          const reserve = unitFee * 21_000n * 120n / 100n;
          maximum = maximum > reserve ? maximum - reserve : 0n;
        }
      } else {
        const spendable = spendableNotes(synced, BigInt(asset.token), Boolean(config.poiNodeUrl))
          .sort((a, b) => a.note.amount > b.note.amount ? -1 : 1).slice(0, 2)
          .reduce((sum, note) => sum + note.note.amount, 0n);
        let fee = 0n;
        if (relayerFeeAction) {
          if (relayQuote) fee = BigInt(relayQuote.feeAmount);
          else {
            if (!wallet || !signer) throw new Error('Sync the wallet before estimating the dynamic Relayer fee');
            fee = await estimatePrivateTransferRelayFee({ signer, config, asset, wallet, synced });
          }
        }
        maximum = spendable > fee ? spendable - fee : 0n;
      }
      if (requestId === maxRequestId.current) setAmount(ethers.formatUnits(maximum, decimals));
    } catch (cause) {
      if (requestId === maxRequestId.current) setError(errorMessage(cause));
    }
  }

  async function submitAction(event: FormEvent) {
    event.preventDefault();
    if (!wallet || !signer || !asset) return setError('Sync the configured network before submitting a transaction');
    setBusy(action === 'shield' ? 'Confirming Shield…' : action === 'transfer' && transferKind === 'public' ? 'Sending public transfer…' : 'Generating Groth16 proof…'); setError(''); setNotice('');
    try {
      let receipt: PrivateTransactionResult['receipt'];
      let privateResult: PrivateTransactionResult | undefined;
      let activityAmount = amount;
      const privateAction = action === 'unshield' || (action === 'transfer' && transferKind === 'private');
      const submitDirectly = directSubmission || (action === 'unshield' && asset.kind === 'native');
      const useGasAccount = privateAction && submitDirectly && gasSubmission;
      const actionSigner = useGasAccount ? gasWallet(wallet.mnemonic, createProvider(config)) : signer;
      if (useGasAccount) await assertGasAvailable({ config, signer: actionSigner, operation: action === 'unshield' ? 'unshield' : 'transfer' });
      if (action === 'shield') {
        const parsed = ethers.parseUnits(amount || '0', decimals);
        if (parsed <= 0n) throw new Error('Enter an amount greater than zero');
        receipt = await shieldTokens({ signer, config, asset, wallet, grossAmount: parsed });
      } else if (action === 'transfer') {
        const parsed = ethers.parseUnits(amount || '0', decimals);
        if (parsed <= 0n) throw new Error('Enter an amount greater than zero');
        if (transferKind === 'public') receipt = await publicTransfer({ signer, config, asset, recipient, amount: parsed });
        else {
          privateResult = await privateTransfer({ signer: actionSigner, config, asset, wallet, synced, recipient, amount: parsed, directSubmission: submitDirectly });
          receipt = privateResult.receipt;
        }
      } else {
        if (!selectedNote || !isNoteSpendable(selectedNote, Boolean(config.poiNodeUrl))) throw new Error('Select an unspent note with valid PPOI');
        activityAmount = ethers.formatUnits(selectedNote.note.amount, decimals);
        privateResult = await unshieldTokens({ signer: actionSigner, config, asset, wallet, synced, note: selectedNote, recipient, directSubmission: submitDirectly });
        receipt = privateResult.receipt;
      }
      if (!receipt) throw new Error('Transaction receipt was not returned. Check Activity and the network before retrying.');
      if (receipt.status !== 1) throw new Error('The transaction was included but reverted. No new transaction was submitted; review the details before retrying.');
      let poiWarning = '';
      if (privateResult && config.poiNodeUrl) {
        setBusy('Submitting confirmed PPOI proof…');
        try {
          const pending = await savePendingPOI(privateResult, wallet);
          await submitPendingPOI(pending, wallet, config, asset);
        } catch (cause) {
          poiWarning = ` PPOI is pending: ${errorMessage(cause)}. The transaction is already confirmed; do not submit it again.`;
        }
      }
      const activityKind = action === 'transfer' && transferKind === 'public' ? 'public' : action;
      let activityWarning = '';
      try {
        await addActivity({ kind: activityKind, transactionHash: receipt.hash, amount: activityAmount, counterparty: recipient || undefined, chainId: config.chainId, account, assetToken: asset.token, assetSymbol: asset.symbol });
      } catch { activityWarning = ' Local activity could not be saved; keep the transaction hash for your records.'; }
      const successNotice = (action === 'shield'
        ? 'Shield confirmed. Your encrypted note is now in the vault.'
        : action === 'transfer'
          ? transferKind === 'public' ? 'Public transfer confirmed.' : 'Private transfer confirmed. The input nullifiers are now spent.'
          : 'Unshield confirmed. Public assets were sent to the recipient.') + ` Amount: ${activityAmount} ${asset.symbol}.${poiWarning}${activityWarning}`;
      setTransactionNotice({ notice: successNotice, hash: receipt.hash }); setNotice(successNotice);
      setRecipient(''); setSelectedNote(null); await Promise.all([refresh(), refreshGas(), refreshPortfolio()]);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); }
  }
  async function mint() {
    if (!signer || !asset) return;
    setBusy('Minting test tokens…'); setError('');
    try {
      const value = ethers.parseUnits('10000', decimals);
      const receipt = await mintTestTokens(signer, config, asset, value);
      if (!receipt || receipt.status !== 1) throw new Error('The mint transaction did not confirm successfully');
      await addActivity({ kind: 'mint', transactionHash: receipt.hash, amount: '10000', chainId: config.chainId, account, assetToken: asset.token, assetSymbol: asset.symbol });
      const successNotice = `10,000 ${tokenSymbol} minted on the development chain.`;
      setTransactionNotice({ notice: successNotice, hash: receipt.hash }); setNotice(successNotice);
      await Promise.all([refresh(), refreshPortfolio()]);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); }
  }
  async function topUpGas(event: FormEvent) {
    event.preventDefault();
    if (!wallet) return;
    setBusy('Funding Gas account…'); setError(''); setNotice(''); setGasError('');
    try {
      const parsed = ethers.parseEther(gasAmount || '0');
      if (parsed <= 0n) throw new Error('Enter a Gas top-up amount greater than zero');
      const receipt = await topUpGasAccount({ config, mnemonic: wallet.mnemonic, amount: parsed });
      if (!receipt) throw new Error('The Gas top-up did not return a transaction hash. Check the network before retrying.');
      const successNotice = `Gas account funded with ${gasAmount} ${nativeCurrency} · ${short(receipt.hash, 8, 6)}`;
      setTransactionNotice({ notice: successNotice, hash: receipt.hash }); setNotice(successNotice);
      await refreshGas();
    } catch (cause) { setGasError(errorMessage(cause)); } finally { setBusy(''); }
  }

  if (mode === 'loading') return <main className="wallet-shell loading-screen"><Brand /><span className="loader" /></main>;

  return <main className="wallet-shell">
    <header className="app-header">
      <Brand />
      {mode === 'wallet'
        ? <div className="header-actions"><button className="network-button" onClick={() => setNetworkOpen(true)} aria-label="Select network"><span className={signer ? 'online' : ''} /><b>{config.name}</b><ChevronDown size={12} /></button><button className="icon-button" onClick={lock} aria-label="Lock wallet" title="Lock wallet"><LockKeyhole size={17} /></button></div>
        : <span className="local-badge"><span /> ON-DEVICE</span>}
    </header>

    {mode === 'welcome' && <section className="welcome-view">
      <div className="hero-symbol"><img className="hero-logo" src="./icons/logo-mark.png" alt="SWIRL" /></div>
      <p className="eyebrow">PRIVATE VALUE, YOUR KEYS</p>
      <h1>Your private wallet.<br /><span>Built into your browser.</span></h1>
      <p className="hero-copy">Shield assets, transfer private notes and unshield with real Groth16 proofs. Your recovery phrase is encrypted locally.</p>
      <div className="trust-row"><ShieldCheck size={16} /><span>No account. No remote key storage. No fabricated balances.</span></div>
      <button className="primary-button" onClick={() => changeMode('create')}><WalletCards size={17} /> Create private wallet</button>
      <button className="secondary-button" onClick={() => changeMode('import')}><KeyRound size={17} /> Import recovery phrase</button>
    </section>}

    {(mode === 'create' || mode === 'import') && <section className="form-view">
      <p className="eyebrow">{mode === 'create' ? 'NEW PRIVATE ACCOUNT' : 'RESTORE YOUR ACCOUNT'}</p>
      <h1>{mode === 'create' ? 'Create your wallet' : 'Import your wallet'}</h1>
      <p className="section-copy">{mode === 'create' ? 'Choose a strong password. It encrypts the recovery phrase stored in this browser profile.' : 'Enter your existing SWIRL recovery phrase. It is validated and encrypted on this device.'}</p>
      <form onSubmit={(event) => void createWallet(event, mode === 'import')}>
        {mode === 'import' && <><label className="field-label" htmlFor="wallet-mnemonic">Recovery phrase</label><textarea id="wallet-mnemonic" className="text-field phrase-input" value={mnemonic} onChange={(event) => setMnemonic(event.target.value)} placeholder="Enter your 24 words separated by spaces" autoComplete="off" spellCheck={false} required /></>}
        <PasswordFields {...{ password, confirmation, setPassword, setConfirmation }} />
        {walletExists && <div className="overwrite-warning"><p>This browser already contains an encrypted wallet. {mode === 'create' ? 'Creating a new wallet' : 'Importing'} will replace that local wallet record.</p><label className="backup-check"><input type="checkbox" checked={overwriteConfirmed} onChange={(event) => setOverwriteConfirmed(event.target.checked)} required /><span>I understand and want to replace it.</span></label></div>}
        <div className="security-hint"><ShieldCheck size={15} /><span>PBKDF2-SHA256 · AES-256-GCM</span></div>
        {error && <p className="error-message" role="alert">{error}</p>}
        <button className="primary-button" disabled={Boolean(busy)} type="submit">{busy ? <LoaderCircle className="spin" size={17} /> : <KeyRound size={17} />}{busy || (mode === 'create' ? 'Create encrypted wallet' : 'Import encrypted wallet')}</button>
      </form>
      <button className="text-button centered-button" onClick={() => changeMode(walletExists ? 'unlock' : 'welcome')}>{walletExists ? 'Back to unlock' : 'Back to welcome'}</button>
    </section>}

    {mode === 'backup' && wallet && <section className="form-view backup-view">
      <p className="eyebrow">RECOVERY BACKUP</p>
      <h1>Back up your wallet</h1>
      <p className="section-copy">Save both secrets offline before continuing. They are shown only on this device and give full control of your wallet.</p>
      <div className="backup-warning"><ShieldCheck size={17} /><span>Never share your recovery phrase or private key. SWIRL cannot recover them for you.</span></div>
      <div className="backup-secret">
        <div className="backup-secret-heading"><strong>24-word recovery phrase</strong><button type="button" className="icon-button small" onClick={() => void copyValue(wallet.mnemonic)} aria-label="Copy recovery phrase" title="Copy recovery phrase"><Copy size={15} /></button></div>
        <p className="recovery-phrase">{wallet.mnemonic}</p>
      </div>
      <div className="backup-secret">
        <div className="backup-secret-heading"><strong>EVM private key</strong><button type="button" className="icon-button small" onClick={() => void copyValue(evmPrivateKey)} aria-label="Copy EVM private key" title="Copy EVM private key"><Copy size={15} /></button></div>
        <p className="recovery-phrase private-key">{evmPrivateKey}</p>
      </div>
      <label className="backup-check backup-confirmation"><input type="checkbox" checked={backupConfirmed} onChange={(event) => setBackupConfirmed(event.target.checked)} /><span>I have saved my recovery phrase and private key in a safe place.</span></label>
      {error && <p className="error-message" role="alert">{error}</p>}
      <button className="primary-button" disabled={!backupConfirmed || Boolean(busy)} onClick={() => void finishBackup()}>{busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{busy || 'Continue to wallet'}</button>
      <p className="backup-footnote">You can reveal them again under Settings → Security &amp; recovery.</p>
    </section>}

    {mode === 'unlock' && <section className="form-view unlock-view">
      <div className="hero-symbol compact"><LockKeyhole size={30} /></div><p className="eyebrow">WELCOME BACK</p><h1>Unlock your wallet</h1>
      <p className="section-copy">Your encrypted wallet is stored in this browser profile. The password never leaves this device.</p>
      <form onSubmit={(event) => void unlock(event)}>
        <label className="field-label" htmlFor="unlock-password">Password</label>
        <input id="unlock-password" className="text-field" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" required autoFocus />
        {error && <p className="error-message" role="alert">{error}</p>}
        <button className="primary-button" disabled={Boolean(busy)} type="submit">{busy ? <LoaderCircle className="spin" size={17} /> : <LockKeyhole size={17} />}{busy || 'Unlock wallet'}</button>
      </form>
      <button className="secondary-button" onClick={() => changeMode('create')}><WalletCards size={17} /> Create new wallet</button>
      <button className="secondary-button" onClick={() => changeMode('import')}><KeyRound size={17} /> Import recovery phrase</button>
    </section>}

    {mode === 'wallet' && wallet && <>
      <section className="account-card">
        <div className="account-top"><span className="account-icon"><WalletCards size={19} /></span><div><span className="account-label">PRIVATE ACCOUNT</span><strong>Wallet unlocked</strong></div><span className="status-dot" /></div>
        <button className="account-address address-button" onClick={() => void copyValue(wallet.address)} title={wallet.address}>{short(wallet.address, 17, 10)}<Copy size={13} /></button>
        <div className="account-foot"><ShieldCheck size={14} /><span>{account || rpcReady(config) ? `EVM ${short(account || evmAddress, 8, 6)}` : 'No RPC configured'}</span></div>
      </section>

      {notice && <div className="message notice-message" role="status"><Check size={16} /><span>{notice}</span>{noticeTransactionUrl && <a href={noticeTransactionUrl} target="_blank" rel="noopener noreferrer">View transaction <ArrowUpRight size={12} /></a>}</div>}
      {error && <div className="message error-message" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}

      <div className="wallet-content">
        {tab === 'assets' && <section className="assets-view">
          {assetView === 'home' ? <PortfolioHome assets={config.assets} entries={portfolioEntries} syncing={portfolioSyncing} onRefresh={() => void refreshPortfolio()} onOpen={openAssetBucket} /> : <>
            <AssetCollection bucket={assetView} assets={config.assets} entries={portfolioEntries} selectedSymbol={asset?.symbol ?? ''} syncing={syncing || portfolioSyncing} onBack={() => setAssetView('home')} onRefresh={() => void Promise.all([refresh(), refreshPortfolio()])} onSelect={selectAsset} />
            {assetView === 'public' && config.chainId === 31337 && asset?.kind === 'erc20' && <button className="text-button mint-button collection-mint" onClick={() => void mint()} disabled={!signer || Boolean(busy)}><Plus size={13} /> Mint test {tokenSymbol || asset.symbol}</button>}
            <div className="action-tabs" role="tablist" aria-label="Transaction type">
              {((assetView === 'public' ? ['shield', 'transfer'] : ['transfer', 'unshield']) as Action[]).map((item) => <button key={item} role="tab" aria-selected={action === item} className={action === item ? 'selected' : ''} onClick={() => { setAction(item); if (item === 'transfer') setTransferKind(assetView === 'public' ? 'public' : 'private'); setRecipient(''); setSelectedNote(null); setError(''); setNotice(''); }}>{item === 'shield' ? 'Shield' : item === 'transfer' ? 'Transfer' : 'Unshield'}</button>)}
            </div>
            <form className="action-form" onSubmit={(event) => void submitAction(event)}>
              {action !== 'unshield' ? <>
                <label className="field-label" htmlFor="action-amount">AMOUNT <span>{tokenSymbol || asset?.symbol}</span></label>
                <div className="amount-input"><input id="action-amount" type="number" min="0" step="any" value={amount} onChange={(event) => { maxRequestId.current += 1; setAmount(event.target.value); }} required />{action === 'transfer' && <button type="button" className="max-button" aria-label="Use maximum transfer amount" onClick={() => void fillMaxTransfer()} disabled={Boolean(busy) || !signer}>MAX</button>}<span>{tokenSymbol || asset?.symbol}</span></div>
                {action === 'shield' && <div className="fee-line"><span>Protocol fee · {(config.feeBps / 100).toFixed(2)}%</span><span>Net note: {amount ? (Number(amount) * (1 - config.feeBps / 10_000)).toLocaleString() : '0'} {tokenSymbol || asset?.symbol}</span></div>}
              </> : <>
                <label className="field-label">SELECT AN UNSPENT NOTE</label>
                {synced.poiError && <p className="error-message" role="alert">PPOI status unavailable: {synced.poiError}. Private spending is temporarily disabled.</p>}
                <div className="note-list">{synced.notes.filter((item) => !item.spent).length === 0 && <div className="empty-notes">No unspent notes found.</div>}{synced.notes.filter((item) => !item.spent).map((item) => {
                  const spendable = isNoteSpendable(item, Boolean(config.poiNodeUrl));
                  const status = item.poiStatus?.replace('Shield', 'Shield ') ?? 'Unavailable';
                  return <button type="button" key={item.note.leafIndex} disabled={!spendable} title={config.poiNodeUrl ? `PPOI: ${status}` : 'Unspent note'} className={`note-item ${selectedNote?.note.leafIndex === item.note.leafIndex ? 'chosen' : ''}`} onClick={() => setSelectedNote(item)}><span>Note #{item.note.leafIndex}{config.poiNodeUrl && <small> · PPOI {status}</small>}</span><strong>{ethers.formatUnits(item.note.amount, decimals)} {tokenSymbol}</strong></button>;
                })}</div>
              </>}
              {action !== 'shield' && <><label className="field-label" htmlFor="action-recipient">{action === 'transfer' && transferKind === 'private' ? 'RECIPIENT SWIRL ADDRESS' : 'PUBLIC EVM RECIPIENT'}</label><input id="action-recipient" className="text-field" value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder={action === 'transfer' && transferKind === 'private' ? 'swirl1…' : '0x…'} spellCheck={false} required /></>}
              {action !== 'shield' && (action !== 'transfer' || transferKind === 'private') && <div className="fee-select"><label className="field-label" htmlFor="gas-payer">NETWORK FEE</label><select id="gas-payer" className="text-field" value={settings.submission === 'relayer' && (!relayerSupported || (action === 'unshield' && asset?.kind === 'native')) ? 'main' : settings.submission} onChange={(event) => changeSubmission(event.target.value as SubmissionPreference)}>{relayerSupported && !(action === 'unshield' && asset?.kind === 'native') && <option value="relayer">Relayer</option>}<option value="main">Main wallet</option><option value="gas">Gas account · {gasBalance === null ? '—' : ethers.formatEther(gasBalance)} {nativeCurrency}</option></select><p className="submission-explainer">{submissionExplanation}</p></div>}
              {relayerFeeAction && <div className="fee-line relayer-fee-line"><span>Relayer fee</span><span>{relayQuote ? `${ethers.formatUnits(relayQuote.feeAmount, decimals)} ${tokenSymbol}` : relayQuoteError || 'Loading quote…'}</span></div>}
              <button className="primary-button" disabled={Boolean(busy) || syncing || !signer} type="submit">{busy ? <LoaderCircle className="spin" size={17} /> : action === 'shield' ? <ArrowDownToLine size={17} /> : <ArrowUpRight size={17} />}{busy || (action === 'shield' ? 'Shield assets' : action === 'transfer' ? transferKind === 'public' ? 'Send publicly' : 'Prove & transfer' : 'Prove & unshield')}<ChevronRight size={16} /></button>
              {!signer && <p className="action-hint">{configReady ? 'Sync the configured SWIRL contracts to enable private token transfers.' : 'SWIRL private contracts are not configured on this chain. Ordinary EVM dApps and transfers remain available.'}</p>}
            </form>
          </>}
        </section>}

        {tab === 'receive' && <section className="receive-panel">
          <div className="segment-control"><button className={addressKind === 'private' ? 'active' : ''} onClick={() => setAddressKind('private')}>SWIRL private</button><button className={addressKind === 'evm' ? 'active' : ''} onClick={() => setAddressKind('evm')}>EVM receive</button></div>
          <div className="qr-frame"><canvas ref={qrRef} aria-label="Receiving address QR code" /></div>
          <p className="receive-title">{addressKind === 'private' ? 'Your swirl1 address' : 'Your EVM address'}</p>
          <button className="address-box" onClick={() => void copyValue(receiveAddress)} title={receiveAddress}><span>{short(receiveAddress, 18, 14)}</span>{copied ? <Check size={16} /> : <Copy size={16} />}</button>
          <p className="section-copy centered">{addressKind === 'private' ? `Share this address to receive private notes on chain ${config.chainId}.` : 'Derived at m/44\'/60\'/0\'/0/0 from the same recovery phrase.'}</p>
        </section>}

        {tab === 'activity' && <section className="activity-view">
          <div className="section-heading"><div><p className="eyebrow">ON THIS DEVICE</p><h2>Confirmed activity</h2></div><Activity size={20} /></div>
          {activities.length === 0 ? <div className="empty-state"><Activity size={25} /><strong>No local activity yet</strong><span>Confirmed transactions submitted by this extension will appear here.</span></div> : <div className="activity-list">{activities.map((item) => <button className="activity-item" key={item.id} onClick={() => void copyValue(item.transactionHash)} title={`Copy transaction ${item.transactionHash}`}><span className={`activity-icon ${item.kind}`}>{item.kind === 'shield' || item.kind === 'mint' ? <ArrowDownToLine size={16} /> : <ArrowUpRight size={16} />}</span><span><strong>{item.kind === 'transfer' ? 'Private transfer' : item.kind === 'public' ? 'Public transfer' : item.kind[0].toUpperCase() + item.kind.slice(1)}</strong><small>{new Date(item.timestamp).toLocaleString()} · {short(item.transactionHash, 8, 6)}</small></span><b>{item.amount} {item.assetSymbol ?? tokenSymbol}</b></button>)}</div>}
        </section>}

        {tab === 'settings' && <section className="settings-view">
          {legalDocument ? <LegalView kind={legalDocument} onBack={() => setLegalDocument(null)} /> : <>
          <div className="section-heading"><div><p className="eyebrow">SWIRL WALLET</p><h2>Settings</h2></div><Settings2 size={20} /></div>

          <SettingsSection id="gas-settings" title="Gas account" subtitle={`${gasBalance === null ? '0.000000' : Number(ethers.formatEther(gasBalance)).toFixed(6)} ${nativeCurrency} · ${config.name}`} icon={<Fuel size={17} />}>
            <button className="gas-address" onClick={() => void copyValue(dedicatedGasAddress)} title={dedicatedGasAddress}>{short(dedicatedGasAddress, 12, 10)}<Copy size={13} /></button>
            <div className="gas-balance"><strong>{gasBalance === null ? '0.000000' : Number(ethers.formatEther(gasBalance)).toFixed(6)}</strong><span>{nativeCurrency}</span><button className="icon-button small" onClick={() => void refreshGas()} aria-label="Refresh Gas account"><RefreshCw size={14} /></button></div>
            <form className="gas-topup" onSubmit={(event) => void topUpGas(event)}>
              <div className="amount-input"><input id="gas-topup-amount" aria-label="Gas top-up amount" type="number" min="0" step="any" value={gasAmount} onChange={(event) => setGasAmount(event.target.value)} required /><span>{nativeCurrency}</span></div>
              <button className="secondary-button" type="submit" disabled={Boolean(busy) || !rpcReady(config)}>{busy === 'Funding Gas account…' ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}Top up</button>
            </form>
            <p className="settings-hint">From your main EVM wallet. Top-ups are publicly linked.</p>
            {gasError && <p className="error-message" role="alert">{gasError}</p>}
            <div className="gas-estimator">
              <select id="gas-estimate-operation" aria-label="Gas estimate operation" className="text-field" value={gasOperation} onChange={(event) => setGasOperation(event.target.value as 'transfer' | 'unshield')}><option value="transfer">Private transfer</option><option value="unshield">Unshield</option></select>
              <select id="gas-estimate-count" aria-label="Gas estimate operation count" className="text-field" value={gasOperations} onChange={(event) => setGasOperations(Number(event.target.value))}>{[3, 5, 10, 20].map((count) => <option key={count} value={count}>{count} transactions</option>)}</select>
              <div><span>Estimated budget</span><strong>{gasEstimates.length ? `${Number(ethers.formatEther((gasEstimates.find((item) => item.operation === gasOperation)?.bufferedCost ?? 0n) * BigInt(gasOperations))).toFixed(6)} ${nativeCurrency}` : '—'}</strong></div>
            </div>
          </SettingsSection>

          <SettingsSection id="preference-settings" title="Wallet preferences" subtitle={`${submissionLabel} · auto-lock and synchronization`} icon={<Settings2 size={17} />}>
            <div className="settings-row"><div><strong>Private transaction submission</strong><small>Default for Transfer and Unshield</small></div><select id="default-submission" aria-label="Default private transaction submission" className="text-field" value={settings.submission} onChange={(event) => changeSubmission(event.target.value as SubmissionPreference)}><option value="relayer">Relayer</option><option value="main">Main wallet</option><option value="gas">Gas account</option></select></div>
            <p className="submission-explainer settings-submission-explainer">{submissionExplanation}</p>
            <div className="settings-row"><div><strong>Auto-lock</strong><small>After inactivity</small></div><select id="auto-lock-minutes" aria-label="Auto-lock timeout" className="text-field" value={settings.autoLockMinutes} onChange={(event) => { setLastActivity(Date.now()); updateSettings({ autoLockMinutes: Number(event.target.value) }); }}>{[1, 5, 15, 30].map((minutes) => <option key={minutes} value={minutes}>{minutes} minute{minutes === 1 ? '' : 's'}</option>)}<option value={0}>Never</option></select></div>
            <div className="settings-row"><div><strong>Sync wallet</strong><small>{leafCount ?? 0} tree leaves · {synced.notes.filter((note) => !note.spent).length} spendable notes</small></div><button id="settings-resync" className="secondary-button compact-button" onClick={() => void Promise.all([refresh(), refreshGas(), refreshPortfolio()])} disabled={syncing || Boolean(busy)}><RefreshCw className={syncing ? 'spin' : ''} size={14} />Sync now</button></div>
          </SettingsSection>

          <SettingsSection id="network-settings" title="Visible networks" subtitle="Fixed SWIRL network list" icon={<Globe2 size={17} />}>
            <div className="network-toggles">{networks.map((item) => {
              const visible = item.chainId === config.chainId || !settings.hiddenChainIds.includes(item.chainId);
              return <button key={item.chainId} role="switch" aria-checked={visible} aria-label={`Show ${item.name}`} disabled={item.chainId === config.chainId} onClick={() => updateSettings({ hiddenChainIds: visible ? [...settings.hiddenChainIds, item.chainId] : settings.hiddenChainIds.filter((id) => id !== item.chainId) })}><span>{item.name}</span><span className={`toggle ${visible ? 'on' : ''}`}><span /></span></button>;
            })}</div>
          </SettingsSection>

          <SettingsSection id="security-settings" title="Security & recovery" subtitle="Encrypted on this device" icon={<ShieldCheck size={17} />}>
            <div className="phrase-section"><div><strong>Recovery phrase</strong><span>Controls your wallet</span></div><button className="secondary-button compact-button" onClick={() => setShowPhrase((value) => !value)}>{showPhrase ? <EyeOff size={15} /> : <Eye size={15} />}{showPhrase ? 'Hide secrets' : 'Reveal secrets'}</button>{showPhrase && <><p className="recovery-phrase">{wallet.mnemonic}</p><div className="settings-private-key"><strong>EVM private key</strong><p className="recovery-phrase private-key">{evmPrivateKey}</p></div></>}</div>
            <div className="phrase-section"><div><strong>Viewing key</strong><span>Reveals private note data; cannot spend</span></div><button className="secondary-button compact-button" onClick={() => setShowViewingKey((value) => !value)}>{showViewingKey ? <EyeOff size={15} /> : <Eye size={15} />}{showViewingKey ? 'Hide key' : 'Reveal key'}</button>{showViewingKey && <p className="recovery-phrase viewing-key">{ethers.hexlify(wallet.viewingSecretKey)}</p>}</div>
          </SettingsSection>

          <SettingsSection id="help-settings" title="Help & legal" subtitle="Support, Terms and Privacy" icon={<CircleHelp size={17} />}>
            <div className="settings-link-list">
              <a className="settings-link" href="https://x.com/swirlbtc" target="_blank" rel="noopener noreferrer"><span><CircleHelp size={15} />Help & feedback</span><ArrowUpRight size={14} /></a>
              <button className="settings-link" onClick={() => setLegalDocument('terms')}><span><FileText size={15} />Terms of Service</span><ChevronRight size={14} /></button>
              <button className="settings-link" onClick={() => setLegalDocument('privacy')}><span><ShieldCheck size={15} />Privacy Policy</span><ChevronRight size={14} /></button>
            </div>
          </SettingsSection>
          </>}
        </section>}
      </div>

      {networkOpen && <div className="modal-backdrop" onClick={() => setNetworkOpen(false)}>
        <section className="network-modal" role="dialog" aria-modal="true" aria-labelledby="network-modal-title" onClick={(event) => event.stopPropagation()}>
          <div className="modal-heading"><div><p className="eyebrow">SUPPORTED NETWORKS</p><h2 id="network-modal-title">Choose a network</h2></div><button className="icon-button small" onClick={() => setNetworkOpen(false)} aria-label="Close network selector"><X size={17} /></button></div>
          <div className="network-list">{visibleNetworks.map((item) => {
            const enabled = item.chainId === 1 || item.chainId === 11155111;
            return <button key={item.chainId} className={`network-option ${config.chainId === item.chainId ? 'current' : ''} ${enabled ? '' : 'unavailable'}`} onClick={() => void selectNetwork(item.chainId)} disabled={Boolean(busy) || !enabled}>
              <span className="network-option-icon"><Globe2 size={17} /></span><span className="network-option-copy"><strong>{item.name}</strong><small>Chain ID · {item.chainId}</small></span><span className={`network-status ${enabled && rpcReady(item) ? 'ready' : ''}`}>{config.chainId === item.chainId ? 'CURRENT' : !enabled ? 'SOON' : protocolReady(item) ? 'PRIVATE' : 'EVM'}</span>
            </button>;
          })}</div>
          <p className="network-modal-note">Ethereum and Sepolia are available. Other networks are coming soon.</p>
        </section>
      </div>}

      <nav className="bottom-nav" aria-label="Wallet sections">
        <button className={tab === 'assets' ? 'active' : ''} onClick={() => { setTab('assets'); setAssetView('home'); setLegalDocument(null); }}><WalletCards size={17} /><span>Assets</span></button>
        <button className={tab === 'receive' ? 'active' : ''} onClick={() => { setTab('receive'); setLegalDocument(null); }}><ArrowDownToLine size={17} /><span>Receive</span></button>
        <button className={tab === 'activity' ? 'active' : ''} onClick={() => { setTab('activity'); setLegalDocument(null); }}><Activity size={17} /><span>Activity</span></button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => { setTab('settings'); setLegalDocument(null); }}><Settings2 size={17} /><span>Settings</span></button>
      </nav>
    </>}
  </main>;
}
