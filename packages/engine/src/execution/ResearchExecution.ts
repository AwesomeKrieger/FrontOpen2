import { TechId } from "@openfront/engine-api/game/TechTree";
import { zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * Spends a player's research points and gold to unlock one tech. The player
 * state changes in `init`; the execution just lives for one tick so the
 * intent round-trips like every other one.
 */
export class ResearchExecution implements Execution {
  private active = true;
  private mg: Game;

  constructor(
    private player: Player,
    private tech: TechId,
  ) {}

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;

    if (!this.player.isAlive()) {
      this.active = false;
      return;
    }

    if (!this.player.researchTech(this.tech)) {
      console.warn(
        `player ${this.player.displayName()} cannot research ${this.tech}`,
      );
      this.active = false;
    }
  }

  tick(ticks: number): void {
    // Research completes immediately in init.
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return ResearchExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      tech: this.tech,
    });
  }

  restoreSnapshot(s: ResearchState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.tech = s.tech;
  }
}

const ResearchStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  tech: z.enum(TechId),
});
type ResearchState = z.infer<typeof ResearchStateSchema>;

export const ResearchExecutionSnapshot = execSnapshotType({
  name: "Research",
  version: 1,
  schema: ResearchStateSchema,
  cls: () => ResearchExecution,
});
