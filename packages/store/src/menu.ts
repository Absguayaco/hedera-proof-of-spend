/**
 * What the store sells. Priced in tinybar (1 HBAR = 100,000,000 tinybar) so
 * that nothing in the pricing path is ever a float.
 */
export interface MenuItem {
  readonly slug: string;
  readonly name: string;
  readonly priceTinybar: bigint;
  readonly description: string;
}

// TODO: fill in the demo catalogue. Keep it small — the point of the demo is
// the proof, not the shop.
export const MENU: readonly MenuItem[] = [];

export function findItem(slug: string): MenuItem | undefined {
  return MENU.find((item) => item.slug === slug);
}
