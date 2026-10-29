type ErrorCandidate = {
  code?: string | number;
  shortMessage?: string;
  reason?: string;
  message?: string;
  info?: { error?: { code?: string | number; message?: string } };
  error?: { code?: string | number; message?: string };
};

export function errorMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error || 'Operation failed');
  const candidate = error as ErrorCandidate;
  const code = candidate.code ?? candidate.info?.error?.code ?? candidate.error?.code;
  const raw = candidate.shortMessage || candidate.reason || candidate.message || candidate.info?.error?.message || candidate.error?.message || 'Operation failed';
  const text = String(raw);
  const lower = text.toLowerCase();

  if (code === 'ACTION_REJECTED' || code === 4001 || code === '4001' || /user (rejected|denied)|rejected the request/.test(lower)) {
    return 'Request cancelled. No new transaction was submitted.';
  }
  if (code === 'INSUFFICIENT_FUNDS' || /insufficient funds|insufficient balance|gas.*too low|fee.*too low/.test(lower)) {
    return 'Insufficient balance for the amount and network Gas. Top up the selected fee-paying account, then retry.';
  }
  if (/invalidroot|invalid merkle root|unknown root/.test(lower)) {
    return 'The Merkle root is no longer current. Sync your wallet, review the transaction, then retry.';
  }
  if (/invalidproof|proof.*(invalid|rejected)|groth16.*fail/.test(lower)) {
    return 'The zero-knowledge proof was rejected. Sync your wallet and recreate the transaction.';
  }
  if (/duplicatenullifier|nullifier.*(spent|used|duplicate)|already spent/.test(lower)) {
    return 'This note has already been spent. Sync your wallet before creating another transaction.';
  }
  if (code === 'NONCE_EXPIRED' || code === 'REPLACEMENT_UNDERPRICED' || /nonce.*(already|used|low)|replacement transaction underpriced/.test(lower)) {
    return 'A transaction with this nonce already exists. Check its status before sending again.';
  }
  if (code === 'TIMEOUT' || code === 'NETWORK_ERROR' || code === 'SERVER_ERROR' || /timeout|timed out|failed to fetch|network error|connection refused|socket|502|503|504/.test(lower)) {
    return 'The network request failed or timed out. Check Activity and the network before retrying; a submitted transaction may still confirm.';
  }
  if (/execution reverted|contract rejected|call_exception/.test(lower)) {
    return 'The contract rejected this transaction. Sync balances and notes, and verify the amount, recipient and fee payer before retrying.';
  }
  if (/incorrect password|damaged encrypted wallet/.test(lower)) return 'Incorrect password or damaged encrypted wallet';
  return text.length > 420 ? `${text.slice(0, 417)}…` : text;
}

export function transactionExplorer(chainId: number, hash: string): string {
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) return '';
  const hosts: Record<number, string> = {
    1: 'https://etherscan.io',
    56: 'https://bscscan.com',
    137: 'https://polygonscan.com',
    42161: 'https://arbiscan.io',
    11155111: 'https://sepolia.etherscan.io',
    80002: 'https://amoy.polygonscan.com',
  };
  return hosts[chainId] ? `${hosts[chainId]}/tx/${hash}` : '';
}
