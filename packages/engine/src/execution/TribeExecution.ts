import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Structures, UnitType } from "@openfront/engine-api/game/GameTypes";
import { TechId } from "@openfront/engine-api/game/TechTree";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  VersionedSchema,
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
import { AllianceExtensionExecution } from "./alliance/AllianceExtensionExecution";
import { ConstructionExecution } from "./ConstructionExecution";
import { DeleteUnitExecution } from "./DeleteUnitExecution";
import { PlaneExecution } from "./PlaneExecution";
import { TankExecution } from "./TankExecution";
import { TribeAttackBehavior } from "./TribeAttackBehavior";
import { closestTile } from "./Util";

// How many tanks and planes a tribe keeps alive at once. The build cadence
// follows the tribe's attack ticks, so one unit is queued per cycle at most.
const BOT_MAX_TANKS = 4;
const BOT_MAX_PLANES = 3;

export class TribeExecution implements Execution {
  private active = true;
  private random: PseudoRandom;
  private mg: Game;
  private neighborsTerraNullius = true;

  private attackBehavior: TribeAttackBehavior | null = null;
  private attackRate: number;
  private attackTick: number;
  private triggerRatio: number;
  private reserveRatio: number;
  private expandRatio: number;

  constructor(private tribe: Player) {
    this.random = new PseudoRandom(simpleHash(tribe.id()));
    this.attackRate = this.random.nextInt(40, 80);
    this.attackTick = this.random.nextInt(0, this.attackRate);
    this.triggerRatio = this.random.nextInt(50, 60) / 100;
    this.reserveRatio = this.random.nextInt(30, 40) / 100;
    this.expandRatio = this.random.nextInt(10, 20) / 100;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game) {
    this.mg = mg;
  }

  tick(ticks: number) {
    if (ticks % this.attackRate !== this.attackTick) return;

    if (!this.tribe.isAlive()) {
      //removeOnDeath is called from tribe's PlayerExecution
      this.active = false;
      return;
    }

    if (this.attackBehavior === null) {
      this.attackBehavior = new TribeAttackBehavior(
        this.random,
        this.mg,
        this.tribe,
        this.triggerRatio,
        this.reserveRatio,
        this.expandRatio,
      );

      // Send an attack on the first tick
      this.attackBehavior.sendAttack(this.mg.terraNullius());
      return;
    }

    // The tutorial's tribe only grows into free land, and accepts no
    // alliance: the tutorial has the new player conquer it.
    if (this.mg.config().gameConfig().tutorial) {
      this.attackBehavior.expandIntoFreeLand();
      return;
    }

    this.acceptAllAllianceRequests();
    this.deleteNextStructure();
    this.maybeBuild();
    this.maybeAttack();
  }

  /**
   * Bot building, on the tribe's attack-tick cadence. Stateless on purpose:
   * every cycle it checks prerequisites and affordability and queues at most
   * one construction. Factory first (tanks roll out of it), then City (planes
   * take off from it and both add income), then defensive units at the front.
   */
  private maybeBuild() {
    const hasLive = (type: UnitType) =>
      this.tribe
        .units(type)
        .some((u) => u.isActive() && !u.isUnderConstruction());

    if (!hasLive(UnitType.Factory)) {
      this.buildStructure(UnitType.Factory);
    }
    if (!hasLive(UnitType.City)) {
      this.buildStructure(UnitType.City);
    }

    if (
      this.tribe.hasTech(TechId.Armor) &&
      hasLive(UnitType.Factory) &&
      this.countLive(UnitType.Tank) < BOT_MAX_TANKS
    ) {
      this.buildTank();
    }
    if (
      this.tribe.hasTech(TechId.Aviation) &&
      hasLive(UnitType.City) &&
      this.countLive(UnitType.Plane) < BOT_MAX_PLANES
    ) {
      this.buildPlane();
    }
  }

  private countLive(type: UnitType): number {
    return this.tribe.units(type).filter((u) => u.isActive()).length;
  }

  /** Queue one structure on a border tile the tribe can actually build on. */
  private buildStructure(type: UnitType): boolean {
    for (const tile of this.tribe.borderTiles()) {
      if (this.mg.owner(tile) !== this.tribe) continue;
      const spawn = this.tribe.canBuild(type, tile);
      if (spawn !== false) {
        this.mg.addExecution(
          new ConstructionExecution(this.tribe, type, spawn),
        );
        return true;
      }
    }
    return false;
  }

  /** Queue one tank rolling out of the live factory toward hostile land. */
  private buildTank(): boolean {
    const factory = this.tribe
      .units(UnitType.Factory)
      .find((u) => u.isActive() && !u.isUnderConstruction());
    if (factory === undefined) return false;
    const target = this.nearestHostileTile(factory.tile());
    if (target === null) return false;
    if (this.tribe.canBuild(UnitType.Tank, target) === false) return false;
    this.mg.addExecution(new TankExecution(this.tribe, target));
    return true;
  }

  /** Queue one plane taking off from the live city toward a hostile city. */
  private buildPlane(): boolean {
    const city = this.tribe
      .units(UnitType.City)
      .find((u) => u.isActive() && !u.isUnderConstruction());
    if (city === undefined) return false;

    const hostileCities: TileRef[] = [];
    for (const p of this.mg.players()) {
      if (!p.isPlayer() || !p.isAlive() || this.tribe.isFriendly(p)) continue;
      for (const c of p.units(UnitType.City)) {
        if (c.isActive()) hostileCities.push(c.tile());
      }
    }
    const [target] = closestTile(this.mg, hostileCities, city.tile());
    if (target === null) return false;
    if (this.tribe.canBuild(UnitType.Plane, target) === false) return false;
    this.mg.addExecution(new PlaneExecution(this.tribe, target));
    return true;
  }

  /** Nearest border tile of a hostile player to `from`, or null. */
  private nearestHostileTile(from: TileRef): TileRef | null {
    let best: TileRef | null = null;
    let bestDist = Infinity;
    for (const p of this.mg.players()) {
      if (!p.isPlayer() || !p.isAlive() || this.tribe.isFriendly(p)) continue;
      const [tile, dist] = closestTile(this.mg, p.borderTiles(), from);
      if (tile !== null && dist < bestDist) {
        bestDist = dist;
        best = tile;
      }
    }
    return best;
  }

  private acceptAllAllianceRequests() {
    // Accept all alliance requests
    for (const req of this.tribe.incomingAllianceRequests()) {
      req.accept();
    }

    // Accept all alliance extension requests
    for (const alliance of this.tribe.alliances()) {
      // Alliance expiration tracked by Events Panel, only human ally can click Request to Renew
      // Skip if no expiration yet/ ally didn't request extension yet / tribe already agreed to extend
      if (!alliance.onlyOneAgreedToExtend()) continue;

      const human = alliance.other(this.tribe);
      this.mg.addExecution(
        new AllianceExtensionExecution(this.tribe, human.id()),
      );
    }
  }

  private deleteNextStructure() {
    if (!this.tribe.canDeleteUnit()) return;
    for (const unit of this.tribe.units()) {
      if (!Structures.has(unit.type())) continue;
      if (unit.isMarkedForDeletion()) continue;
      this.mg.addExecution(new DeleteUnitExecution(this.tribe, unit.id()));
      return;
    }
  }

  private maybeAttack() {
    if (this.attackBehavior === null) {
      throw new Error("not initialized");
    }
    const toAttack = this.attackBehavior.getNeighborTraitorToAttack(true);
    if (toAttack !== null) {
      const odds = this.tribe.isFriendly(toAttack) ? 6 : 3;
      if (this.random.chance(odds)) {
        // Check and break alliance before attacking if needed
        const alliance = this.tribe.allianceWith(toAttack);

        if (alliance !== null) {
          this.tribe.breakAlliance(alliance);
        }

        if (this.attackBehavior.sendAttack(toAttack)) return;
      }
    }

    if (this.neighborsTerraNullius) {
      if (this.tribe.nearby().some((n) => !n.isPlayer())) {
        if (this.attackBehavior.sendAttack(this.mg.terraNullius())) return;
      } else {
        this.neighborsTerraNullius = false;
      }
    }

    this.attackBehavior.attackRandomTarget();
  }

  isActive(): boolean {
    return this.active;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return TribeExecutionSnapshot.write({
      active: this.active,
      tribe: w.player(this.tribe),
      random: w.random(this.random),
      initialized: this.mg !== undefined,
      neighborsTerraNullius: this.neighborsTerraNullius,
      attackBehavior: this.attackBehavior?.snapshot(w) ?? null,
      attackRate: this.attackRate,
      attackTick: this.attackTick,
      triggerRatio: this.triggerRatio,
      reserveRatio: this.reserveRatio,
      expandRatio: this.expandRatio,
    });
  }

  restoreSnapshot(s: TribeState, r: SnapshotReader): void {
    this.active = s.active;
    this.tribe = r.player(s.tribe);
    // One PRNG shared with the attack behavior, as in a live game.
    this.random = r.random(s.random);
    if (s.initialized) this.mg = r.game;
    this.neighborsTerraNullius = s.neighborsTerraNullius;
    if (s.attackBehavior === null) {
      this.attackBehavior = null;
    } else {
      const attack = Object.create(
        TribeAttackBehavior.prototype,
      ) as TribeAttackBehavior;
      attack.restoreSnapshot(s.attackBehavior, r, this.random, this.tribe);
      this.attackBehavior = attack;
    }
    this.attackRate = s.attackRate;
    this.attackTick = s.attackTick;
    this.triggerRatio = s.triggerRatio;
    this.reserveRatio = s.reserveRatio;
    this.expandRatio = s.expandRatio;
  }
}

const TribeStateSchema = z.object({
  active: z.boolean(),
  tribe: zPlayerRef(),
  random: zRandom(),
  initialized: z.boolean(),
  neighborsTerraNullius: z.boolean(),
  attackBehavior: VersionedSchema.nullable(),
  attackRate: zNum(),
  attackTick: zNum(),
  triggerRatio: zNum(),
  reserveRatio: zNum(),
  expandRatio: zNum(),
});
type TribeState = z.infer<typeof TribeStateSchema>;

export const TribeExecutionSnapshot = execSnapshotType({
  name: "Tribe",
  version: 1,
  schema: TribeStateSchema,
  cls: () => TribeExecution,
});
