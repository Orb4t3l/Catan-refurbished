// ---------------------------------------------------------------------------
// Board generation. This is the piece that makes CUSTOM MAPS possible.
//
// A "map definition" is nothing but a list of axial tile coordinates +
// resource kinds + numbers. buildBoard() turns that list into the full
// Board graph (tiles, vertices, edges, ports) by computing pixel positions
// and deduping shared corners/edges. Change the tile list -> get a new map,
// everything else (rules engine, rendering) keeps working.
// ---------------------------------------------------------------------------

import type { Board, Port, Resource, Tile, TileKind, Vertex, Edge, AxialCoord } from "./types";

export interface TileDef extends AxialCoord {
  kind: TileKind;
  number: number | null;
}

export interface PortDef {
  /** axial coord of the tile the port sits against */
  tile: AxialCoord;
  /** which of the 6 edges of that tile (0-5, see EDGE_DIRS) the port sits on */
  direction: number;
  resource: Resource | null;
  ratio: 2 | 3;
}

export interface MapDefinition {
  name: string;
  tiles: TileDef[];
  ports: PortDef[];
}

// ---- the classic 19-tile standard board, generated procedurally ----------

const STANDARD_RESOURCE_COUNTS: Record<TileKind, number> = {
  wood: 4,
  brick: 3,
  sheep: 4,
  wheat: 4,
  ore: 3,
  desert: 1,
};

const STANDARD_NUMBER_SEQUENCE = [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11];

/** Axial coords for the standard radius-2 hex board (19 tiles). */
function standardAxialRing(): AxialCoord[] {
  const coords: AxialCoord[] = [];
  const radius = 2;
  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r++) {
      coords.push({ q, r });
    }
  }
  return coords;
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generates a randomized standard-rules 19-tile map. Pass a seed for
 * reproducible / shareable maps. This is a *default* map - swap it out
 * for any MapDefinition to support custom layouts. */
export function generateStandardMap(seed = Date.now()): MapDefinition {
  const rng = mulberry32(seed);
  const resourcePool: TileKind[] = [];
  (Object.keys(STANDARD_RESOURCE_COUNTS) as TileKind[]).forEach((kind) => {
    for (let i = 0; i < STANDARD_RESOURCE_COUNTS[kind]; i++) resourcePool.push(kind);
  });
  const shuffledResources = shuffle(resourcePool, rng);
  const coords = standardAxialRing();

  let numberIdx = 0;
  const tiles: TileDef[] = coords.map((c, i) => {
    const kind = shuffledResources[i];
    const number = kind === "desert" ? null : STANDARD_NUMBER_SEQUENCE[numberIdx++];
    return { ...c, kind, number };
  });

  // Standard 9 ports placed around the rim. direction indices reference
  // EDGE_DIRS below (0 = E, 1 = SE, 2 = SW, 3 = W, 4 = NW, 5 = NE).
  const rimCoords = coords.filter((c) => Math.max(Math.abs(c.q), Math.abs(c.r), Math.abs(-c.q - c.r)) === 2);
  const portResources: (Resource | null)[] = [null, "wood", null, "brick", null, "sheep", null, "wheat", "ore"];
  const shuffledPortResources = shuffle(portResources, rng);
  const ports: PortDef[] = rimCoords
    .filter((_, i) => i % 2 === 0)
    .slice(0, 9)
    .map((tile, i) => ({
      tile,
      direction: i % 6,
      resource: shuffledPortResources[i],
      ratio: shuffledPortResources[i] ? 2 : 3,
    }));

  return { name: `Standard (seed ${seed})`, tiles, ports };
}

// ---------------------------------------------------------------------------
// Geometry: axial hex -> pixel corners, with rounding so shared corners
// between neighboring tiles collapse to the exact same vertex id.
// ---------------------------------------------------------------------------

const HEX_SIZE = 100; // arbitrary pixel units, Board.tsx can scale this down
const ROUND_PRECISION = 1; // decimal places for dedupe keys

function axialToPixel(q: number, r: number): { x: number; y: number } {
  const x = HEX_SIZE * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
  const y = HEX_SIZE * ((3 / 2) * r);
  return { x, y };
}

function hexCorners(center: { x: number; y: number }): { x: number; y: number }[] {
  const corners = [];
  for (let i = 0; i < 6; i++) {
    const angleDeg = 60 * i - 30; // flat-top... actually pointy-top offset, matches axialToPixel above
    const angleRad = (Math.PI / 180) * angleDeg;
    corners.push({
      x: center.x + HEX_SIZE * Math.cos(angleRad),
      y: center.y + HEX_SIZE * Math.sin(angleRad),
    });
  }
  return corners;
}

function pointKey(p: { x: number; y: number }): string {
  return `${p.x.toFixed(ROUND_PRECISION)}_${p.y.toFixed(ROUND_PRECISION)}`;
}

/** Direction index -> which two corner indices form that edge of the hexagon. */
const EDGE_CORNER_PAIRS: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 0],
];

export function buildBoard(def: MapDefinition): Board {
  const tiles: Record<string, Tile> = {};
  const vertices: Record<string, Vertex> = {};
  const edges: Record<string, Edge> = {};

  for (const t of def.tiles) {
    const id = `${t.q},${t.r}`;
    tiles[id] = {
      id,
      q: t.q,
      r: t.r,
      kind: t.kind,
      number: t.number,
      hasRobber: t.kind === "desert",
    };

    const center = axialToPixel(t.q, t.r);
    const corners = hexCorners(center).map(pointKey);

    // register/merge vertices for this tile's 6 corners
    for (const key of corners) {
      if (!vertices[key]) {
        vertices[key] = { id: key, tileIds: [], building: null };
      }
      if (!vertices[key].tileIds.includes(id)) vertices[key].tileIds.push(id);
    }

    // register/merge edges for this tile's 6 sides
    for (const [a, b] of EDGE_CORNER_PAIRS) {
      const vA = corners[a];
      const vB = corners[b];
      const edgeId = [vA, vB].sort().join("__");
      if (!edges[edgeId]) {
        edges[edgeId] = { id: edgeId, vertexIds: [vA, vB].sort() as [string, string], road: null };
      }
    }
  }

  const ports: Port[] = def.ports.map((p, i) => {
    const center = axialToPixel(p.tile.q, p.tile.r);
    const corners = hexCorners(center).map(pointKey);
    const [a, b] = EDGE_CORNER_PAIRS[p.direction];
    return {
      id: `port-${i}`,
      vertexIds: [corners[a], corners[b]].sort() as [string, string],
      resource: p.resource,
      ratio: p.ratio,
    };
  });

  return { tiles, vertices, edges, ports };
}

/** Pixel position for a tile, for rendering. Exposed so Board.tsx doesn't
 * need to re-derive hex geometry itself. */
export function tilePixelCenter(q: number, r: number) {
  return axialToPixel(q, r);
}

export function tilePixelCorners(q: number, r: number) {
  return hexCorners(axialToPixel(q, r));
}

export { HEX_SIZE };
