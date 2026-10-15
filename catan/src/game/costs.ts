import type { Resource } from "./types";

export const COSTS: Record<"road" | "settlement" | "city" | "devCard", Partial<Record<Resource, number>>> = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  devCard: { sheep: 1, wheat: 1, ore: 1 },
};

/** Standard 25-card development deck. */
export function standardDevDeck(): string[] {
  return [
    ...Array(14).fill("knight"),
    ...Array(5).fill("victory-point"),
    ...Array(2).fill("road-building"),
    ...Array(2).fill("year-of-plenty"),
    ...Array(2).fill("monopoly"),
  ];
}
