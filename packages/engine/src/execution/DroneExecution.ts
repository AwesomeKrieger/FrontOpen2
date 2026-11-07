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
 * A drone: a late-game air unit launched from the nearest factory. Faster and
 * deadlier than a plane but fragile on the way in, and SAM launchers burn
 * drones down twice as fast as planes. Unlocked by the Drone Warfare tech.
 *
 * Flight and bombing mirror PlaneExecution: an integer straight line at
 * `Config.droneSpeed()` tiles per tick, then one strike on arrival.
 */
export class DroneExecution implements Execution {
  private active = true;
  private mg: Game;
  private drone: Unit | null = null;

  constructor(
    private player: Player,
    private targetTile: TileRef,
    private droneUnit: Unit | null = null,
  ) {}

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;

    if (this.droneUnit !== null) {
      // Restored from a snapshot: the unit already exists.
      this.drone = this.droneUnit;
      return;
    }

    if (!this.player.hasTech(TechId.DroneWarfare)) {
      console.warn(
        `SECURITY: ${this.player.displayName()} has not researched Drone Warfare`,
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
      // No factory to launch from.
      this.active = false;
      return;
    }

    this.drone = this.player.buildUnit(UnitType.Drone, factory.tile(), {
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
    if (this.drone === null || !this.drone.isActive()) {
      this.active = false;
      return;
    }
    if (!this.player.isAlive() || this.drone.owner() !== this.player) {
      this.active = false;
      return;
    }

    // SAM launchers within range burn the drone down; drones carry no
    // countermeasures, so they eat double the damage a plane takes.
    this.samDamage(80);
    if (!this.drone?.isActive() || !this.active) {
      return;
    }

    // Attrition: hostile skies are dangerous even without SAMs.
    this.territoryAttrition();
    if (!this.drone?.isActive() || !this.active) {
      return;
    }

    const arrived = this.moveTowardsTarget();
    if (arrived) {
      this.strike();
      this.drone.delete(false);
      this.active = false;
    }
  }

  /** SAM launchers in range shoot down air units over their site. */
  private samDamage(damage: number): void {
    if (this.drone === null) {
      return;
    }
    const samTargets = this.mg.nearbyUnits(
      this.drone.tile(),
      30,
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
      if (this.mg.manhattanDist(sam.tile(), this.drone.tile()) <= range) {
        this.drone.modifyHealth(-damage, sam.owner() as Player);
        if (!this.drone.isActive()) {
          this.active = false;
          return;
        }
      }
    }
  }

  /** The drone takes attrition damage while over hostile territory. */
  private territoryAttrition(): void {
    if (this.drone === null) {
      return;
    }
    const owner = this.mg.owner(this.drone.tile());
    if (
      owner.isPlayer() &&
      owner !== this.player &&
      !this.player.isFriendly(owner as Player)
    ) {
      this.drone.modifyHealth(
        -this.mg.config().planeTerritoryAttrition(),
        owner as Player,
      );
      if (!this.drone.isActive()) {
        this.active = false;
      }
    }
  }

  /**
   * Fly a straight integer line toward the target. Returns true once the
   * drone is at (or has crossed) the target tile.
   */
  private moveTowardsTarget(): boolean {
    if (this.drone === null) {
      return false;
    }
    const speed = this.mg.config().droneSpeed();
    const from = this.drone.tile();
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
      this.drone.move(this.targetTile);
      this.drone.setReachedTarget();
      this.drone.touch();
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
    this.drone.move(this.mg.ref(nx, ny));
    return (
      this.mg.x(this.drone.tile()) === tx && this.mg.y(this.drone.tile()) === ty
    );
  }

  private strike(): void {
    if (this.drone === null) {
      return;
    }
    const config = this.mg.config();
    const range = config.droneBombRadius();
    const damage = config.droneDamage();
    const tile = this.drone.tile();

    // Scorched earth: the strike leaves permanent gray fallout scars.
    this.scorchTiles(tile, range, 4);

    // Troops of hostile players whose territory is under the strike.
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
      [UnitType.Tank, UnitType.Plane, UnitType.Drone, UnitType.Warship],
      ({ unit }) => this.isHostileUnit(unit as Unit),
    );
    for (const { unit } of targets) {
      unit.modifyHealth(-damage, this.player);
    }

    // Structures in the blast burn too.
    this.damageStructures(tile, range, damage);
  }

  /**
   * Carve gray fallout scars into hostile territory: relinquish the tiles
   * (fallout throws on owned tiles) and mark them, up to `maxTiles` of them.
   */
  private scorchTiles(center: TileRef, range: number, maxTiles: number): void {
    const tiles: TileRef[] = [];
    for (const t of this.mg.circleSearch(center, range)) {
      if (!this.mg.isLand(t) || this.mg.hasFallout(t) || !this.mg.hasOwner(t)) {
        continue;
      }
      const owner = this.mg.owner(t);
      if (owner.isPlayer() && this.player.isFriendly(owner as Player)) {
        continue;
      }
      tiles.push(t);
    }
    if (tiles.length === 0 || maxTiles <= 0) {
      return;
    }
    // Deterministic spread: every N-th eligible tile, so replays and snapshots
    // stay stable while the scars land across the whole radius.
    const step = Math.ceil(tiles.length / maxTiles);
    for (let i = 0; i < tiles.length && maxTiles > 0; i++) {
      if (i % step !== 0) {
        continue;
      }
      this.mg.relinquish(tiles[i]);
      this.mg.setFallout(tiles[i], true);
      maxTiles--;
    }
  }

  /** Hostile structures in the blast take health damage. */
  private damageStructures(
    center: TileRef,
    range: number,
    damage: number,
  ): void {
    const structures = this.mg.nearbyUnits(
      center,
      range,
      [
        UnitType.City,
        UnitType.Factory,
        UnitType.Port,
        UnitType.DefensePost,
        UnitType.SAMLauncher,
        UnitType.MissileSilo,
        UnitType.RobotFactory,
      ],
      ({ unit }) => this.isHostileUnit(unit as Unit),
    );
    for (const { unit: structure } of structures) {
      structure.modifyHealth(-damage, this.player);
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
    return DroneExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      targetTile: this.targetTile,
      drone: w.unitOrNull(this.drone),
      droneUnit: w.unitOrNull(this.droneUnit),
      aiControlled: this.player.type() === PlayerType.Bot,
    });
  }

  restoreSnapshot(s: DroneState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.targetTile = s.targetTile;
    this.drone = r.unitOrNull(s.drone);
    this.droneUnit = r.unitOrNull(s.droneUnit);
  }
}

const DroneStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  targetTile: zTile(),
  drone: zRef().nullable(),
  droneUnit: zRef().nullable(),
  aiControlled: z.boolean(),
});
type DroneState = z.infer<typeof DroneStateSchema>;

export const DroneExecutionSnapshot = execSnapshotType({
  name: "Drone",
  version: 1,
  schema: DroneStateSchema,
  cls: () => DroneExecution,
});
