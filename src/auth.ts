import crypto from "node:crypto";
import { SignedAdminIntent, AdminActionType } from "./types.js";

export class AdminAuthManager {
  private lastNonce: number = 0;
  private readonly adminPublicKey: string; // PEM format
  private readonly expectedDomain: string;

  constructor(adminPublicKey: string, chainId: number = 31337) {
    if (!adminPublicKey) {
      throw new Error("Admin public key must be provided");
    }
    this.adminPublicKey = adminPublicKey;
    this.expectedDomain = `QMOOSA:FLASHLOAN:${chainId}`;
  }

  public getExpectedDomain(): string {
    return this.expectedDomain;
  }

  public static buildCanonicalPayload(
    action: AdminActionType,
    params: Record<string, any>,
    nonce: number,
    deadline: number,
    domain: string
  ): string {
    const sortedKeys = Object.keys(params).sort();
    const sortedObj: Record<string, any> = {};
    for (const k of sortedKeys) {
      sortedObj[k] = params[k];
    }
    return JSON.stringify({
      domain,
      action,
      nonce,
      deadline,
      params: sortedObj
    });
  }

  public static signAdminIntent(
    action: AdminActionType,
    params: Record<string, any>,
    nonce: number,
    deadline: number,
    domain: string,
    privateKeyPem: string
  ): SignedAdminIntent {
    const payload = this.buildCanonicalPayload(action, params, nonce, deadline, domain);
    const signature = crypto.sign(null, Buffer.from(payload, "utf8"), privateKeyPem).toString("base64");

    return {
      action,
      params,
      nonce,
      deadline,
      domain,
      signature
    };
  }

  public verifyAndConsume(intent: SignedAdminIntent): void {
    if (intent.domain !== this.expectedDomain) {
      throw new Error(`Domain mismatch: expected ${this.expectedDomain}, got ${intent.domain}`);
    }

    const now = Math.floor(Date.now() / 1000);
    if (intent.deadline < now) {
      throw new Error(`Intent expired: deadline ${intent.deadline} < current ${now}`);
    }

    if (intent.nonce <= this.lastNonce) {
      throw new Error(`Nonce replay rejected: intent nonce ${intent.nonce} <= last consumed nonce ${this.lastNonce}`);
    }

    const payload = AdminAuthManager.buildCanonicalPayload(
      intent.action,
      intent.params,
      intent.nonce,
      intent.deadline,
      intent.domain
    );

    const verified = crypto.verify(
      null,
      Buffer.from(payload, "utf8"),
      this.adminPublicKey,
      Buffer.from(intent.signature, "base64")
    );

    if (!verified) {
      throw new Error("Cryptographic verification failed: invalid admin signature");
    }

    // Monotonic nonce progression
    this.lastNonce = intent.nonce;
  }
}
