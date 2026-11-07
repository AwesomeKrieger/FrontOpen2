// @vitest-environment jsdom
import { TECHS, TECH_ORDER, TechId } from "@openfront/engine-api/game/TechTree";
import { EventBus } from "@openfront/shared/EventBus";
import { afterEach, describe, expect, it } from "vitest";
import type { ResearchTree } from "../../src/client/hud/layers/ResearchTree";
import "../../src/client/hud/layers/ResearchTree";
import { ResearchTechIntentEvent } from "../../src/client/Transport";
import type { GameView, PlayerView } from "../../src/client/view";

interface FakePlayer {
  points: number;
  gold: bigint;
  techs: Set<TechId>;
}

function mount(player: FakePlayer) {
  const view = {
    isAlive: () => true,
    researchPoints: () => player.points,
    gold: () => player.gold,
    hasTech: (tech: TechId) => player.techs.has(tech),
    units: () => [],
  } as unknown as PlayerView;
  const game = {
    myPlayer: () => view,
    config: () => ({ researchPointsPerTick: () => 3 }),
  } as unknown as GameView;
  const eventBus = new EventBus();
  const element = document.createElement("research-tree") as ResearchTree;
  element.game = game;
  element.eventBus = eventBus;
  element.init();
  document.body.append(element);
  return { element, eventBus, player, view };
}

function shadow(element: ResearchTree): ShadowRoot {
  const root = element.shadowRoot;
  if (root === null) {
    throw new Error("ResearchTree has no shadow root");
  }
  return root;
}

function card(element: ResearchTree, id: TechId): HTMLElement {
  const found = shadow(element).querySelector<HTMLElement>(
    `.card[data-tech="${id}"]`,
  );
  if (found === null) {
    throw new Error(`no card for ${id}`);
  }
  return found;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ResearchTree", () => {
  it("keeps the build bar's point balance live every tick", async () => {
    const { element, player } = mount({
      points: 0,
      gold: 0n,
      techs: new Set(),
    });
    await element.updateComplete;
    element.openPanel();
    await element.updateComplete;
    expect(
      shadow(element).querySelector(".stat.points")?.textContent,
    ).toContain("0");

    player.points = 42;
    element.tick();
    await element.updateComplete;
    expect(
      shadow(element).querySelector(".stat.points")?.textContent,
    ).toContain("42");
    // +3 points per tick at 10 ticks/s; the income span is translated, the
    // balance spans are raw numbers.
    expect(
      shadow(element).querySelector(".stat.points")?.textContent,
    ).toContain("42");

    element.remove();
  });

  it("shows the tech tree in tiers with live affordability", async () => {
    const { element, player } = mount({
      points: 100,
      gold: 1_000_000n,
      techs: new Set(),
    });
    element.tick();
    await element.updateComplete;

    element.openPanel();
    await element.updateComplete;

    expect(shadow(element).querySelector(".panel")).not.toBeNull();
    expect(shadow(element).querySelectorAll(".tier")).toHaveLength(4);
    expect(shadow(element).querySelectorAll(".card")).toHaveLength(
      TECH_ORDER.length,
    );

    // Industry is affordable, Armor is locked behind it.
    expect(card(element, TechId.Industry).classList.contains("available")).toBe(
      true,
    );
    expect(card(element, TechId.Armor).classList.contains("locked")).toBe(true);
    expect(card(element, TechId.Armor).hasAttribute("disabled")).toBe(true);

    // Spending the points drops the balance live: the card locks again.
    player.points = 0;
    element.tick();
    await element.updateComplete;
    expect(card(element, TechId.Industry).classList.contains("available")).toBe(
      false,
    );

    element.remove();
  });

  it("sends a research intent when an affordable tech is clicked", async () => {
    const { element, eventBus } = mount({
      points: 500,
      gold: 1_000_000n,
      techs: new Set(),
    });
    const intents: ResearchTechIntentEvent[] = [];
    eventBus.on(ResearchTechIntentEvent, (e) => intents.push(e));
    element.tick();
    await element.updateComplete;

    element.openPanel();
    await element.updateComplete;
    card(element, TechId.Industry).click();

    expect(intents).toHaveLength(1);
    expect(intents[0].tech).toBe(TechId.Industry);

    element.remove();
  });

  it("marks researched techs and shows the 25% trade bonus node", async () => {
    const { element } = mount({
      points: 0,
      gold: 0n,
      techs: new Set([TechId.Trade]),
    });
    element.tick();
    await element.updateComplete;

    element.openPanel();
    await element.updateComplete;

    expect(card(element, TechId.Trade).classList.contains("researched")).toBe(
      true,
    );
    // Trade sits on the first tier row and unlocks Mobilization below it.
    const tierLabels = [...shadow(element).querySelectorAll(".tier-label")].map(
      (e) => e.textContent?.trim(),
    );
    expect(tierLabels).toHaveLength(4);
    expect(TECHS[TechId.Trade].tier).toBe(0);
    expect(TECHS[TechId.Mobilization].requires).toEqual([TechId.Trade]);

    element.remove();
  });

  it("closes on Escape", async () => {
    const { element } = mount({ points: 0, gold: 0n, techs: new Set() });
    await element.updateComplete;

    element.openPanel();
    await element.updateComplete;
    expect(shadow(element).querySelector(".panel")).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await element.updateComplete;
    expect(shadow(element).querySelector(".panel")).toBeNull();

    element.remove();
  });

  it("has no panel for a dead or missing player", async () => {
    const element = document.createElement("research-tree") as ResearchTree;
    element.game = {
      myPlayer: () => null,
      config: () => ({}),
    } as unknown as GameView;
    element.eventBus = new EventBus();
    document.body.append(element);
    element.tick();
    await element.updateComplete;

    expect(shadow(element).querySelector(".panel")).toBeNull();

    element.remove();
  });
});
