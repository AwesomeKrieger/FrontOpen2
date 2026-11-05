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
 * A plane: an air unit that ignores terrain and flies from the player's
 * nearest city to a target tile, bombs everything hostile in a radius, then is
 * spent. Planes are unlocked by the Aviation tech.
 *
 * The flight is a deterministic integer straight line, `Config.planeSpeed()`
 * tiles per tick.
 */
export class PlaneExecution implements Execution {
  private active = true;
  private mg: Game;
  private plane: Unit | null = null;

  constructor(
    private player: Player,
    private targetTile: TileRef,
    private planeUnit: Unit | null = null,
  ) {}

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;

    if (this.planeUnit !== null) {
      this.plane = this.planeUnit;
      return;
    }

    if (!this.player.hasTech(TechId.Aviation)) {
      console.warn(
        `SECURITY: ${this.player.displayName()} has not researched Aviation`,
      );
      this.active = false;
      return;
    }

    if (!mg.isValidRef(this.targetTile)) {
      this.active = false;
      return;
    }

    const city = this.closestCity();
    if (city === null) {
      this.active = false;
      return;
    }

    this.plane = this.player.buildUnit(UnitType.Plane, city.tile(), {
      targetTile: this.targetTile,
    });
  }

  private closestCity(): Unit | null {
    let best: Unit | null = null;
    let bestDist = Number.MAX_SAFE_INTEGER;
    for (const unit of this.player.units(UnitType.City)) {
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
    if (this.plane === null || !this.plane.isActive()) {
      this.active = false;
      return;
    }
    if (!this.player.isAlive() || this.plane.owner() !== this.player) {
      this.active = false;
      return;
    }

    // SAM point-defence: hostile SAM launchers within range shoot the plane
    // down. This is a simplified interception (instant damage) rather than
    // a tracked missile trajectory.
    const samTargets = this.mg.nearbyUnits(
      this.plane.tile(),
      999,
      UnitType.SAMLauncher,
      ({ unit }) => {
        const owner = unit.owner();
        return (
          owner.isPlayer() &&
          owner !== this.player &&
          !this.player.isFriendly(owner as Player) &&
          unit.isActive() &&
          !unit.isUnderConstruction()
        );
      },
    );
    for (const { unit: sam } of samTargets) {
      const range = this.mg.config().samRange(sam.level());
      if (this.mg.manhattanDist(sam.tile(), this.plane.tile()) <= range) {
        this.plane.modifyHealth(-40, sam.owner() as Player);
        if (!this.plane.isActive()) {
          this.active = false;
          return;
        }
      }
    }

    const arrived = this.moveTowardsTarget();
    if (arrived) {
      this.bomb();
      this.plane.delete(false);
      this.active = false;
    }
  }

  /**
   * Fly a straight integer line toward the target. Returns true once the
   * plane is at (or has crossed) the target tile.
   */
  private moveTowardsTarget(): boolean {
    if (this.plane === null) {
      return false;
    }
    const speed = this.mg.config().planeSpeed();
    const from = this.plane.tile();
    if (from === this.targetTile) {
      return true;
    }

    const fx = this.mg.x(from);
    const fy = this.mg.y(from);
    const tx = this.mg.x(this.targetTile);
    const ty = this.mg.y(this.targetTile);

    const dx = tx - fx;
    const dy = ty - fy;
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    if (dist <= speed) {
      this.plane.move(this.targetTile);
      this.plane.setReachedTarget();
      this.plane.touch();
      return true;
    }

    // Integer step along the line; Math.trunc keeps this deterministic.
    const stepX = Math.trunc((dx * speed) / dist);
    const stepY = Math.trunc((dy * speed) / dist);
    let nx = fx + stepX;
    let ny = fy + stepY;
    if (nx === fx && ny === fy) {
      // Very long diagonal: guarantee at least one tile of progress.
      nx = fx + Math.sign(dx);
      ny = fy + Math.sign(dy);
    }
    if (!this.mg.isValidCoord(nx, ny)) {
      return true;
    }
    this.plane.move(this.mg.ref(nx, ny));
    return (
      this.mg.x(this.plane.tile()) === tx && this.mg.y(this.plane.tile()) === ty
    );
  }

  private bomb(): void {
    if (this.plane === null) {
      return;
    }
    const config = this.mg.config();
    const range = config.planeBombRadius();
    const damage = Math.floor(
      config.planeDamage() * config.planeDamageMultiplier(this.player),
    );
    const tile = this.plane.tile();

    // Troops of hostile players whose territory is under the blast.
    const hitPlayers = new Set<Player>();
    for (const t of this.mg.circleSearch(tile, range)) {
      const owner = this.mg.owner(t);
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

    // Hostile units with health take the same hit.
    const targets = this.mg.nearbyUnits(
      tile,
      range,
      [UnitType.Tank, UnitType.Plane, UnitType.Warship],
      ({ unit }) => this.isHostileUnit(unit as Unit),
    );
    for (const { unit } of targets) {
      if (unit.hasHealth()) {
        unit.modifyHealth(-damage, this.player);
      }
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
    return PlaneExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      targetTile: this.targetTile,
      plane: w.unitOrNull(this.plane),
      planeUnit: w.unitOrNull(this.planeUnit),
      aiControlled: this.player.type() === PlayerType.Bot,
    });
  }

  restoreSnapshot(s: PlaneState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.targetTile = s.targetTile;
    this.plane = r.unitOrNull(s.plane);
    this.planeUnit = r.unitOrNull(s.planeUnit);
  }
}

const PlaneStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  targetTile: zTile(),
  plane: zRef().nullable(),
  planeUnit: zRef().nullable(),
  aiControlled: z.boolean(),
});
type PlaneState = z.infer<typeof PlaneStateSchema>;

export const PlaneExecutionSnapshot = execSnapshotType({
  name: "Plane",
  version: 1,
  schema: PlaneStateSchema,
  cls: () => PlaneExecution,
});
