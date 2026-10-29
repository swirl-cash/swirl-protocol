import { ethers } from 'ethers';
import { ArrowLeft, ArrowUpRight, ChevronRight, RefreshCw, ShieldCheck, WalletCards } from 'lucide-react';
import type { AssetConfig } from '../lib/network';
import { formatUsd, usdValue } from '../lib/prices';

export type AssetBucket = 'home' | 'public' | 'private';
export type PortfolioEntry = {
  publicAmount: bigint;
  privateAmount: bigint;
  noteCount: number;
  price: number;
  loaded: boolean;
  error?: string;
};

export function formatAssetAmount(amount: bigint, decimals: number): string {
  const [whole, fraction = ''] = ethers.formatUnits(amount, decimals).split('.');
  const trimmed = fraction.slice(0, 8).replace(/0+$/, '') || '0';
  return `${whole}.${trimmed}`;
}

function totalValue(assets: AssetConfig[], entries: Record<string, PortfolioEntry>, bucket: Exclude<AssetBucket, 'home'> | 'all'): number {
  return assets.reduce((total, asset) => {
    const entry = entries[asset.token];
    if (!entry?.loaded) return total;
    const amount = bucket === 'all' ? entry.publicAmount + entry.privateAmount : bucket === 'public' ? entry.publicAmount : entry.privateAmount;
    return total + usdValue(amount, asset.decimals, entry.price);
  }, 0);
}

export function PortfolioHome({ assets, entries, syncing, onRefresh, onOpen }: {
  assets: AssetConfig[];
  entries: Record<string, PortfolioEntry>;
  syncing: boolean;
  onRefresh: () => void;
  onOpen: (bucket: Exclude<AssetBucket, 'home'>) => void;
}) {
  const unavailable = assets.some((asset) => entries[asset.token]?.error);
  return <div className="portfolio-home">
    <div className="portfolio-overview">
      <div className="card-topline"><span>TOTAL ESTIMATED VALUE</span><button className="icon-button small" onClick={onRefresh} disabled={syncing} aria-label="Refresh all assets"><RefreshCw className={syncing ? 'spin' : ''} size={15} /></button></div>
      <div className="portfolio-value">{formatUsd(totalValue(assets, entries, 'all'))}</div>
      <span className="portfolio-network">{assets.length} assets · public and private</span>
    </div>
    {unavailable && <p className="portfolio-warning">Some balances are temporarily unavailable. Open a section to retry.</p>}
    <div className="asset-gateways">
      <button className="asset-gateway public-gateway" onClick={() => onOpen('public')}>
        <span className="gateway-top"><span className="gateway-icon"><WalletCards size={19} /></span><ArrowUpRight size={16} /></span>
        <strong>Public assets</strong>
        <b>{formatUsd(totalValue(assets, entries, 'public'))}</b>
        <small>{assets.length} assets · public wallet</small>
      </button>
      <button className="asset-gateway private-gateway" onClick={() => onOpen('private')}>
        <span className="gateway-top"><span className="gateway-icon"><ShieldCheck size={19} /></span><ArrowUpRight size={16} /></span>
        <strong>Private assets</strong>
        <b>{formatUsd(totalValue(assets, entries, 'private'))}</b>
        <small>{assets.length} assets · shielded notes</small>
      </button>
    </div>
    <div className="portfolio-explainer"><ShieldCheck size={15} /><span>Public balances live in your EVM account. Private balances are held as encrypted notes.</span></div>
  </div>;
}

export function AssetCollection({ bucket, assets, entries, selectedSymbol, syncing, onBack, onRefresh, onSelect }: {
  bucket: Exclude<AssetBucket, 'home'>;
  assets: AssetConfig[];
  entries: Record<string, PortfolioEntry>;
  selectedSymbol: string;
  syncing: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onSelect: (symbol: string) => void;
}) {
  const title = bucket === 'public' ? 'Public assets' : 'Private assets';
  return <div className={`asset-collection ${bucket}-collection`}>
    <div className="collection-heading">
      <button className="icon-button small back-button" onClick={onBack} aria-label="Back to asset overview"><ArrowLeft size={18} /></button>
      <span className="collection-label">{bucket === 'public' ? <WalletCards size={14} /> : <ShieldCheck size={14} />}{title}</span>
      <button className="icon-button small" onClick={onRefresh} disabled={syncing} aria-label={`Refresh ${bucket} assets`}><RefreshCw className={syncing ? 'spin' : ''} size={15} /></button>
    </div>
    <div className="collection-total"><span>ESTIMATED {bucket.toUpperCase()} VALUE</span><div className="portfolio-value">{formatUsd(totalValue(assets, entries, bucket))}</div></div>
    <div className="asset-list-heading"><span>ASSETS</span><small>Select an asset to transact</small></div>
    <div className="asset-list">
      {assets.map((asset) => {
        const entry = entries[asset.token];
        const amount = entry ? bucket === 'public' ? entry.publicAmount : entry.privateAmount : 0n;
        const selected = selectedSymbol === asset.symbol;
        return <button key={asset.token} className={`asset-list-row ${bucket === 'public' ? 'public-row' : ''} ${selected ? 'selected' : ''}`} onClick={() => onSelect(asset.symbol)} aria-pressed={selected}>
          <span className={`asset-token-icon ${asset.kind}`}>{asset.symbol.slice(0, 1)}</span>
          <span className="asset-token-copy"><strong>{asset.symbol}</strong><small>{asset.name}</small></span>
          <span className="asset-token-value">
            <strong className={bucket === 'private' && selected ? 'private-balance' : ''}>{entry?.error ? 'Unavailable' : `${entry?.loaded ? formatAssetAmount(amount, asset.decimals) : '—'} ${asset.symbol}`}</strong>
            <small>{entry?.error ? 'Sync failed' : entry?.loaded ? formatUsd(usdValue(amount, asset.decimals, entry.price)) : 'Loading…'}</small>
          </span>
          <ChevronRight className="asset-row-chevron" size={14} />
        </button>;
      })}
    </div>
  </div>;
}
