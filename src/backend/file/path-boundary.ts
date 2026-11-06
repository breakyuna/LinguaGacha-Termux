import path from "node:path";

/**
 * 受控文件边界判断：根自身或其后代都算界内，
 * 父级逃逸、跨盘符与绝对路径跳出都按界外处理。
 */
export function is_path_inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
