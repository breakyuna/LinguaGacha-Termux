import path from "node:path";
import { describe, expect, it } from "vitest";

import { is_path_inside } from "./path-boundary";

describe("is_path_inside", () => {
  const root = path.resolve("/data/user/0/files");

  it("根本身和后代都算界内", () => {
    expect(is_path_inside(root, root)).toBe(true);
    expect(is_path_inside(root, path.join(root, "novels", "a.txt"))).toBe(true);
  });

  it("父级逃逸、同级目录和绝对路径跳出都算界外", () => {
    expect(is_path_inside(root, path.resolve(path.join(root, "..")))).toBe(false);
    expect(is_path_inside(root, path.join(root, "..", "secret", "a.txt"))).toBe(false);
    expect(is_path_inside(root, path.dirname(root))).toBe(false);
    expect(is_path_inside(root, path.resolve("/etc/passwd"))).toBe(false);
  });

  it("同名前缀目录不算界内", () => {
    expect(is_path_inside(root, `${root}-other/a.txt`)).toBe(false);
  });
});
