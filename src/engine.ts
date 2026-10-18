import {
  ERC3156_CALLBACK_SUCCESS,
  IERC3156FlashBorrower,
  FlashLoanReceipt,
  PoolReserve,
  SignedAdminIntent
} from "./types.js";
import { AdminAuthManager } from "./auth.js";

export interface FlashLoanExecutionOptions {
  initiator?: string;
  simulateRepayment?: (repayAmount: bigint) => Promise<boolean> | boolean;
}

export class FlashLoanEngine {
  private readonly reserves: Map<string, PoolReserve> = new Map();
  private readonly lpBalances: Map<string, Map<string, bigint>> = new Map();
  private protocolShareBps: bigint = 3000n; // 30% protocol treasury, 70% LP pool
  private treasuryAddress: string;
  private readonly authManager: AdminAuthManager;
  private _locked: boolean = false;

  constructor(adminPublicKey: string, treasuryAddress: string = "0xTreasury", chainId: number = 31337) {
    this.treasuryAddress = treasuryAddress;
    this.authManager = new AdminAuthManager(adminPublicKey, chainId);
  }

  public getAuthManager(): AdminAuthManager {
    return this.authManager;
  }

  public getReserve(token: string): PoolReserve | undefined {
    const res = this.reserves.get(token.toUpperCase());
    if (!res) return undefined;
    return { ...res };
  }

  public getAllReserves(): PoolReserve[] {
    return Array.from(this.reserves.values()).map(r => ({ ...r }));
  }

  public registerPoolDirect(token: string, initialFeeBps: bigint = 9n): void {
    const symbol = token.toUpperCase();
    if (this.reserves.has(symbol)) {
      throw new Error(`Pool already exists for token ${symbol}`);
    }
    if (initialFeeBps > 1000n) {
      throw new Error("Fee exceeds maximum allowable 1000 bps");
    }
    this.reserves.set(symbol, {
      token: symbol,
      totalLiquidity: 0n,
      totalShares: 0n,
      accruedProtocolFees: 0n,
      feeBps: initialFeeBps,
      isPaused: false
    });
    this.lpBalances.set(symbol, new Map());
  }

  public depositLiquidity(user: string, token: string, amount: bigint): { shares: bigint; totalLiquidity: bigint } {
    if (amount <= 0n) {
      throw new Error("ZERO_AMOUNT_NOT_PERMITTED");
    }
    const symbol = token.toUpperCase();
    const reserve = this.reserves.get(symbol);
    if (!reserve) {
      throw new Error(`UNSUPPORTED_TOKEN: ${symbol}`);
    }
    if (reserve.isPaused) {
      throw new Error("POOL_TEMPORARILY_PAUSED");
    }

    let shares: bigint;
    if (reserve.totalShares === 0n || reserve.totalLiquidity === 0n) {
      shares = amount;
    } else {
      shares = (amount * reserve.totalShares) / reserve.totalLiquidity;
    }

    reserve.totalLiquidity += amount;
    reserve.totalShares += shares;

    const userSharesMap = this.lpBalances.get(symbol)!;
    const currentShares = userSharesMap.get(user) || 0n;
    userSharesMap.set(user, currentShares + shares);

    return { shares, totalLiquidity: reserve.totalLiquidity };
  }

  public withdrawLiquidity(user: string, token: string, shares: bigint): { amount: bigint; remainingShares: bigint } {
    if (shares <= 0n) {
      throw new Error("ZERO_AMOUNT_NOT_PERMITTED");
    }
    const symbol = token.toUpperCase();
    const reserve = this.reserves.get(symbol);
    if (!reserve) {
      throw new Error(`UNSUPPORTED_TOKEN: ${symbol}`);
    }

    const userSharesMap = this.lpBalances.get(symbol)!;
    const currentShares = userSharesMap.get(user) || 0n;
    if (shares > currentShares) {
      throw new Error(`INSUFFICIENT_SHARES: User owns ${currentShares}, requested ${shares}`);
    }
    if (shares > reserve.totalShares) {
      throw new Error("INSUFFICIENT_POOL_SHARES");
    }

    const amount = (shares * reserve.totalLiquidity) / reserve.totalShares;

    reserve.totalLiquidity -= amount;
    reserve.totalShares -= shares;
    const remainingShares = currentShares - shares;
    userSharesMap.set(user, remainingShares);

    return { amount, remainingShares };
  }

  public maxFlashLoan(token: string): bigint {
    const reserve = this.reserves.get(token.toUpperCase());
    if (!reserve || reserve.isPaused) {
      return 0n;
    }
    return reserve.totalLiquidity;
  }

  public flashFee(token: string, amount: bigint): bigint {
    if (amount <= 0n) {
      throw new Error("ZERO_AMOUNT_NOT_PERMITTED");
    }
    const reserve = this.reserves.get(token.toUpperCase());
    if (!reserve) {
      throw new Error(`UNSUPPORTED_TOKEN: ${token}`);
    }
    if (reserve.feeBps === 0n) return 0n;
    return (amount * reserve.feeBps + 9999n) / 10000n;
  }

  public async flashLoan(
    receiver: IERC3156FlashBorrower,
    token: string,
    amount: bigint,
    data: string = "",
    options?: FlashLoanExecutionOptions
  ): Promise<FlashLoanReceipt> {
    const symbol = token.toUpperCase();
    const reserve = this.reserves.get(symbol);
    if (!reserve) {
      throw new Error(`UNSUPPORTED_TOKEN: ${symbol}`);
    }
    if (reserve.isPaused) {
      throw new Error("POOL_TEMPORARILY_PAUSED");
    }
    if (amount <= 0n) {
      throw new Error("ZERO_AMOUNT_NOT_PERMITTED");
    }
    if (amount > reserve.totalLiquidity) {
      throw new Error(`INSUFFICIENT_LIQUIDITY: Requested ${amount}, available ${reserve.totalLiquidity}`);
    }

    // STRICT REENTRANCY GUARD
    if (this._locked) {
      throw new Error("REENTRANCY_GUARD_TRIGGERED: Reentrant flash loan call prohibited");
    }
    this._locked = true;

    const fee = this.flashFee(symbol, amount);
    const snapshotLiquidity = reserve.totalLiquidity;
    const snapshotProtocolFees = reserve.accruedProtocolFees;
    const initiator = options?.initiator || "0xInitiator";

    try {
      // Simulate optimistic transfer of principal to borrower
      reserve.totalLiquidity -= amount;

      // Execute borrower's ERC-3156 callback
      const callbackResult = await receiver.onFlashLoan(initiator, symbol, amount, fee, data);

      if (callbackResult !== ERC3156_CALLBACK_SUCCESS) {
        throw new Error(`ERC3156_CALLBACK_FAILED: Invalid return hash received '${callbackResult}'`);
      }

      // Verify repayment (principal + fee)
      if (options?.simulateRepayment) {
        const repaid = await options.simulateRepayment(amount + fee);
        if (!repaid) {
          throw new Error("REPAYMENT_INSUFFICIENT_OR_FAILED: Borrower failed to return principal and fee");
        }
      }

      // Compute fee split
      const protocolFee = (fee * this.protocolShareBps) / 10000n;
      const poolFee = fee - protocolFee;

      // Invariant conservation: pool fee grows reserve, protocol fee grows accrued treasury
      reserve.totalLiquidity = snapshotLiquidity + poolFee;
      reserve.accruedProtocolFees = snapshotProtocolFees + protocolFee;

      return {
        txId: `tx_flash_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        token: symbol,
        receiver: (receiver as any).address || "0xBorrowerContract",
        amount,
        fee,
        poolFeeAccrued: poolFee,
        protocolFeeAccrued: protocolFee,
        timestamp: Date.now(),
        success: true
      };
    } catch (err: any) {
      // ATOMIC ROLLBACK: Guaranteed zero state mutation
      reserve.totalLiquidity = snapshotLiquidity;
      reserve.accruedProtocolFees = snapshotProtocolFees;
      throw err;
    } finally {
      this._locked = false;
    }
  }

  public executeAdminIntent(intent: SignedAdminIntent): void {
    this.authManager.verifyAndConsume(intent);

    switch (intent.action) {
      case "REGISTER_POOL": {
        const { token, feeBps } = intent.params;
        this.registerPoolDirect(token, BigInt(feeBps || 9));
        break;
      }
      case "SET_FEE_BPS": {
        const { token, feeBps } = intent.params;
        const res = this.reserves.get(token.toUpperCase());
        if (!res) throw new Error(`UNSUPPORTED_TOKEN: ${token}`);
        const bps = BigInt(feeBps);
        if (bps > 1000n) throw new Error("Fee exceeds 1000 bps ceiling");
        res.feeBps = bps;
        break;
      }
      case "SET_PROTOCOL_SHARE": {
        const { protocolShareBps } = intent.params;
        const bps = BigInt(protocolShareBps);
        if (bps > 10000n) throw new Error("Protocol share exceeds 10000 bps");
        this.protocolShareBps = bps;
        break;
      }
      case "SET_PAUSED": {
        const { token, isPaused } = intent.params;
        const res = this.reserves.get(token.toUpperCase());
        if (!res) throw new Error(`UNSUPPORTED_TOKEN: ${token}`);
        res.isPaused = Boolean(isPaused);
        break;
      }
      case "WITHDRAW_PROTOCOL_FEES": {
        const { token } = intent.params;
        const res = this.reserves.get(token.toUpperCase());
        if (!res) throw new Error(`UNSUPPORTED_TOKEN: ${token}`);
        res.accruedProtocolFees = 0n;
        break;
      }
      default:
        throw new Error(`Unsupported admin action: ${intent.action}`);
    }
  }
}
