import { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { TechId } from "@openfront/engine-api/game/TechTree";
import {
  zPlayerRef,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * A tank: a ground unit that rolls from its factory toward a target tile and
 * fights whatever it passes. Tanks are unlocked by the Armor tech.
 *
 * Movement is a deterministic greedy walk: each tick the tank steps to a
 * neighboring land tile that reduces its manhattan distance to the target,
 * up to `Config.tankSpeed()` steps. Combat drains hostile players' troops on
 * tiles in range and damages hostile units that have health (tanks, planes).
 */
export class TankExecution implements Execution {
  private active = true;
  private mg: Game;
  private tank: Unit | null = null;

  constructor(
    private player: Player,
    private targetTile: TileRef,
    private tankUnit: Unit | null = null,
  ) {}

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;

    if (this.tankUnit !== null) {
      // Restored from a snapshot: the unit already exists.
      this.tank = this.tankUnit;
      return;
    }

    if (!this.player.hasTech(TechId.Armor)) {
      console.warn(
        `SECURITY: ${this.player.displayName()} has not researched Armor`,
      );
      this.active = false;
      return;
    }

    if (!mg.isValidRef(this.targetTile)) {
      this.active = false;
      return;
    }

    const factory = this.closestFactory();
    if (factory === null) {
      // No factory to roll out of.
      this.active = false;
      return;
    }

    this.tank = this.player.buildUnit(UnitType.Tank, factory.tile(), {
      targetTile: this.targetTile,
    });
  }

  private closestFactory(): Unit | null {
    let best: Unit | null = null;
    let bestDist = Number.MAX_SAFE_INTEGER;
    for (const unit of this.player.units(UnitType.Factory)) {
      if (!unit.isActive() || unit.isUnderConstruction()) {
        continue;
      }
      const dist = this.mg.manhattanDist(unit.tile(), this.targetTile);
      if (dist < bestDist) {
        bestDist = dist;
        best = unit;
      }
    }
    return best;
  }

  tick(ticks: number): void {
    if (this.tank === null || !this.tank.isActive()) {
      this.active = false;
      return;
    }

    if (!this.player.isAlive() || this.tank.owner() !== this.player) {
      this.active = false;
      return;
    }

    this.moveTowardsTarget();
    this.fight();
  }

  private moveTowardsTarget(): void {
    if (this.tank === null) {
      return;
    }
    const speed = this.mg.config().tankSpeed();
    for (let step = 0; step < speed; step++) {
      const current = this.tank.tile();
      if (current === this.targetTile) {
        this.tank.setReachedTarget();
        this.tank.touch();
        return;
      }

      let best: TileRef | null = null;
      let bestDist = this.mg.manhattanDist(current, this.targetTile);
      this.mg.forEachNeighbor(current, (neighbor) => {
        if (!this.mg.isLand(neighbor) || this.mg.isImpassable(neighbor)) {
          return;
        }
        const dist = this.mg.manhattanDist(neighbor, this.targetTile);
        if (dist < bestDist) {
          bestDist = dist;
          best = neighbor;
        }
      });

      if (best === null) {
        // Blocked (coast, mountains, map edge): hold position.
        return;
      }
      this.tank.move(best);
      if (this.tank.tile() === this.targetTile) {
        this.tank.setReachedTarget();
        this.tank.touch();
        return;
      }
    }
  }

  private fight(): void {
    if (this.tank === null) {
      return;
    }
    const config = this.mg.config();
    const range = config.tankAttackRange();
    const damage = config.tankDamage();

    // Enemy units with health take direct damage.
    const targets = this.mg.nearbyUnits(
      this.tank.tile(),
      range,
      [UnitType.Tank, UnitType.Plane],
      ({ unit }) => this.isHostileUnit(unit as Unit),
    );
    const healthDamage = Math.floor(damage / 2);
    for (const { unit } of targets) {
      unit.modifyHealth(-healthDamage, this.player);
    }

    // Hostile defense posts in range fire back at the tank.
    const defensePosts = this.mg.nearbyUnits(
      this.tank.tile(),
      range,
      UnitType.DefensePost,
      ({ unit }) => this.isHostileUnit(unit as Unit),
    );
    for (const { unit: dp } of defensePosts) {
      this.tank.modifyHealth(-40, dp.owner() as Player);
      if (!this.tank.isActive()) {
        return;
      }
    }

    // Tanks grind down the troops of hostile players whose land they sit on
    // or next to: one hit per hostile player per tick.
    const hitPlayers = new Set<Player>();
    for (const tile of this.mg.circleSearch(this.tank.tile(), range)) {
      const owner = this.mg.owner(tile);
      if (!owner.isPlayer() || owner === this.player) {
        continue;
      }
      const other = owner as Player;
      if (this.player.isFriendly(other)) {
        continue;
      }
      hitPlayers.add(other);
    }
    for (const other of hitPlayers) {
      other.removeTroops(damage);
    }
  }

  private isHostileUnit(unit: Unit): boolean {
    const owner = unit.owner();
    if (!owner.isPlayer() || owner === this.player) {
      return false;
    }
    return !this.player.isFriendly(owner as Player);
  }

  isActive(): boolean {
    return this.active;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return TankExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      targetTile: this.targetTile,
      tank: w.unitOrNull(this.tank),
      tankUnit: w.unitOrNull(this.tankUnit),
      aiControlled: this.player.type() === PlayerType.Bot,
    });
  }

  restoreSnapshot(s: TankState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.targetTile = s.targetTile;
    this.tank = r.unitOrNull(s.tank);
    this.tankUnit = r.unitOrNull(s.tankUnit);
  }
}

const TankStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  targetTile: zTile(),
  tank: zRef().nullable(),
  tankUnit: zRef().nullable(),
  aiControlled: z.boolean(),
});
type TankState = z.infer<typeof TankStateSchema>;

export const TankExecutionSnapshot = execSnapshotType({
  name: "Tank",
  version: 1,
  schema: TankStateSchema,
  cls: () => TankExecution,
});
