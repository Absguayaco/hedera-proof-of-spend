/**
 * The guards are the reason it is acceptable for this repo to sign from a raw
 * private key, so they are tested rather than assumed. Everything else in the
 * buyer is still a stub; these two functions are not.
 */
import { describe, expect, it } from "vitest";
import { ALLOWED_X402_NETWORK, assertChallengeNetwork, assertTestnet } from "./guard.ts";

describe("assertTestnet", () => {
  it("allows testnet", () => {
    expect(() => assertTestnet("testnet")).not.toThrow();
  });

  it("defaults to testnet when unset, rather than refusing to start", () => {
    expect(() => assertTestnet(undefined)).not.toThrow();
  });

  it("refuses mainnet", () => {
    expect(() => assertTestnet("mainnet")).toThrow(/testnet-only/);
  });

  it("refuses an unknown network rather than assuming it is safe", () => {
    expect(() => assertTestnet("previewnet")).toThrow(/Refusing to start/);
  });

  it("names the offending value, so the error is actionable", () => {
    expect(() => assertTestnet("mainnet")).toThrow(/"mainnet"/);
  });
});

describe("assertChallengeNetwork", () => {
  it("allows the testnet challenge", () => {
    expect(() => assertChallengeNetwork(ALLOWED_X402_NETWORK)).not.toThrow();
  });

  it("refuses a mainnet challenge even though the SDK may be on testnet", () => {
    // The challenge is what decides where the money goes, so it is checked
    // separately from the configured network.
    expect(() => assertChallengeNetwork("hedera:mainnet")).toThrow(/Refusing to pay/);
  });

  it("refuses a different chain entirely", () => {
    expect(() => assertChallengeNetwork("eip155:84532")).toThrow(/Refusing to pay/);
  });

  it("is exact, not a prefix match", () => {
    expect(() => assertChallengeNetwork("hedera:testnet-fork")).toThrow(/Refusing to pay/);
  });
});
