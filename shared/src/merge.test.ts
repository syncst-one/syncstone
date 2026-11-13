import { describe, expect, it } from "vitest";
import { merge3 } from "./merge";

const lines = (...l: string[]) => l.join("\n");

describe("merge3", () => {
  const base = lines("# Title", "", "one", "two", "three", "four", "five", "");

  it("takes the side that changed when only one did", () => {
    const local = base.replace("two", "TWO");
    expect(merge3(base, local, base)).toBe(local);
    expect(merge3(base, base, local)).toBe(local);
  });

  it("combines edits to different places", () => {
    const local = base.replace("one", "ONE");
    const remote = base.replace("five", "FIVE");
    expect(merge3(base, local, remote)).toBe(lines("# Title", "", "ONE", "two", "three", "four", "FIVE", ""));
  });

  it("combines an insertion and an edit", () => {
    const local = base.replace("two\n", "two\nnew line\n");
    const remote = base.replace("five", "FIVE");
    expect(merge3(base, local, remote)).toBe(lines("# Title", "", "one", "two", "new line", "three", "four", "FIVE", ""));
  });

  it("counts identical edits once", () => {
    const both = base.replace("three", "3");
    expect(merge3(base, both, both)).toBe(both);
  });

  it("combines different edits inside one line (word merge)", () => {
    const b = lines("intro", "I like apples and pears", "outro");
    const local = lines("intro", "I really like apples and pears", "outro");
    const remote = lines("intro", "I like apples and green pears", "outro");
    expect(merge3(b, local, remote)).toBe(lines("intro", "I really like apples and green pears", "outro"));
  });

  it("reports a conflict when the same words were changed differently", () => {
    const b = lines("a", "the colour is red", "z");
    expect(merge3(b, lines("a", "the colour is blue", "z"), lines("a", "the colour is green", "z"))).toBeNull();
  });

  it("reports a conflict for different insertions at the same spot", () => {
    const b = lines("a", "z");
    expect(merge3(b, lines("a", "from local", "z"), lines("a", "from remote", "z"))).toBeNull();
  });

  it("keeps a deletion on one side and an edit elsewhere on the other", () => {
    const local = base.replace("three\n", "");
    const remote = base.replace("five", "FIVE");
    expect(merge3(base, local, remote)).toBe(lines("# Title", "", "one", "two", "four", "FIVE", ""));
  });

  it("combines edits of neighbouring lines (ticked task and the line below)", () => {
    const b = lines("- [ ] one", "- [ ] two", "- [ ] three");
    expect(merge3(b, lines("- [ ] one", "- [x] two", "- [ ] three"), lines("- [ ] one", "- [ ] two", "- [x] three"))).toBe(
      lines("- [ ] one", "- [x] two", "- [x] three"),
    );
  });

  it("accepts the same edit made on both sides next to another edit", () => {
    expect(merge3(lines("a", "b", "c", "d", "e"), lines("a", "B", "c", "d", "e+"), lines("A", "B", "c", "d", "e"))).toBe(lines("A", "B", "c", "d", "e+"));
  });

  it("ignores Windows line endings (CRLF) on one side", () => {
    const b = lines("- [ ] one", "- [ ] two", "", "Notes:");
    const remote = "- [ ] one\r\n- [x] two\r\n\r\nNotes:";
    expect(merge3(b, lines("- [ ] one", "- [ ] two", "", "Notes: more"), remote)).toBe(lines("- [ ] one", "- [x] two", "", "Notes: more"));
  });

  it("handles an empty base (note created on both devices)", () => {
    expect(merge3("", "hello", "world")).toBeNull();
    expect(merge3("", "same", "same")).toBe("same");
  });
});
