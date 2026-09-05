/**
 * This client signs transactions from a raw private key supplied by whoever
 * runs it. The only thing making that acceptable is that it cannot touch a
 * network where value is real — so this is enforced at startup, not documented.
 */
const ALLOWED_NETWORK = "testnet";

/** The x402 network identifier the store must quote. Anything else is refused
 *  even if the SDK is pointed at testnet, because the challenge is what
 *  actually decides where the money goes. */
export const ALLOWED_X402_NETWORK = "hedera:testnet";

export function assertTestnet(network: string | undefined): void {
  const value = network ?? ALLOWED_NETWORK;
  if (value !== ALLOWED_NETWORK) {
    throw new Error(
      `Refusing to start: HEDERA_NETWORK is "${value}". This project is ` +
        `testnet-only and signs from a raw private key.`,
    );
  }
}

/** Called with the network named in the store's 402 challenge, before paying. */
export function assertChallengeNetwork(network: string): void {
  if (network !== ALLOWED_X402_NETWORK) {
    throw new Error(
      `Refusing to pay: the store quoted network "${network}", not ` +
        `"${ALLOWED_X402_NETWORK}".`,
    );
  }
}
