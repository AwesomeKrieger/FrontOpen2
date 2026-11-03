import { PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { TECHS, TECH_ORDER } from "@openfront/engine-api/game/TechTree";
import { ResearchExecution } from "@openfront/engine/execution/ResearchExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import {
  TRIBE_RESEARCH_PLANS,
  TribeResearchExecution,
} from "@openfront/engine/execution/TribeResearchExecution";
import { Execution, Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";

const gameID = "game_id";

function liveExecutions(game: Game): Execution[] {
  return (game as unknown as { executions(): Execution[] }).executions();
}

/** Spawn a tribe and return it with its (auto-registered) research execution. */
async function spawnTribe(
  name = "tribe",
  gameConfig: Record<string, unknown> = {},
): Promise<{ game: Game; tribe: Player; research: TribeResearchExecution }> {
  const game = await setup("plains", gameConfig);
  const info = new PlayerInfo(name, PlayerType.Bot, null, name);
  game.addPlayer(info);
  game.addExecution(new SpawnExecution(gameID, info, game.ref(10, 10)));
  // SpawnExecution spawns in its first tick.
  game.executeNextTick();
  game.executeNextTick();
  const tribe = game.player(name);
  const research = liveExecutions(game).find(
    (e): e is TribeResearchExecution => e instanceof TribeResearchExecution,
  );
  if (research === undefined) {
    throw new Error("spawn did not register a TribeResearchExecution");
  }
  return { game, tribe, research };
}

describe("tribe research plans", () => {
  test("every plan names every tech exactly once", () => {
    for (const plan of TRIBE_RESEARCH_PLANS) {
      expect([...plan].sort()).toEqual([...TECH_ORDER].sort());
      expect(new Set(plan).size).toBe(plan.length);
    }
  });

  test("tribes do not all follow the same plan", async () => {
    const plans = new Set<string>();
    const game = await setup("plains", {});
    for (let i = 0; i < 12; i++) {
      const info = new PlayerInfo(
        `tribe${i}`,
        PlayerType.Bot,
        null,
        `tribe${i}`,
      );
      game.addPlayer(info);
      const exec = new TribeResearchExecution(game.player(`tribe${i}`));
      plans.add(exec["plan"].join(","));
    }
    expect(plans.size).toBeGreaterThan(1);
  });
});

describe("tribe research behavior", () => {
  test("every spawned tribe gets a research execution", async () => {
    const { research } = await spawnTribe();
    expect(research.isActive()).toBe(true);
  });

  test("waits until it can afford a tech, then researches one from its plan", async () => {
    const { game, tribe, research } = await spawnTribe();
    const tickAt = research["nextResearchTick"];
    const added: Execution[] = [];
    const addExecution = game.addExecution.bind(game);
    vi.spyOn(game, "addExecution").mockImplementation((exec: Execution) => {
      added.push(exec);
      addExecution(exec);
    });

    // No research points: nothing can be bought.
    research.tick(tickAt);
    expect(added.filter((e) => e instanceof ResearchExecution)).toHaveLength(0);

    // Points but no gold is still not enough: both costs are paid.
    tribe.addResearchPoints(10_000);
    research.tick(research["nextResearchTick"]);
    expect(added.filter((e) => e instanceof ResearchExecution)).toHaveLength(0);

    // Gold unlocks the first affordable tech of the plan.
    tribe.addGold(100_000_000n);
    research.tick(research["nextResearchTick"]);
    const purchases = added.filter(
      (e): e is ResearchExecution => e instanceof ResearchExecution,
    );
    expect(purchases).toHaveLength(1);
    expect(research["plan"]).toContain(purchases[0]["tech"]);

    game.executeNextTick();
    const researched = TECH_ORDER.filter((id) => tribe.hasTech(id));
    expect(researched).toEqual([purchases[0]["tech"]]);
  });

  test("keeps researching techs one after another", async () => {
    const { game, tribe } = await spawnTribe();
    tribe.addResearchPoints(10_000);
    tribe.addGold(100_000_000n);

    for (let i = 0; i < 1_500; i++) {
      game.executeNextTick();
    }

    const researched = TECH_ORDER.filter((id) => tribe.hasTech(id));
    // Enough points and gold were handed over for the whole tree; the plan
    // and the per-tech cooldown decide the order, not the budget.
    expect(researched.length).toBeGreaterThanOrEqual(6);
  });

  test("stops researching when the tribe is no longer alive", async () => {
    const { game, tribe, research } = await spawnTribe();
    vi.spyOn(tribe, "isAlive").mockReturnValue(false);
    const spy = vi.spyOn(game, "addExecution");

    research.tick(research["nextResearchTick"]);

    expect(spy).not.toHaveBeenCalled();
    expect(research.isActive()).toBe(false);
  });

  test("never unlocks a tech whose prerequisites are missing", async () => {
    const { game, tribe } = await spawnTribe();
    tribe.addResearchPoints(10_000);
    tribe.addGold(100_000_000n);
    for (let i = 0; i < 500; i++) {
      game.executeNextTick();
    }

    const researched = TECH_ORDER.filter((id) => tribe.hasTech(id));
    expect(researched.length).toBeGreaterThan(0);
    for (const id of researched) {
      for (const required of TECHS[id].requires) {
        expect(tribe.hasTech(required)).toBe(true);
      }
    }
    expect(tribe.researchPoints()).toBeGreaterThanOrEqual(0);
  });

  test("the onboarding tutorial's tribe never researches", async () => {
    const game = await setup("plains", { tutorial: true });
    const info = new PlayerInfo("tribe", PlayerType.Bot, null, "tribe");
    game.addPlayer(info);
    game.addExecution(new SpawnExecution(gameID, info, game.ref(10, 10)));
    game.executeNextTick();
    game.executeNextTick();
    const tribe = game.player("tribe");
    tribe.addResearchPoints(10_000);
    tribe.addGold(100_000_000n);

    // The tutorial's tribe deactivates its research behavior on init, so it
    // never even appears among the live executions.
    const research = new TribeResearchExecution(tribe);
    research.init(game);
    expect(research.isActive()).toBe(false);

    for (let i = 0; i < 300; i++) {
      game.executeNextTick();
    }
    expect(TECH_ORDER.filter((id) => tribe.hasTech(id))).toEqual([]);
  });
});
