import { TechId } from "@openfront/engine-api/game/TechTree";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zNum,
  zPlayerRef,
  zRandom,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { simpleHash } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { ResearchExecution } from "./ResearchExecution";

/**
 * Tech plans a tribe can follow, as priority orders. The bot researches the
 * first tech in its plan it can currently afford; nodes whose prerequisites
 * are still missing fail `Player.canResearch()` and are skipped, so a plan
 * never dead-ends. The distinct plans give the tribes different personalities
 * (economy, armor, aviation, trade, balanced) instead of every bot picking the
 * same first tech.
 *
 * Every plan lists every tech exactly once. Keep it that way: a tech missing
 * from a plan is simply never researched by bots on that plan.
 */
export const TRIBE_RESEARCH_PLANS: readonly (readonly TechId[])[] = [
  // Economy first: income, research speed, trade revenue, then growth.
  [
    TechId.Industry,
    TechId.Logistics,
    TechId.Trade,
    TechId.Mobilization,
    TechId.Armor,
    TechId.ReinforcedArmor,
    TechId.Aviation,
    TechId.PrecisionBombing,
    TechId.SiegeArtillery,
    TechId.HeavyAirframes,
    TechId.DroneWarfare,
    TechId.Robotics,
  ],
  // Armor rush, with the growth tech before the air branch.
  [
    TechId.Industry,
    TechId.Armor,
    TechId.ReinforcedArmor,
    TechId.Mobilization,
    TechId.Logistics,
    TechId.Trade,
    TechId.Aviation,
    TechId.PrecisionBombing,
    TechId.SiegeArtillery,
    TechId.Robotics,
    TechId.HeavyAirframes,
    TechId.DroneWarfare,
  ],
  // Air rush.
  [
    TechId.Logistics,
    TechId.Aviation,
    TechId.PrecisionBombing,
    TechId.Industry,
    TechId.Trade,
    TechId.Mobilization,
    TechId.Armor,
    TechId.ReinforcedArmor,
    TechId.HeavyAirframes,
    TechId.DroneWarfare,
    TechId.SiegeArtillery,
    TechId.Robotics,
  ],
  // Trade boom.
  [
    TechId.Trade,
    TechId.Logistics,
    TechId.Industry,
    TechId.Mobilization,
    TechId.Aviation,
    TechId.PrecisionBombing,
    TechId.Armor,
    TechId.ReinforcedArmor,
    TechId.Robotics,
    TechId.SiegeArtillery,
    TechId.HeavyAirframes,
    TechId.DroneWarfare,
  ],
  // Balanced: alternate between economy and both unit branches.
  [
    TechId.Industry,
    TechId.Armor,
    TechId.Logistics,
    TechId.Aviation,
    TechId.Trade,
    TechId.Mobilization,
    TechId.ReinforcedArmor,
    TechId.PrecisionBombing,
    TechId.SiegeArtillery,
    TechId.HeavyAirframes,
    TechId.DroneWarfare,
    TechId.Robotics,
  ],
];

/** Offset from the attack behavior's `simpleHash(tribe.id())` seed. */
const RESEARCH_SEED_OFFSET = 7;

/** Ticks between two research purchases of the same tribe. */
const RESEARCH_COOLDOWN_MIN = 25;
const RESEARCH_COOLDOWN_MAX = 60;
/** Retry interval while nothing on the plan is affordable yet. */
const RETRY_MIN = 5;
const RETRY_MAX = 20;
/** First look, spaced out so the tribes do not all start researching at once. */
const FIRST_LOOK_MIN = 20;
const FIRST_LOOK_MAX = 60;

/**
 * Tribe (bot) tech AI. Every `RESEARCH_COOLDOWN_*` ticks the tribe buys the
 * first affordable tech of its plan; while it cannot afford anything yet it
 * retries again shortly, so a bot starts researching as soon as its accrued
 * research points and gold cover a node rather than only at fixed ages.
 *
 * The bot is a normal player: it earns research points from the same
 * `Config.researchPointsPerTick` rule as humans, pays the same gold cost and
 * is bound by the same prerequisites, so it can never unlock a tech a human
 * could not.
 */
export class TribeResearchExecution implements Execution {
  private active = true;
  private mg: Game;
  private random: PseudoRandom;
  private plan: readonly TechId[];
  private nextResearchTick: number;

  constructor(
    private tribe: Player,
    planIndex?: number,
  ) {
    // A seed of its own: the attack behavior uses simpleHash(tribe.id()) and
    // the two must not draw the same sequence.
    this.random = new PseudoRandom(
      simpleHash(tribe.id()) + RESEARCH_SEED_OFFSET,
    );
    // A private copy: two tribes on the same plan must not alias one shared
    // array, or a restored snapshot (which decodes its own array) would have a
    // different sharing graph than the live game.
    this.plan = [
      ...TRIBE_RESEARCH_PLANS[
        planIndex ?? this.random.nextInt(0, TRIBE_RESEARCH_PLANS.length)
      ],
    ];
    this.nextResearchTick = this.random.nextInt(FIRST_LOOK_MIN, FIRST_LOOK_MAX);
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game): void {
    this.mg = mg;
    // The onboarding tutorial's tribe is meant to be conquered: letting it
    // buy techs (and the troop/gold bonuses that come with them) would make
    // the scripted first game unpredictable.
    if (mg.config().gameConfig().tutorial) {
      this.active = false;
    }
  }

  tick(ticks: number): void {
    if (!this.active) {
      return;
    }
    if (!this.tribe.isAlive()) {
      // removeOnDeath is called from the tribe's PlayerExecution.
      this.active = false;
      return;
    }
    if (ticks < this.nextResearchTick) {
      return;
    }

    for (const tech of this.plan) {
      if (this.tribe.hasTech(tech)) {
        continue;
      }
      if (!this.tribe.canResearch(tech)) {
        continue;
      }
      this.mg.addExecution(new ResearchExecution(this.tribe, tech));
      this.nextResearchTick =
        ticks +
        this.random.nextInt(RESEARCH_COOLDOWN_MIN, RESEARCH_COOLDOWN_MAX);
      return;
    }

    this.nextResearchTick = ticks + this.random.nextInt(RETRY_MIN, RETRY_MAX);
  }

  isActive(): boolean {
    return this.active;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return TribeResearchExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      tribe: w.player(this.tribe),
      random: w.random(this.random),
      plan: [...this.plan],
      nextResearchTick: this.nextResearchTick,
    });
  }

  restoreSnapshot(s: TribeResearchState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.tribe = r.player(s.tribe);
    this.random = r.random(s.random);
    this.plan = s.plan;
    this.nextResearchTick = s.nextResearchTick;
  }
}

const TribeResearchStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  tribe: zPlayerRef(),
  random: zRandom(),
  plan: z.array(z.enum(TechId)),
  nextResearchTick: zNum(),
});
type TribeResearchState = z.infer<typeof TribeResearchStateSchema>;

export const TribeResearchExecutionSnapshot = execSnapshotType({
  name: "TribeResearch",
  version: 1,
  schema: TribeResearchStateSchema,
  cls: () => TribeResearchExecution,
});
