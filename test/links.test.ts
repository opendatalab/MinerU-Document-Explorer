import { describe, it, expect } from "vitest";
import { parseLinks } from "../src/links.js";

describe("parseLinks", () => {
  it("returns empty array for empty content", () => {
    expect(parseLinks("")).toEqual([]);
    expect(parseLinks("   \n\n   ")).toEqual([]);
  });

  it("parses simple wikilink [[target]]", () => {
    const links = parseLinks("See [[authentication]] for details");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      target: "authentication",
      link_type: "wikilink",
      anchor: undefined,
      line: 1,
    });
  });

  it("parses wikilink with display text [[target|Display Text]]", () => {
    const links = parseLinks("See [[auth-flow|Authentication Flow]] here");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      target: "auth-flow",
      link_type: "wikilink",
      anchor: "Authentication Flow",
      line: 1,
    });
  });

  it("strips heading anchors from wikilinks [[target#heading]]", () => {
    const links = parseLinks("See [[concepts#overview]]");
    expect(links).toHaveLength(1);
    expect(links[0]!.target).toBe("concepts");
    expect(links[0]!.link_type).toBe("wikilink");
  });

  it("parses markdown relative link [text](path.md)", () => {
    const links = parseLinks("Read [the guide](docs/guide.md) first");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      target: "docs/guide.md",
      link_type: "markdown",
      anchor: "the guide",
      line: 1,
    });
  });

  it("classifies http URLs as url type", () => {
    const links = parseLinks("[Example](http://example.com)");
    expect(links[0]).toMatchObject({ link_type: "url", target: "http://example.com" });
  });

  it("classifies https URLs as url type", () => {
    const links = parseLinks("[Docs](https://docs.example.com/guide)");
    expect(links[0]).toMatchObject({ link_type: "url" });
  });

  it("does NOT parse image links ![alt](img.png)", () => {
    const links = parseLinks("Here is an image: ![screenshot](img/screen.png)");
    expect(links).toHaveLength(0);
  });

  it("records correct 1-indexed line numbers", () => {
    const content = `# Title

Some text here.
See [[concepts]] for more.
Also check [[api-reference|API Reference]].`;
    const links = parseLinks(content);
    expect(links).toHaveLength(2);
    expect(links[0]!.line).toBe(4);
    expect(links[1]!.line).toBe(5);
  });

  it("captures multiple links on one line", () => {
    const links = parseLinks("See [[auth]] and [[database]] and [guide](guide.md)");
    expect(links).toHaveLength(3);
    expect(links.every(l => l.line === 1)).toBe(true);
  });

  it("parses wikilinks across multiple lines", () => {
    const content = "Line 1\n[[link-a]]\nLine 3\n[[link-b]]";
    const links = parseLinks(content);
    expect(links[0]!.line).toBe(2);
    expect(links[1]!.line).toBe(4);
  });

  it("does not parse empty wikilinks [[]]", () => {
    const links = parseLinks("See [[]] here");
    expect(links).toHaveLength(0);
  });

  // Links inside code fences are now correctly filtered (TODO was fixed)
  it("skips links inside fenced code blocks", () => {
    const content = "```\nSee [[inside-code]] and [text](path.md)\n```";
    const links = parseLinks(content);
    expect(links).toHaveLength(0);
  });

  // Links outside code fences are still parsed
  it("finds links outside fenced code blocks", () => {
    const content = "See [[outside-code]] and:\n```\n[[inside-code]]\n```\nAlso [[another]]";
    const links = parseLinks(content);
    expect(links).toHaveLength(2);
    expect(links[0]!.target).toBe("outside-code");
    expect(links[1]!.target).toBe("another");
  });
});
