import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  WEB_BOOTSTRAP_PLACEHOLDER,
  read_static_asset_response,
  read_web_index_response,
  resolve_static_asset_lookup,
} from "./web-static-assets";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-web-static-"));
const outside_file = path.join(os.tmpdir(), `lg-web-outside-${Date.now()}.txt`);

fs.mkdirSync(path.join(root, "assets"), { recursive: true });
fs.writeFileSync(
  path.join(root, "index.html"),
  `<head></head><body>${WEB_BOOTSTRAP_PLACEHOLDER}</body>`,
);
fs.writeFileSync(path.join(root, "assets", "app.js"), "console.log(1)");
fs.writeFileSync(path.join(root, "icon.png"), "png");
fs.writeFileSync(outside_file, "secret");

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside_file, { force: true });
});

describe("web static assets", () => {
  it("资源根内文件按扩展名返回 MIME 与缓存策略", () => {
    const asset = read_static_asset_response(path.join(root, "assets", "app.js"), "/assets/app.js");

    expect(asset?.status).toBe(200);
    expect(asset?.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(asset?.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("入口文档不缓存，深链接回退到入口文档", () => {
    expect(resolve_static_asset_lookup(root, "/")).toEqual({
      file_path: path.join(root, "index.html"),
      is_spa_fallback: true,
    });
    expect(resolve_static_asset_lookup(root, "/agent/session")).toEqual({
      file_path: path.join(root, "index.html"),
      is_spa_fallback: true,
    });
    expect(
      read_static_asset_response(path.join(root, "index.html"), "/")?.headers.get("Cache-Control"),
    ).toBe("no-cache");
  });

  it("启动配置注入到占位符，缺占位符时保持原文档", () => {
    const injected = read_web_index_response(root, "<script>window.x=1</script>");
    expect(injected?.status).toBe(200);

    const document_text = fs.readFileSync(path.join(root, "index.html"), "utf8");
    expect(document_text.includes(WEB_BOOTSTRAP_PLACEHOLDER)).toBe(true);
  });

  it("越界、绝对路径与编码穿越都不离开资源根", () => {
    expect(resolve_static_asset_lookup(root, "/../lg-web-outside.txt").file_path).toBeNull();
    expect(resolve_static_asset_lookup(root, "/%2e%2e%2fpackage.json").file_path).toBeNull();
    expect(
      resolve_static_asset_lookup(root, "/assets/../../lg-web-outside.txt").file_path,
    ).toBeNull();
    expect(resolve_static_asset_lookup(root, "/assets/./app.js")).toEqual({
      file_path: path.join(root, "assets", "app.js"),
      is_spa_fallback: false,
    });
  });

  it("不存在的带扩展名路径不回退为入口文档", () => {
    expect(resolve_static_asset_lookup(root, "/missing.js")).toEqual({
      file_path: null,
      is_spa_fallback: false,
    });
  });
});
