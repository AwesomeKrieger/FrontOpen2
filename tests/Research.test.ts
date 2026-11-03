import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PlayerLike } from "@openfront/engine-api/game/ReadViews";
import { TECHS, TechId } from "@openfront/engine-api/game/TechTree";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";

const gameID = "game_id";

function makeConfig(gameConfig: Partial<GameConfig> = {}): EngineConfig {
  return new EngineConfig(gameConfig as GameConfig, false);
}

interface FakeUnit {
  isUnderConstruction: () => boolean;
  level: () => number;
}

function fakeUnit(level: number, underConstruction = false): FakeUnit {
  return {
    isUnderConstruction: () => underConstruction,
    level: () => level,
  };
}

/** A PlayerLike whose only units are the ones the research formula looks at. */
function researchPlayer(
  units: Partial<Record<UnitType, FakeUnit[]>>,
  techs: TechId[] = [],
): PlayerLike {
  return {
    units: (type: UnitType) => units[type] ?? [],
    hasTech: (tech: TechId) => techs.includes(tech),
  } as unknown as PlayerLike;
}

async function spawnPlayers(names: string[]): Promise<{
  game: Game;
  players: Player[];
}> {
  const game = await setup("plains", {});
  const players: Player[] = [];
  for (let i = 0; i < names.length; i++) {
    const info = new PlayerInfo(names[i], PlayerType.Human, null, names[i]);
    game.addPlayer(info);
    game.addExecution(
      new SpawnExecution(gameID, info, game.ref(10 + i * 10, 10 + i * 10)),
    );
    players.push(game.player(names[i]));
  }
  // SpawnExecution spawns in its first tick, so the players only own tiles
  // after a second tick.
  game.executeNextTick();
  game.executeNextTick();
  return { game, players };
}

describe("research points per tick", () => {
  const config = makeConfig();

  test("base income without cities or factories", () => {
    expect(config.researchPointsPerTick(researchPlayer({}))).toBe(1);
  });

  test("cities and factories add two points per level", () => {
    const player = researchPlayer({
      [UnitType.City]: [fakeUnit(2), fakeUnit(3)],
      [UnitType.Factory]: [fakeUnit(1)],
    });
    expect(config.researchPointsPerTick(player)).toBe(1 + 4 + 6 + 2);
  });

  test("structures under construction do not count", () => {
    const player = researchPlayer({
      [UnitType.City]: [fakeUnit(5, true)],
      [UnitType.Factory]: [fakeUnit(5, true)],
    });
    expect(config.researchPointsPerTick(player)).toBe(1);
  });

  test("Logistics adds half again, rounded down", () => {
    const player = researchPlayer(
      {
        [UnitType.City]: [fakeUnit(2)],
        [UnitType.Factory]: [fakeUnit(3)],
      },
      [TechId.Logistics],
    );
    // (1 + 4 + 6) * 1.5 = 16.5
    expect(config.researchPointsPerTick(player)).toBe(16);
  });
});

describe("researching techs", () => {
  test("pays points and gold, enforces prerequisites and sets the bitmask", async () => {
    const { players } = await spawnPlayers(["alice"]);
    const alice = players[0];
    alice.addResearchPoints(1_000);
    alice.addGold(10_000_000n);

    // Armor needs Industry first.
    expect(alice.canResearch(TechId.Armor)).toBe(false);
    expect(alice.researchTech(TechId.Armor)).toBe(false);

    const goldBefore = alice.gold();
    const pointsBefore = alice.researchPoints();
    expect(alice.researchTech(TechId.Industry)).toBe(true);
    expect(alice.researchPoints()).toBe(
      pointsBefore - TECHS[TechId.Industry].researchPoints,
    );
    expect(alice.gold()).toBe(goldBefore - TECHS[TechId.Industry].gold);
    expect(alice.hasTech(TechId.Industry)).toBe(true);

    // Already researched.
    expect(alice.canResearch(TechId.Industry)).toBe(false);
    expect(alice.researchTech(TechId.Industry)).toBe(false);

    // The prerequisite is met now.
    expect(alice.canResearch(TechId.Armor)).toBe(true);
    expect(alice.researchTech(TechId.Armor)).toBe(true);
    expect(alice.hasTech(TechId.Armor)).toBe(true);
    expect(alice.researchedTechMask()).toBe(
      (1 << 0) | (1 << 2), // Industry, Armor
    );
  });

  test("cannot afford a tech without the gold, even with enough points", async () => {
    const { players } = await spawnPlayers(["bob"]);
    const bob = players[0];
    bob.addGold(0n);
    bob.addResearchPoints(1_000);
    expect(bob.canResearch(TechId.Industry)).toBe(false);
    expect(bob.researchTech(TechId.Industry)).toBe(false);
  });
});

describe("tech bonuses", () => {
  test("Industry raises worker gold income by 15%", async () => {
    const { game, players } = await spawnPlayers(["rich", "plain"]);
    const [rich, plain] = players;
    rich.addResearchPoints(1_000);
    rich.addGold(10_000_000n);
    expect(rich.researchTech(TechId.Industry)).toBe(true);

    const richBefore = rich.gold();
    const plainBefore = plain.gold();
    game.executeNextTick();
    const richGain = Number(rich.gold() - richBefore);
    const plainGain = Number(plain.gold() - plainBefore);

    expect(plainGain).toBeGreaterThan(0);
    expect(richGain).toBe(Math.floor((plainGain * 115) / 100));
  });

  test("Trade pays 25% more for every trade ship", async () => {
    const { players } = await spawnPlayers(["trader"]);
    const trader = players[0];
    const config = gameConfigOf(trader);
    const before = config.tradeShipGold(500, trader);

    trader.addResearchPoints(1_000);
    trader.addGold(10_000_000n);
    expect(trader.researchTech(TechId.Trade)).toBe(true);

    const after = config.tradeShipGold(500, trader);
    expect(after).toBe((before * 5n) / 4n);
    expect(after).toBeGreaterThan(before);
  });

  test("Mobilization raises troop growth by 15%", async () => {
    const { players } = await spawnPlayers(["grower"]);
    const grower = players[0];
    const config = gameConfigOf(grower);
    grower.setTroops(0);
    const before = config.troopIncreaseRate(grower);

    grower.addResearchPoints(1_000);
    grower.addGold(10_000_000n);
    expect(grower.researchTech(TechId.Trade)).toBe(true);
    expect(grower.researchTech(TechId.Mobilization)).toBe(true);

    const after = config.troopIncreaseRate(grower);
    expect(after).toBeCloseTo(before * 1.15);
  });
});

/** The engine config the spawned player's game runs on. */
function gameConfigOf(player: Player): EngineConfig {
  const game = (player as unknown as { mg: Game }).mg;
  return game.config() as EngineConfig;
}
