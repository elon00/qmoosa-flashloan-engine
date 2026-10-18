export const ERC3156_CALLBACK_SUCCESS = "0x439148f0bbc682ca079e46d6e2c2f0c1e3b820f1a2978069302701048fe0994b";

export interface IERC3156FlashBorrower {
  onFlashLoan(
    initiator: string,
    token: string,
    amount: bigint,
    fee: bigint,
    data: string
  ): Promise<string> | string;
}

export interface FlashLoanReceipt {
  txId: string;
  token: string;
  receiver: string;
  amount: bigint;
  fee: bigint;
  poolFeeAccrued: bigint;
  protocolFeeAccrued: bigint;
  timestamp: number;
  success: boolean;
}

export interface PoolReserve {
  token: string;
  totalLiquidity: bigint;
  totalShares: bigint;
  accruedProtocolFees: bigint;
  feeBps: bigint;
  isPaused: boolean;
}

export type AdminActionType =
  | "REGISTER_POOL"
  | "SET_FEE_BPS"
  | "SET_PROTOCOL_SHARE"
  | "SET_PAUSED"
  | "WITHDRAW_PROTOCOL_FEES";

export interface SignedAdminIntent {
  action: AdminActionType;
  params: Record<string, any>;
  nonce: number;
  deadline: number;
  domain: string;
  signature: string;
}
