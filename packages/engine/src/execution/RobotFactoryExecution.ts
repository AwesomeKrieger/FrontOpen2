import { zRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * A robot factory: the late-game Robotics structure. It slowly synthesizes
 * robots into the owner's stock, which then absorb a share of the owner's
 * attack casualties (at the cost of softer attacks - robots are tireless but
 * dim). Building one is a major investment: gold up front and a long
 * construction time.
 */
export class RobotFactoryExecution implements Execution {
  private active = true;
  private mg: Game;

  constructor(private factory: Unit) {}

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (!this.factory.isActive()) {
      this.active = false;
      return;
    }
    // Only completed factories produce; during construction the stock is idle.
    if (this.factory.isUnderConstruction()) {
      return;
    }
    if (ticks % this.mg.config().robotsInterval() !== 0) {
      return;
    }
    const owner = this.factory.owner();
    if (!owner.isPlayer()) {
      this.active = false;
      return;
    }
    owner.addRobots(this.mg.config().robotsPerFactoryInterval());
  }

  isActive(): boolean {
    return this.active;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return RobotFactoryExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      factory: w.unit(this.factory),
    });
  }

  restoreSnapshot(s: RobotFactoryState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.factory = r.unit(s.factory);
  }
}

const RobotFactoryStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  factory: zRef(),
});
type RobotFactoryState = z.infer<typeof RobotFactoryStateSchema>;

export const RobotFactoryExecutionSnapshot = execSnapshotType({
  name: "RobotFactory",
  version: 1,
  schema: RobotFactoryStateSchema,
  cls: () => RobotFactoryExecution,
});
