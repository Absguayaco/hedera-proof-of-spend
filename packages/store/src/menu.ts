/**
 * What the store sells.
 *
 * Prices are bigint tinybar, never floats and never HBAR decimals. 1 HBAR is
 * 100,000,000 tinybar, and the x402 payment requirement carries an integer
 * amount as a string — so tinybar is both the wire format and the only
 * representation that cannot round. HBAR is produced for display only.
 */

/** 1 HBAR = 100,000,000 tinybar. */
export const TINYBAR_PER_HBAR = 100_000_000n;

export interface MenuItem {
  readonly slug: string;
  readonly name: string;
  readonly priceTinybar: bigint;
  readonly description: string;
}

/**
 * Deliberately small. The point of the demo is the proof, not the shop — three
 * items are enough to show a catalogue, a price, and a purchase.
 */
export const MENU: readonly MenuItem[] = [
  {
    slug: "espresso",
    name: "Espresso",
    priceTinybar: 15_000_000n,
    description: "A single shot. The cheapest thing an agent can buy here.",
  },
  {
    slug: "flat-white",
    name: "Flat white",
    priceTinybar: 25_000_000n,
    description: "Double ristretto, steamed milk.",
  },
  {
    slug: "cold-brew",
    name: "Cold brew",
    priceTinybar: 35_000_000n,
    description: "Steeped eighteen hours. Served over ice.",
  },
];

export function findItem(slug: string): MenuItem | undefined {
  return MENU.find((item) => item.slug === slug);
}

/**
 * Render tinybar as HBAR for humans, using integer arithmetic throughout.
 *
 * Going through Number here would be a real bug rather than a theoretical one:
 * tinybar amounts exceed 2^53 well inside HBAR's supply, so a float conversion
 * loses precision on exactly the values a payment cares about.
 */
export function formatHbar(tinybar: bigint): string {
  const negative = tinybar < 0n;
  const absolute = negative ? -tinybar : tinybar;

  const whole = absolute / TINYBAR_PER_HBAR;
  const fraction = absolute % TINYBAR_PER_HBAR;

  // Pad to 8 digits so 0.05 HBAR does not render as "0.5", then trim trailing
  // zeros so a whole number of HBAR does not render as "1.00000000".
  const fractionDigits = fraction.toString().padStart(8, "0").replace(/0+$/, "");
  const body = fractionDigits.length > 0 ? `${whole}.${fractionDigits}` : `${whole}`;

  return negative ? `-${body}` : body;
}

/**
 * The catalogue as it goes over the wire.
 *
 * Amounts are strings: JSON has no bigint, and a JSON number would reintroduce
 * the float problem that tinybar exists to avoid.
 */
export interface MenuPayloadItem {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly priceTinybar: string;
  readonly priceHbar: string;
  readonly href: string;
}

export function menuPayload(): { items: MenuPayloadItem[] } {
  return {
    items: MENU.map((item) => ({
      slug: item.slug,
      name: item.name,
      description: item.description,
      priceTinybar: item.priceTinybar.toString(),
      priceHbar: formatHbar(item.priceTinybar),
      href: `/buy/${item.slug}`,
    })),
  };
}
