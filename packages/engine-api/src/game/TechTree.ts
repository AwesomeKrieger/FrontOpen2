import { Gold, UnitType } from "./GameTypes";

/**
 * The research tree. A player spends research points (accrued continuously by
 * cities and factories) plus gold to unlock a tech; techs gate units and apply
 * passive bonuses.
 *
 * The bit order of `TECH_ORDER` is part of the wire format: players' researched
 * techs travel as a bitmask (`PlayerUpdate.researchedTechs`), so append new
 * techs at the end and never reorder or remove an entry.
 */
export enum TechId {
  // Tier 1
  Industry = "Industry",
  Logistics = "Logistics",
  // Tier 2
  Armor = "Armor",
  Aviation = "Aviation",
  // Tier 3
  ReinforcedArmor = "ReinforcedArmor",
  PrecisionBombing = "PrecisionBombing",
  // Economy branch: tier 1 and tier 2, but appended to the enum and to
  // TECH_ORDER so the existing tech bits never move.
  Trade = "Trade",
  Mobilization = "Mobilization",
  // Late-game expansion (tier 4), appended so the tech bitmask is stable.
  SiegeArtillery = "SiegeArtillery",
  HeavyAirframes = "HeavyAirframes",
  DroneWarfare = "DroneWarfare",
  Robotics = "Robotics",
}

export interface Tech {
  readonly id: TechId;
  /** Visual row in the tree UI. Prerequisites live in a previous tier. */
  readonly tier: number;
  readonly requires: readonly TechId[];
  /** Cost in research points. */
  readonly researchPoints: number;
  /** Cost in gold, on top of the research points. */
  readonly gold: Gold;
  /** Unit this tech unlocks, if any. */
  readonly unlocksUnit?: UnitType;
}

export const TECHS: Readonly<Record<TechId, Tech>> = {
  [TechId.Industry]: {
    id: TechId.Industry,
    tier: 0,
    requires: [],
    researchPoints: 40,
    gold: 100_000n,
  },
  [TechId.Logistics]: {
    id: TechId.Logistics,
    tier: 0,
    requires: [],
    researchPoints: 40,
    gold: 100_000n,
  },
  [TechId.Armor]: {
    id: TechId.Armor,
    tier: 1,
    requires: [TechId.Industry],
    researchPoints: 120,
    gold: 250_000n,
    unlocksUnit: UnitType.Tank,
  },
  [TechId.Aviation]: {
    id: TechId.Aviation,
    tier: 1,
    requires: [TechId.Logistics],
    researchPoints: 150,
    gold: 300_000n,
    unlocksUnit: UnitType.Plane,
  },
  [TechId.ReinforcedArmor]: {
    id: TechId.ReinforcedArmor,
    tier: 2,
    requires: [TechId.Armor],
    researchPoints: 200,
    gold: 400_000n,
  },
  [TechId.PrecisionBombing]: {
    id: TechId.PrecisionBombing,
    tier: 2,
    requires: [TechId.Aviation],
    researchPoints: 200,
    gold: 400_000n,
  },
  [TechId.Trade]: {
    id: TechId.Trade,
    tier: 0,
    requires: [],
    researchPoints: 60,
    gold: 120_000n,
  },
  [TechId.Mobilization]: {
    id: TechId.Mobilization,
    tier: 1,
    requires: [TechId.Trade],
    researchPoints: 100,
    gold: 200_000n,
  },
  // Late-game expansion. Very expensive in both research points and gold so
  // they only come online long after the standard branches.
  [TechId.SiegeArtillery]: {
    id: TechId.SiegeArtillery,
    tier: 3,
    requires: [TechId.ReinforcedArmor],
    researchPoints: 280,
    gold: 600_000n,
  },
  [TechId.HeavyAirframes]: {
    id: TechId.HeavyAirframes,
    tier: 3,
    requires: [TechId.PrecisionBombing],
    researchPoints: 280,
    gold: 600_000n,
  },
  [TechId.DroneWarfare]: {
    id: TechId.DroneWarfare,
    tier: 3,
    requires: [TechId.PrecisionBombing, TechId.HeavyAirframes],
    researchPoints: 350,
    gold: 900_000n,
    unlocksUnit: UnitType.Drone,
  },
  [TechId.Robotics]: {
    id: TechId.Robotics,
    tier: 3,
    requires: [TechId.ReinforcedArmor, TechId.SiegeArtillery],
    researchPoints: 350,
    gold: 900_000n,
    unlocksUnit: UnitType.RobotFactory,
  },
};

/** Stable bit order for the researched-tech bitmask. Append only. */
export const TECH_ORDER: readonly TechId[] = [
  TechId.Industry,
  TechId.Logistics,
  TechId.Armor,
  TechId.Aviation,
  TechId.ReinforcedArmor,
  TechId.PrecisionBombing,
  TechId.Trade,
  TechId.Mobilization,
  TechId.SiegeArtillery,
  TechId.HeavyAirframes,
  TechId.DroneWarfare,
  TechId.Robotics,
] as const;

export const TECH_TIER_COUNT = 4;

/** The units each tech unlocks, for the UI. */
export const TECH_UNLOCKS: readonly (readonly TechId[])[] = TECH_ORDER.map(
  (id) => [id],
);

export function techById(id: TechId): Tech {
  return TECHS[id];
}

/** Bit position of a tech in the bitmask, or -1 when it is not in the tree. */
export function techBit(id: TechId): number {
  return TECH_ORDER.indexOf(id);
}

/** The tech that must be researched before `type` can be built. */
export function techForUnit(type: UnitType): TechId | undefined {
  switch (type) {
    case UnitType.Tank:
      return TechId.Armor;
    case UnitType.Plane:
      return TechId.Aviation;
    case UnitType.Drone:
      return TechId.DroneWarfare;
    case UnitType.RobotFactory:
      return TechId.Robotics;
    default:
      return undefined;
  }
}

/** Units a player can build only after researching something. */
export const TECH_GATED_UNITS: readonly UnitType[] = [
  UnitType.Tank,
  UnitType.Plane,
  UnitType.Drone,
  UnitType.RobotFactory,
];
