import { Gold, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  TECHS,
  TECH_ORDER,
  TECH_TIER_COUNT,
  TechId,
} from "@openfront/engine-api/game/TechTree";
import { renderNumber } from "@openfront/engine-lib/Format";
import { EventBus } from "@openfront/shared/EventBus";
import { css, html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { CloseViewEvent, MouseDownEvent } from "../../InputHandler";
import { ResearchTechIntentEvent } from "../../Transport";
import { translateText } from "../../Utils";
import { GameView } from "../../view";
import type { PlayerView } from "../../view/PlayerView";
import { goldCoinIcon, planeIcon, tankIcon } from "../HotbarIcons";

/** The simulation runs at 10 ticks per second; rates are shown per second. */
const TICKS_PER_SECOND = 10;

interface TechCard {
  id: TechId;
  /** Already unlocked. */
  researched: boolean;
  /** Prerequisites met and affordable right now. */
  available: boolean;
  /** Some prerequisite is still missing. */
  locked: boolean;
  /** Prerequisites met, but the research points (or gold) are not there yet. */
  affordableRp: boolean;
  affordableGold: boolean;
  prerequisites: TechId[];
  researchPoints: number;
  gold: Gold;
}

/**
 * The tech tree: a HUD panel listing the research nodes by tier. Research
 * points accrue from cities and factories; each tech costs points plus gold.
 *
 * The button stays in the HUD the whole match and shows the live balance, so
 * a player always sees what they are saving towards. The panel itself follows
 * the build menu's look: a centered dark modal with one row of cards per tier.
 * Open/close with the button, the close button or Escape.
 */
@customElement("research-tree")
export class ResearchTree extends LitElement implements Controller {
  @state() public game!: GameView;
  @state() public eventBus!: EventBus;

  @state() private open = false;
  @state() private cards: TechCard[] = [];
  @state() private points = 0;
  @state() private incomePerSecond = 0;
  @state() private researchedCount = 0;
  @state() private availableCount = 0;

  private escapeHandler = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !this.open) {
      return;
    }
    this.setOpen(false);
  };

  init() {
    window.addEventListener("keydown", this.escapeHandler);
    // Opening any other view (build menu, player panel, settings, ...) closes
    // the research panel, so two modals never stack.
    this.eventBus.on(CloseViewEvent, () => this.setOpen(false));
    this.eventBus.on(MouseDownEvent, () => this.setOpen(false));
    this.requestUpdate();
  }

  connectedCallback() {
    super.connectedCallback();
    this.requestUpdate();
  }

  disconnectedCallback() {
    window.removeEventListener("keydown", this.escapeHandler);
    super.disconnectedCallback();
  }

  /**
   * Runs every tick (10Hz). The point balance and the availability badge are
   * refreshed unconditionally so the HUD button never shows a stale value;
   * the card list is only rebuilt while the panel is open (or before its
   * first render).
   */
  tick() {
    const player = this.game?.myPlayer();
    if (!player) {
      this.points = 0;
      this.incomePerSecond = 0;
      this.researchedCount = 0;
      this.availableCount = 0;
      return;
    }
    this.points = player.researchPoints();
    this.incomePerSecond = Math.round(
      this.game.config().researchPointsPerTick(player) * TICKS_PER_SECOND,
    );
    this.researchedCount = TECH_ORDER.filter((id) => player.hasTech(id)).length;
    this.availableCount = TECH_ORDER.filter((id) =>
      this.canResearch(player, id),
    ).length;

    if (this.open || this.cards.length === 0) {
      this.refreshCards(player);
    }
  }

  private refreshCards(player: PlayerView) {
    this.cards = TECH_ORDER.map((id) => {
      const tech = TECHS[id];
      const researched = player.hasTech(id);
      const prerequisites = [...tech.requires];
      const missingPrerequisite = prerequisites.some(
        (required) => !player.hasTech(required),
      );
      return {
        id,
        researched,
        available: this.canResearch(player, id),
        locked: !researched && missingPrerequisite,
        affordableRp: player.researchPoints() >= tech.researchPoints,
        affordableGold: player.gold() >= tech.gold,
        prerequisites,
        researchPoints: tech.researchPoints,
        gold: tech.gold,
      };
    });
  }

  private canResearch(player: PlayerView, id: TechId): boolean {
    if (player.hasTech(id)) {
      return false;
    }
    const tech = TECHS[id];
    for (const required of tech.requires) {
      if (!player.hasTech(required)) {
        return false;
      }
    }
    return (
      player.researchPoints() >= tech.researchPoints &&
      player.gold() >= tech.gold
    );
  }

  private research(id: TechId) {
    this.eventBus.emit(new ResearchTechIntentEvent(id));
  }

  private setOpen(open: boolean) {
    if (this.open === open) {
      return;
    }
    this.open = open;
    const player = this.game?.myPlayer();
    if (open && player) {
      this.refreshCards(player);
    }
  }

  private toggle() {
    this.setOpen(!this.open);
  }

  static styles = css`
    :host {
      display: block;
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 10050;
      font-family: inherit;
    }
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 1;
      pointer-events: auto;
      background: rgba(0, 0, 0, 0.25);
    }
    .toggle {
      position: fixed;
      left: 0.75rem;
      bottom: 9.5rem;
      z-index: 2;
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.3rem 0.6rem;
      border-radius: 0.375rem;
      border: 1px solid #64748b;
      background: rgba(31, 41, 55, 0.92);
      color: #fff;
      font-size: 0.75rem;
      font-weight: 700;
      cursor: pointer;
      backdrop-filter: blur(4px);
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
    }
    .toggle:hover {
      background: rgba(55, 65, 81, 0.95);
      border-color: #94a3b8;
    }
    .toggle .toggle-icon {
      font-size: 1rem;
      line-height: 1;
    }
    .toggle .toggle-rp {
      color: #a5b4fc;
      font-variant-numeric: tabular-nums;
    }
    .toggle .toggle-rate {
      color: #4ade80;
      font-variant-numeric: tabular-nums;
      font-size: 0.68rem;
      opacity: 0.9;
    }
    .toggle.attention {
      border-color: #4ade80;
      box-shadow: 0 0 8px rgba(74, 222, 128, 0.55);
    }
    .toggle.attention .toggle-icon {
      animation: research-pulse 1.6s ease-in-out infinite;
    }
    @keyframes research-pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.55;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .toggle.attention .toggle-icon {
        animation: none;
      }
    }
    @media (max-width: 480px) {
      .toggle {
        bottom: 8.5rem;
        padding: 0.25rem 0.45rem;
        font-size: 0.68rem;
        gap: 0.25rem;
      }
      .toggle .toggle-label,
      .toggle .toggle-rate {
        display: none;
      }
    }
    .panel {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 2;
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      max-width: 95vw;
      max-height: 88vh;
      overflow-y: auto;
      padding: 15px;
      color: #fff;
      background-color: #1e1e1e;
      border-radius: 10px;
      box-shadow: 0 0 20px rgba(0, 0, 0, 0.5);
    }
    .panel-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      width: 100%;
      margin-bottom: 0.6rem;
      flex-wrap: wrap;
    }
    .panel-title {
      font-size: 1.05rem;
      font-weight: 800;
      margin-right: auto;
    }
    .stats {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      flex-wrap: wrap;
      font-size: 0.75rem;
    }
    .stat {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      border: 1px solid #475569;
      border-radius: 0.375rem;
      padding: 0.15rem 0.45rem;
      background: #26303c;
      font-variant-numeric: tabular-nums;
    }
    .stat.points {
      border-color: #6366f1;
      color: #c7d2fe;
    }
    .stat.rate {
      border-color: #16a34a;
      color: #86efac;
    }
    .close {
      border: 1px solid #444;
      background: #2c2c2c;
      color: #fff;
      border-radius: 0.4rem;
      padding: 0.15rem 0.5rem;
      cursor: pointer;
      font-size: 0.8rem;
    }
    .close:hover {
      background: #3a3a3a;
    }
    .tier {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 100%;
      margin-bottom: 0.4rem;
    }
    .tier-label {
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.55;
      margin-bottom: 0.15rem;
    }
    .tier-row {
      display: flex;
      justify-content: center;
      flex-wrap: wrap;
      width: 100%;
    }
    .card {
      position: relative;
      width: 132px;
      min-height: 168px;
      border: 2px solid #444;
      background-color: #2c2c2c;
      color: white;
      border-radius: 12px;
      cursor: pointer;
      transition: all 0.3s ease;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      align-items: center;
      margin: 8px;
      padding: 8px;
      gap: 4px;
      text-align: center;
    }
    .card:not(:disabled):hover {
      background-color: #3a3a3a;
      transform: scale(1.05);
      border-color: #666;
    }
    .card:disabled {
      background-color: #1a1a1a;
      border-color: #333;
      cursor: not-allowed;
      opacity: 0.7;
    }
    .card.available {
      border-color: #4ade80;
    }
    .card.researched {
      border-color: #60a5fa;
      opacity: 0.75;
      cursor: default;
    }
    .card.locked {
      opacity: 0.5;
    }
    .card-icon {
      font-size: 1.6rem;
      line-height: 1;
    }
    .card-name {
      font-size: 0.8rem;
      font-weight: bold;
      line-height: 1.1;
    }
    .card-desc {
      font-size: 0.62rem;
      opacity: 0.8;
      line-height: 1.15;
    }
    .card-costs {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: auto;
      font-size: 0.72rem;
      font-weight: 700;
    }
    .cost {
      display: flex;
      align-items: center;
      gap: 2px;
      font-variant-numeric: tabular-nums;
    }
    .cost.rp {
      color: #c7d2fe;
    }
    .cost.rp.insufficient {
      color: #f87171;
    }
    .cost.gold {
      color: #facc15;
    }
    .cost.gold.insufficient {
      color: #f87171;
    }
    .cost img {
      width: 12px;
      height: 12px;
    }
    .card-requires {
      font-size: 0.58rem;
      opacity: 0.7;
      line-height: 1.1;
    }
    .card-unlocks {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.6rem;
      opacity: 0.85;
    }
    .card-unlocks img {
      width: 16px;
      height: 16px;
    }
    .card-badge {
      position: absolute;
      top: -9px;
      right: -9px;
      padding: 1px 8px;
      border-radius: 10000px;
      font-size: 0.62rem;
      font-weight: 700;
      background: #1d4ed8;
      color: #fff;
      border: 1px solid #3b82f6;
    }
    .panel-footer {
      width: 100%;
      margin-top: 0.35rem;
      font-size: 0.65rem;
      opacity: 0.65;
      text-align: center;
    }
    @media (max-width: 768px) {
      .panel {
        padding: 10px;
        max-height: 85vh;
        width: 92vw;
      }
      .card {
        width: calc(50% - 12px);
        min-height: 130px;
        margin: 4px;
        padding: 6px;
      }
      .card-icon {
        font-size: 1.3rem;
      }
      .card-name {
        font-size: 0.72rem;
      }
      .card-desc {
        font-size: 0.58rem;
      }
      .stats {
        font-size: 0.68rem;
      }
    }
  `;

  private techName(id: TechId): string {
    return translateText(`research.tech.${id}.name`);
  }

  private techDesc(id: TechId): string {
    return translateText(`research.tech.${id}.desc`);
  }

  render() {
    const player = this.game?.myPlayer();
    if (!player || !player.isAlive()) {
      return nothing;
    }
    if (this.cards.length === 0) {
      this.refreshCards(player);
    }

    return html`
      <button
        class="toggle ${this.availableCount > 0 ? "attention" : ""}"
        @click=${() => this.toggle()}
        title=${translateText("research.button")}
      >
        <span class="toggle-icon">🔬</span>
        <span class="toggle-label">${translateText("research.button")}</span>
        <span class="toggle-rp"
          >${renderNumber(this.points)}
          ${translateText("research.points_short")}</span
        >
        <span class="toggle-rate"
          >+${renderNumber(this.incomePerSecond)}/s</span
        >
      </button>

      ${this.open ? this.renderPanel() : nothing}
    `;
  }

  private renderPanel() {
    const tiers: TechCard[][] = [];
    for (let t = 0; t < TECH_TIER_COUNT; t++) {
      tiers.push(this.cards.filter((c) => TECHS[c.id].tier === t));
    }

    return html`
      <div
        class="backdrop"
        @click=${() => this.setOpen(false)}
        aria-hidden="true"
      ></div>
      <div
        class="panel"
        role="dialog"
        aria-label=${translateText("research.title")}
        @contextmenu=${(e: MouseEvent) => e.preventDefault()}
      >
        <div class="panel-header">
          <span class="panel-title">${translateText("research.title")}</span>
          <div class="stats">
            <span class="stat points" translate="no"
              >🔬 ${renderNumber(this.points)}
              ${translateText("research.points_short")}</span
            >
            <span class="stat rate" translate="no"
              >${translateText("research.income", {
                points: renderNumber(this.incomePerSecond),
              })}</span
            >
            <span class="stat"
              >${translateText("research.researched_count", {
                researched: this.researchedCount,
                total: TECH_ORDER.length,
              })}</span
            >
          </div>
          <button
            class="close"
            @click=${() => this.setOpen(false)}
            title=${translateText("common.close")}
          >
            ✕
          </button>
        </div>
        ${tiers.map(
          (tierCards, tierIndex) => html`
            <div class="tier">
              <div class="tier-label">
                ${translateText("research.tier")} ${tierIndex + 1}
              </div>
              <div class="tier-row">
                ${tierCards.map((card) => this.renderCard(card))}
              </div>
            </div>
          `,
        )}
        <div class="panel-footer">${translateText("research.hint")}</div>
      </div>
    `;
  }

  private renderCard(card: TechCard) {
    const klass = card.researched
      ? "researched"
      : card.available
        ? "available"
        : card.locked
          ? "locked"
          : "";
    const tech = TECHS[card.id];
    const unlockIcon = this.unlockIcon(card.id);
    return html`
      <button
        class="card ${klass}"
        data-tech=${card.id}
        ?disabled=${!card.available}
        @click=${() => card.available && this.research(card.id)}
        title=${
          card.locked
            ? translateText("research.requires")
            : card.available
              ? this.techDesc(card.id)
              : translateText("research.unaffordable")
        }
      >
        ${
          card.researched
            ? html`<span class="card-badge"
                >${translateText("research.researched")}</span
              >`
            : nothing
        }
        <span class="card-icon">${this.techIcon(card.id)}</span>
        <span class="card-name">${this.techName(card.id)}</span>
        <span class="card-desc">${this.techDesc(card.id)}</span>
        ${
          unlockIcon
            ? html`<span class="card-unlocks"
                ><img src=${unlockIcon.icon} alt="" width="16" height="16" />
                ${translateText(unlockIcon.key)}</span
              >`
            : nothing
        }
        <span class="card-costs">
          <span class="cost rp ${card.affordableRp ? "" : "insufficient"}"
            >${card.researchPoints}
            ${translateText("research.points_short")}</span
          >
          <span
            class="cost gold ${card.affordableGold ? "" : "insufficient"}"
            translate="no"
            >${renderNumber(card.gold)}
            <img src=${goldCoinIcon} alt="" width="12" height="12"
          /></span>
        </span>
        ${
          tech.requires.length > 0
            ? html`<span class="card-requires"
                >${translateText("research.requires")}
                ${tech.requires.map((p) => this.techName(p)).join(", ")}</span
              >`
            : nothing
        }
      </button>
    `;
  }

  private unlockIcon(id: TechId): { icon: string; key: string } | null {
    switch (TECHS[id].unlocksUnit) {
      case UnitType.Tank:
        return { icon: tankIcon, key: "unit_type.tank" };
      case UnitType.Plane:
        return { icon: planeIcon, key: "unit_type.plane" };
      default:
        return null;
    }
  }

  private techIcon(id: TechId): string {
    switch (id) {
      case TechId.Industry:
        return "🏭";
      case TechId.Logistics:
        return "📦";
      case TechId.Trade:
        return "💰";
      case TechId.Mobilization:
        return "🎖️";
      case TechId.Armor:
        return "🛡️";
      case TechId.Aviation:
        return "✈️";
      case TechId.ReinforcedArmor:
        return "🔰";
      case TechId.PrecisionBombing:
        return "🎯";
      default:
        return "🔬";
    }
  }
}
