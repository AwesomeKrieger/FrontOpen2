// @vitest-environment jsdom
import { ClientEnv, deriveBasePath } from "../../src/client/ClientEnv";

describe("deriveBasePath", () => {
  it.each([
    ["/", ""],
    ["/game/abc123", ""],
    ["/w0/game/abc123", ""],
    ["/FrontOpen", "/FrontOpen"],
    ["/FrontOpen/", "/FrontOpen"],
    ["/FrontOpen/index.html", "/FrontOpen"],
    ["/a/b/", "/a/b"],
  ])("%s -> %s", (pathname, expected) => {
    expect(deriveBasePath(pathname)).toBe(expected);
  });
});

describe("ClientEnv deployment path", () => {
  beforeEach(() => {
    ClientEnv.reset();
    ClientEnv.resetBasePath();
  });

  it("builds page routes under the deployment path", () => {
    vi.spyOn(ClientEnv, "basePath").mockReturnValue("/FrontOpen");
    expect(ClientEnv.servedFromSubPath()).toBe(true);
    expect(ClientEnv.pageHref("/")).toBe("/FrontOpen/");
    expect(ClientEnv.pageHref("/game/abc")).toBe("/FrontOpen/game/abc");
  });

  it("a game link on a static deployment path carries no worker route", () => {
    vi.spyOn(ClientEnv, "basePath").mockReturnValue("/FrontOpen");
    expect(ClientEnv.gamePath("abc12345")).toBe("/FrontOpen/game/abc12345");
  });

  it("names no server on a static page", () => {
    // A static page (GitHub Pages): the four required values, no cluster map,
    // no instance letter, no serverHost.
    window.BOOTSTRAP_CONFIG = {
      gameEnv: "dev",
      gitCommit: "PAGES",
      turnstileSiteKey: "",
      jwtAudience: "openfront.io",
    } as Window["BOOTSTRAP_CONFIG"];
    expect(ClientEnv.hasServer()).toBe(false);
    expect(ClientEnv.numWorkers).toBeDefined();
    expect(() => ClientEnv.numWorkers()).toThrow();
  });
});
