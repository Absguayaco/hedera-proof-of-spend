import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { preflightFacilitator } from "./preflight.ts";

const HEDERA = "hedera:testnet";

/** Only getSupported is exercised; verify and settle are never called here. */
function facilitatorReturning(supported: SupportedResponse): FacilitatorClient {
  return {
    getSupported: async () => supported,
    verify: () => {
      throw new Error("not used in preflight");
    },
    settle: () => {
      throw new Error("not used in preflight");
    },
  } as unknown as FacilitatorClient;
}

function facilitatorThatIsDown(): FacilitatorClient {
  return {
    getSupported: async () => {
      throw new Error("fetch failed");
    },
  } as unknown as FacilitatorClient;
}

const hederaSupported: SupportedResponse = {
  kinds: [
    { x402Version: 2, scheme: "exact", network: "eip155:80002" },
    { x402Version: 2, scheme: "exact", network: HEDERA, extra: { feePayer: "0.0.7162784" } },
  ],
  extensions: [],
  signers: {},
};

describe("preflightFacilitator", () => {
  it("accepts a facilitator that settles our scheme and network", async () => {
    const result = await preflightFacilitator(facilitatorReturning(hederaSupported), HEDERA);
    expect(result.kind.network).toBe(HEDERA);
  });

  it("surfaces the fee payer, which is useful in a startup log", async () => {
    const result = await preflightFacilitator(facilitatorReturning(hederaSupported), HEDERA);
    expect(result.feePayer).toBe("0.0.7162784");
  });

  it("refuses when the facilitator is unreachable", async () => {
    await expect(preflightFacilitator(facilitatorThatIsDown(), HEDERA)).rejects.toThrow(
      /could not reach the facilitator/,
    );
  });

  it("keeps the underlying cause, so the failure is diagnosable", async () => {
    await expect(preflightFacilitator(facilitatorThatIsDown(), HEDERA)).rejects.toThrow(
      /fetch failed/,
    );
  });

  it("refuses a reachable facilitator that does not settle our network", async () => {
    // Reachability is not enough. This would otherwise fail at the first
    // purchase instead of at boot — the same problem, one step later.
    const wrongNetwork = facilitatorReturning({
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:80002" }],
      extensions: [],
      signers: {},
    });
    await expect(preflightFacilitator(wrongNetwork, HEDERA)).rejects.toThrow(/does not settle/);
  });

  it("names what the facilitator does offer, so the error is actionable", async () => {
    const wrongNetwork = facilitatorReturning({
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:80002" }],
      extensions: [],
      signers: {},
    });
    await expect(preflightFacilitator(wrongNetwork, HEDERA)).rejects.toThrow(/exact\/eip155:80002/);
  });

  it("refuses when the network matches but the scheme does not", async () => {
    const wrongScheme = facilitatorReturning({
      kinds: [{ x402Version: 2, scheme: "upto", network: HEDERA }],
      extensions: [],
      signers: {},
    });
    await expect(preflightFacilitator(wrongScheme, HEDERA)).rejects.toThrow(/does not settle/);
  });

  it("reports 'nothing' rather than an empty list when nothing is offered", async () => {
    const empty = facilitatorReturning({ kinds: [], extensions: [], signers: {} });
    await expect(preflightFacilitator(empty, HEDERA)).rejects.toThrow(/offers: nothing/);
  });
});
