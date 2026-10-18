import { cp, mkdir, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { frontend_resolve_alias, project_path, project_root } from "./vite/project-paths.ts";

const output = path.resolve(process.argv[2] ?? path.join(project_root, "build", "web"));
const server_out_dir = output;
const renderer_out_dir = path.join(output, "dist");
const workspace_out_dir = path.join(output, "resources", "workspace");
const print_resources_out_dir = path.join(output, "resources");

// 旧产物整体重建，避免上一次构建的残留文件进入部署目录。
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

// 工作区运行目录与桌面发布同构：Agent 子进程、PDF 线程和文本匹配库共用同一份预装依赖。
execFileSync(
  process.execPath,
  [path.join(project_root, "buildtools", "build-workspace.mjs"), workspace_out_dir],
  {
    stdio: "inherit",
  },
);

// 打印样式与工作区运行目录同级：Chromium 打印宿主只读取应用自带的字体与内嵌数学样式。
execFileSync(
  process.execPath,
  [path.join(project_root, "buildtools", "build-pdf-print.mjs"), print_resources_out_dir],
  {
    stdio: "inherit",
  },
);

await build({
  configFile: false,
  resolve: { conditions: ["node"], mainFields: ["module", "main"] },
  ssr: { noExternal: true }, // 服务依赖随产物打包，显式 external 的原生模块仍由运行环境提供。
  publicDir: false,
  logLevel: "warn",
  build: {
    // Node target 只决定语法；服务端构建才能避免模型动态加载被注入读取 document 的浏览器预加载器。
    ssr: true,
    modulePreload: false,
    target: "node24",
    outDir: server_out_dir,
    emptyOutDir: false,
    minify: false,
    rolldownOptions: {
      platform: "node",
      external: [...builtinModules, /^node:/u, "mupdf"],
      input: {
        index: project_path("src", "web", "web-server-main.ts"),
        "backend-runtime-worker-entry": project_path(
          "src",
          "backend",
          "bootstrap",
          "backend-runtime-worker-entry.ts",
        ),
        "rpgmaker-mv-mz-prepare-worker-entry": project_path(
          "src",
          "backend",
          "file",
          "rpgmaker-mv-mz",
          "prepare-worker-entry.ts",
        ),
        "compute-worker-entry": project_path("src", "backend", "worker", "compute-worker-entry.ts"),
        "planning-worker-entry": project_path(
          "src",
          "backend",
          "batch-translation",
          "planning",
          "planning-worker-entry.ts",
        ),
        "work-unit-worker-entry": project_path(
          "src",
          "backend",
          "batch-translation",
          "work-unit",
          "work-unit-worker-entry.ts",
        ),
      },
      output: {
        entryFileNames: "[name].mjs",
        format: "esm",
      },
    },
  },
});

await build({
  configFile: false,
  root: project_path("src", "frontend"),
  publicDir: project_path("public"),
  resolve: { alias: frontend_resolve_alias },
  plugins: [react(), tailwindcss()],
  logLevel: "warn",
  build: {
    target: "chrome144",
    outDir: renderer_out_dir,
    emptyOutDir: true,
    rolldownOptions: {
      input: { index: project_path("src", "frontend", "index.html") },
    },
  },
});

await cp(project_path("builtin"), path.join(output, "builtin"), { recursive: true });
await cp(project_path("version.txt"), path.join(output, "version.txt"));
