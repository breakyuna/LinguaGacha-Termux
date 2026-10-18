import path from "node:path";

import { default_native_fs } from "../../native/native-fs";

// Web 运行态静态资源与 API 同源，MIME 表只覆盖构建产物实际出现的类型。
const STATIC_ASSET_MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const IMMUTABLE_ASSET_DIRECTORY = "/assets/"; // Vite 产物按内容哈希命名，可长期缓存

/** 入口文档中的启动配置注入点；构建产物由本服务在响应时替换。 */
export const WEB_BOOTSTRAP_PLACEHOLDER = "<!--linguagacha-web-bootstrap-->";

export interface StaticAssetLookup {
  file_path: string | null; // 归一后仍位于资源根内的目标文件
  is_spa_fallback: boolean; // 深链接回退到入口文档，刷新不 404
}

/**
 * 把请求路径收敛到静态资源根内；越界、绝对化和编码穿越都按不存在处理。
 */
export function resolve_static_asset_lookup(root: string, request_path: string): StaticAssetLookup {
  const normalized_request_path = decode_request_path(request_path);
  const candidate_path = path.resolve(root, `.${normalized_request_path}`);
  const is_inside_resource_root = is_inside_root(root, candidate_path);
  if (is_inside_resource_root && is_readable_file(candidate_path)) {
    return { file_path: candidate_path, is_spa_fallback: false };
  }
  const is_document_request = is_inside_resource_root && path.extname(candidate_path) === "";
  const is_root_request = normalized_request_path === "/" || normalized_request_path === "";
  if (is_document_request || is_root_request) {
    const index_file_path = path.join(root, "index.html");
    if (is_readable_file(index_file_path)) {
      return { file_path: index_file_path, is_spa_fallback: true };
    }
  }
  return { file_path: null, is_spa_fallback: false };
}

/** 读取静态资源响应体；入口文档不缓存，哈希资产长期缓存。 */
export function read_static_asset_response(
  file_path: string,
  request_path: string,
): Response | null {
  let content: Buffer;
  try {
    content = default_native_fs.read_file(file_path);
  } catch {
    return null;
  }
  const extension = path.extname(file_path).toLowerCase();
  const headers = new Headers({
    "Content-Type": STATIC_ASSET_MIME_TYPES[extension] ?? "application/octet-stream",
    "Cache-Control": request_path.startsWith(IMMUTABLE_ASSET_DIRECTORY)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(new Uint8Array(content), { headers, status: 200 });
}

/**
 * 读取入口文档并把启动配置内联到占位符；缺占位符时原样返回，由前端回退到启动配置接口。
 */
export function read_web_index_response(root: string, bootstrap_script: string): Response | null {
  const index_file_path = path.join(root, "index.html");
  let document_text: string;
  try {
    document_text = default_native_fs.read_file(index_file_path).toString("utf8");
  } catch {
    return null;
  }
  const injected_document = document_text.includes(WEB_BOOTSTRAP_PLACEHOLDER)
    ? document_text.replace(WEB_BOOTSTRAP_PLACEHOLDER, bootstrap_script)
    : document_text;
  return new Response(injected_document, {
    headers: {
      "Content-Type": STATIC_ASSET_MIME_TYPES[".html"] ?? "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
    status: 200,
  });
}

/** 解码失败或含空字节的路径视为非法请求，不进入文件系统解析。 */
function decode_request_path(request_path: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(request_path);
  } catch {
    return "\u0000";
  }
  return decoded.includes("\u0000") ? "\u0000" : decoded;
}

function is_inside_root(root: string, candidate_path: string): boolean {
  const relative_path = path.relative(path.resolve(root), candidate_path);
  return (
    relative_path !== "" &&
    !relative_path.startsWith(`..${path.sep}`) &&
    relative_path !== ".." &&
    !path.isAbsolute(relative_path)
  );
}

function is_readable_file(candidate_path: string): boolean {
  try {
    return default_native_fs.stat(candidate_path).isFile();
  } catch {
    return false;
  }
}
