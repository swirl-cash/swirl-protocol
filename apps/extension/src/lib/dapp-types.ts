export type RpcError = { code: number; message: string; data?: unknown };

export type PendingApproval = {
  id: string;
  origin: string;
  tabId: number;
  method: 'eth_requestAccounts' | 'wallet_switchEthereumChain' | 'personal_sign' | 'eth_sendTransaction';
  params: unknown[];
  chainId: number;
  createdAt: number;
};

export type ApprovalDecision = {
  approved: boolean;
  account?: string;
  signature?: string;
  transactionHash?: string;
  error?: string;
};

export type RequestAck =
  | { id: string; status: 'pending' }
  | { id: string; status: 'done'; result?: unknown; error?: RpcError };

export const PAGE_SOURCE = 'swirl-page';
export const CONTENT_SOURCE = 'swirl-content';
export const BACKGROUND_SOURCE = 'swirl-background';
export const EXTENSION_SOURCE = 'swirl-extension';
