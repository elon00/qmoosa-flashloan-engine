import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  FlashLoanEngine,
  AdminAuthManager,
  ERC3156_CALLBACK_SUCCESS
} from "../dist/index.js";

function setupEngine() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });

  const engine = new FlashLoanEngine(publicKey, "0xProtocolTreasury", 31337);
  engine.registerPoolDirect("USDC", 9n); // 9 bps
  engine.registerPoolDirect("WETH", 5n); // 5 bps

  return { engine, publicKey, privateKey };
}

test("1. Deposit and Withdraw Liquidity with LP shares", () => {
  const { engine } = setupEngine();

  // User A deposits 1,000,000 USDC
  const dep1 = engine.depositLiquidity("0xUserA", "USDC", 1_000_000n);
  assert.equal(dep1.shares, 1_000_000n);
  assert.equal(dep1.totalLiquidity, 1_000_000n);

  // User B deposits 500,000 USDC
  const dep2 = engine.depositLiquidity("0xUserB", "USDC", 500_000n);
  assert.equal(dep2.shares, 500_000n);
  assert.equal(dep2.totalLiquidity, 1_500_000n);

  // User A withdraws 500,000 shares
  const with1 = engine.withdrawLiquidity("0xUserA", "USDC", 500_000n);
  assert.equal(with1.amount, 500_000n);
  assert.equal(with1.remainingShares, 500_000n);

  const reserve = engine.getReserve("USDC");
  assert.equal(reserve.totalLiquidity, 1_000_000n);
  assert.equal(reserve.totalShares, 1_000_000n);
});

test("2. Successful Flash Loan Execution with Fee Distribution", async () => {
  const { engine } = setupEngine();
  engine.depositLiquidity("0xLpProvider", "USDC", 10_000_000n);

  // Arbitrage Borrower Contract
  const receiver = {
    address: "0xArbitrageurContract",
    async onFlashLoan(initiator, token, amount, fee, data) {
      assert.equal(token, "USDC");
      assert.equal(amount, 1_000_000n);
      assert.equal(fee, 900n); // 1,000,000 * 9 / 10,000 = 900
      // Returns exact standard success hash
      return ERC3156_CALLBACK_SUCCESS;
    }
  };

  const receipt = await engine.flashLoan(receiver, "USDC", 1_000_000n, "0xArbitrageParams", {
    initiator: "0xArbitrageurTrader",
    simulateRepayment: () => true
  });

  assert.equal(receipt.success, true);
  assert.equal(receipt.amount, 1_000_000n);
  assert.equal(receipt.fee, 900n);
  assert.equal(receipt.protocolFeeAccrued, 270n); // 30% of 900
  assert.equal(receipt.poolFeeAccrued, 630n); // 70% of 900

  // Reserve totalLiquidity has grown by the pool's fee share (630 USDC)
  const reserve = engine.getReserve("USDC");
  assert.equal(reserve.totalLiquidity, 10_000_630n);
  assert.equal(reserve.accruedProtocolFees, 270n);
});

test("3. Reentrancy Guard Strictly Rejects Nested Flash Loans", async () => {
  const { engine } = setupEngine();
  engine.depositLiquidity("0xLpProvider", "USDC", 10_000_000n);

  const maliciousReceiver = {
    address: "0xMaliciousAttacker",
    async onFlashLoan(initiator, token, amount, fee, data) {
      // Attempt reentrant flash loan call during callback execution
      await engine.flashLoan(this, token, amount, data);
      return ERC3156_CALLBACK_SUCCESS;
    }
  };

  await assert.rejects(
    () => engine.flashLoan(maliciousReceiver, "USDC", 500_000n),
    /REENTRANCY_GUARD_TRIGGERED/
  );

  // Verify pool liquidity was not drained or corrupted
  const reserve = engine.getReserve("USDC");
  assert.equal(reserve.totalLiquidity, 10_000_000n);
});

test("4. Invalid Callback Return Hash Triggers Immediate Atomic Rollback", async () => {
  const { engine } = setupEngine();
  engine.depositLiquidity("0xLpProvider", "USDC", 10_000_000n);

  const bogusReceiver = {
    address: "0xBogusReceiver",
    async onFlashLoan() {
      // Returns invalid non-ERC-3156 hash
      return "0x0000000000000000000000000000000000000000000000000000000000000000";
    }
  };

  await assert.rejects(
    () => engine.flashLoan(bogusReceiver, "USDC", 1_000_000n),
    /ERC3156_CALLBACK_FAILED/
  );

  // Verify zero state mutation
  const reserve = engine.getReserve("USDC");
  assert.equal(reserve.totalLiquidity, 10_000_000n);
  assert.equal(reserve.accruedProtocolFees, 0n);
});

test("5. Insolvent Borrower Repayment Failure Triggers Atomic Rollback", async () => {
  const { engine } = setupEngine();
  engine.depositLiquidity("0xLpProvider", "USDC", 10_000_000n);

  const insolventReceiver = {
    address: "0xInsolventReceiver",
    async onFlashLoan() {
      return ERC3156_CALLBACK_SUCCESS;
    }
  };

  await assert.rejects(
    () =>
      engine.flashLoan(insolventReceiver, "USDC", 2_000_000n, "", {
        simulateRepayment: () => false // Failed repayment simulation
      }),
    /REPAYMENT_INSUFFICIENT_OR_FAILED/
  );

  // Verify state integrity preserved
  const reserve = engine.getReserve("USDC");
  assert.equal(reserve.totalLiquidity, 10_000_000n);
  assert.equal(engine.getVaultBalance("USDC"), 10_000_000n);
});

test("5b. Absent Repayment Options Fails Closed With Immediate Rollback (P0)", async () => {
  const { engine } = setupEngine();
  engine.depositLiquidity("0xLpProvider", "USDC", 10_000_000n);

  const nonRepayingReceiver = {
    address: "0xNonRepayingBorrower",
    async onFlashLoan() {
      // Returns success callback hash but performs no repayment whatsoever
      return ERC3156_CALLBACK_SUCCESS;
    }
  };

  // Calling without any repayment options MUST fail closed
  await assert.rejects(
    () => engine.flashLoan(nonRepayingReceiver, "USDC", 2_000_000n),
    /REPAYMENT_INSUFFICIENT_OR_FAILED/
  );

  // Verify zero state mutation: liquidity and vault balance untouched
  const reserve = engine.getReserve("USDC");
  assert.equal(reserve.totalLiquidity, 10_000_000n);
  assert.equal(engine.getVaultBalance("USDC"), 10_000_000n);
  assert.equal(reserve.accruedProtocolFees, 0n);
});

test("5c. Direct In-Callback Repayment via repayFlashLoan Succeeds", async () => {
  const { engine } = setupEngine();
  engine.depositLiquidity("0xLpProvider", "USDC", 10_000_000n);

  const directRepayingReceiver = {
    address: "0xDirectRepayingBorrower",
    async onFlashLoan(initiator, token, amount, fee) {
      // Repay amount + fee directly to the engine vault during callback
      engine.repayFlashLoan(token, amount + fee);
      return ERC3156_CALLBACK_SUCCESS;
    }
  };

  const receipt = await engine.flashLoan(directRepayingReceiver, "USDC", 1_000_000n);
  assert.equal(receipt.success, true);
  assert.equal(receipt.amount, 1_000_000n);
  assert.equal(receipt.fee, 900n);
  assert.equal(engine.getVaultBalance("USDC"), 10_000_900n);
});

test("6. Asymmetric Cryptographic Admin Intents & Monotonic Replay Protection", () => {
  const { engine, privateKey } = setupEngine();
  const domain = engine.getAuthManager().getExpectedDomain();
  const now = Math.floor(Date.now() / 1000);

  // Intent 1: Update USDC fee to 12 bps
  const intent1 = AdminAuthManager.signAdminIntent(
    "SET_FEE_BPS",
    { token: "USDC", feeBps: 12 },
    1,
    now + 300,
    domain,
    privateKey
  );

  engine.executeAdminIntent(intent1);
  assert.equal(engine.getReserve("USDC").feeBps, 12n);

  // Replay intent 1 -> Must reject
  assert.throws(
    () => engine.executeAdminIntent(intent1),
    /Nonce replay rejected/
  );

  // Intent 2: Pause WETH pool
  const intent2 = AdminAuthManager.signAdminIntent(
    "SET_PAUSED",
    { token: "WETH", isPaused: true },
    2,
    now + 300,
    domain,
    privateKey
  );

  engine.executeAdminIntent(intent2);
  assert.equal(engine.getReserve("WETH").isPaused, true);
  assert.equal(engine.maxFlashLoan("WETH"), 0n);
});
