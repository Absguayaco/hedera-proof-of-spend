/**
 * Store configuration, read once at startup.
 *
 * The buyer's guard exists because it signs from a raw private key. The store
 * holds no key at all, so its risk is different and worth stating plainly: it
 * publishes the network and the account that money is paid *into*. Get either
 * wrong and the store either collects real HBAR on mainnet, or quietly directs
 * every payment to the wrong account. Both are refused here rather than
 * documented.
 */
import { HBAR_ASSET_ID, HEDERA_TESTNET_CAIP2, isValidHederaEntityId } from "@x402/hedera";

/** The only network this store will quote. Mainnet is refused at startup. */
export const STORE_NETWORK = HEDERA_TESTNET_CAIP2;

/** Native HBAR, as opposed to an HTS token. */
export const STORE_ASSET = HBAR_ASSET_ID;

export interface StoreConfig {
  /** Hedera account the store is paid into, e.g. "0.0.54321". */
  readonly payTo: string;
  /** Hosted x402 facilitator that verifies and settles payments. */
  readonly facilitatorUrl: string;
  readonly port: number;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set. The store will not guess a default for it — see .env.example.`,
    );
  }
  return value;
}

/**
 * A facilitator URL is where payment verification is delegated, so a plaintext
 * one is a downgrade an operator should have to type deliberately. localhost is
 * allowed over http because that is how the store is developed.
 */
function assertSafeFacilitatorUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("FACILITATOR_URL is not a valid URL.");
  }

  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !isLoopback) {
    throw new Error(
      `Refusing to start: FACILITATOR_URL must be https (got ${url.protocol.replace(":", "")}). ` +
        `Payment verification is delegated to it.`,
    );
  }
  return url.toString();
}

export function readStoreConfig(env: NodeJS.ProcessEnv = process.env): StoreConfig {
  // Checked before anything else: if a network was configured at all, it must
  // be the one this store is allowed to quote. The check runs even though the
  // value is otherwise unused, so a mainnet deployment fails loudly at boot
  // rather than succeeding and taking real money.
  const network = env.HEDERA_NETWORK?.trim();
  if (network && network !== "testnet" && network !== STORE_NETWORK) {
    throw new Error(
      `Refusing to start: HEDERA_NETWORK is "${network}". This store quotes ` +
        `${STORE_NETWORK} only.`,
    );
  }

  const payTo = requireEnv(env, "STORE_PAYEE_ID");
  if (!isValidHederaEntityId(payTo)) {
    throw new Error(
      `STORE_PAYEE_ID is not a Hedera account id (got "${payTo}"). Expected shard.realm.num, e.g. 0.0.54321.`,
    );
  }

  const facilitatorUrl = assertSafeFacilitatorUrl(requireEnv(env, "FACILITATOR_URL"));

  const rawPort = env.PORT?.trim();
  const port = rawPort === undefined || rawPort === "" ? 8402 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT is not a valid port number (got "${rawPort}").`);
  }

  return { payTo, facilitatorUrl, port };
}
