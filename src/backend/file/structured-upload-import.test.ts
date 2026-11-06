import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppPathService } from "../app/app-path-service";
import { write_zip, type ZipContents } from "./epub/epub-zip";
import { FileFormatService } from "./file-format-service";
import { SourceFileParsePipeline } from "./source-file-parse-pipeline";
import { WebFileService } from "./web-file-service";
import { create_pdf_execution } from "./pdf/test-support";
import { resolve_material_import_commands } from "./web-import-materials";

const data_root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-structured-upload-"));
const paths = new AppPathService({
  appRoot: data_root,
  builtinRoot: path.join(data_root, "builtin"),
  dataRoot: path.join(data_root, "data"),
});
const staging_root = paths.get_user_data_path("web-imports");

/** 与前端一致的批次目录名：时间戳加随机后缀，只含安全字符。 */
const BATCH_DIRECTORY = "batch-1770000000000-k3f9a2";

let service: WebFileService;

/** 测试格式服务显式注入配置与同进程 PDF 执行，避免读取本机设置。 */
function create_format_service(): FileFormatService {
  return new FileFormatService(
    {
      target_language: "ZH",
      deduplication_in_bilingual: true,
      write_translated_name_fields_to_file: true,
    },
    create_pdf_execution(),
  );
}

function create_upload_body(content: string | Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(typeof content === "string" ? new TextEncoder().encode(content) : content);
      controller.close();
    },
  });
}

/** 构造最小合法 EPUB：mimetype + container.xml + content.opf + 一章 xhtml。 */
async function create_minimal_epub(chapter_text: string): Promise<Uint8Array> {
  const contents: ZipContents = new Map();
  contents.set("mimetype", "application/epub+zip");
  contents.set(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  contents.set(
    "OPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf">
  <metadata/>
  <manifest>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter"/>
  </spine>
</package>`,
  );
  contents.set(
    "OPS/chapter.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body><p>${chapter_text}</p></body>
</html>`,
  );
  return write_zip(contents);
}

/** 合成 SRT：序号 + 时间轴 + 正文，覆盖多行正文块。 */
function create_srt_fixture(): string {
  return [
    "1",
    "00:00:01,000 --> 00:00:03,500",
    "第一句台词",
    "",
    "2",
    "00:00:04,000 --> 00:00:06,250",
    "第二句台词",
    "第二句的第二行",
    "",
  ].join("\n");
}

beforeAll(() => {
  service = new WebFileService({ paths });
});

afterAll(async () => {
  await service.dispose();
  fs.rmSync(data_root, { recursive: true, force: true });
});

describe("批次目录上传的结构化导入", () => {
  it("文件夹上传的 EPUB 与字幕保留相对结构并完成解析闭环", async () => {
    const book = await service.stage_upload(
      `${BATCH_DIRECTORY}/book.epub`,
      create_upload_body(await create_minimal_epub("第一章正文")),
      new AbortController().signal,
    );
    const subtitle = await service.stage_upload(
      `${BATCH_DIRECTORY}/subs/ep01.srt`,
      create_upload_body(create_srt_fixture()),
      new AbortController().signal,
    );
    const batch_path = path.join(staging_root, BATCH_DIRECTORY);
    const format_service = create_format_service();

    // 目录递归发现按暂存相对结构给出资产路径与格式身份。
    const entries = await format_service.collect_source_file_entries([batch_path]);
    expect(
      entries.map((entry) => [
        entry.rel_path,
        entry.source.kind === "file" ? entry.source.format : null,
      ]),
    ).toEqual([
      [`${BATCH_DIRECTORY}/book.epub`, "epub"],
      [`${BATCH_DIRECTORY}/subs/ep01.srt`, "srt"],
    ]);
    const summary = await format_service.summarize_source_files([batch_path]);
    expect(summary.source_file_count).toBe(2);
    expect(summary.format_hit_counts.epub).toBe(1);
    expect(summary.format_hit_counts.srt).toBe(1);

    const draft = await new SourceFileParsePipeline(format_service).build_project_draft([
      batch_path,
    ]);

    expect(draft.failed_files).toEqual([]);
    expect(draft.files.map((file) => [file.rel_path, file.file_type])).toEqual([
      [`${BATCH_DIRECTORY}/book.epub`, "EPUB"],
      [`${BATCH_DIRECTORY}/subs/ep01.srt`, "SRT"],
    ]);
    expect(draft.items.length).toBeGreaterThan(0);
    expect(draft.items.map((item) => [item.file_path, item.file_type])).toEqual([
      [`${BATCH_DIRECTORY}/book.epub`, "EPUB"],
      [`${BATCH_DIRECTORY}/subs/ep01.srt`, "SRT"],
      [`${BATCH_DIRECTORY}/subs/ep01.srt`, "SRT"],
    ]);
    expect(draft.items.filter((item) => item.file_type === "EPUB").map((item) => item.src)).toEqual(
      ["第一章正文"],
    );
    expect(draft.items.filter((item) => item.file_type === "SRT").map((item) => item.src)).toEqual([
      "第一句台词",
      "第二句台词\n第二句的第二行",
    ]);

    // 暂存内容与磁盘一致，导入预览按材料身份直接消费暂存路径。
    expect(service.read_staged_material(book.material_id).name).toBe(
      `${BATCH_DIRECTORY}/book.epub`,
    );
    expect(service.read_staged_material(subtitle.material_id).name).toBe(
      `${BATCH_DIRECTORY}/subs/ep01.srt`,
    );
    expect(fs.readFileSync(book.path).byteLength).toBeGreaterThan(0);
    expect(path.dirname(book.path)).toBe(batch_path);
  });

  it("导入命令按材料显示名推导目标，批次目录结构进入工程资产路径", async () => {
    const staged = await service.stage_upload(
      `${BATCH_DIRECTORY}/www/data/Map001.json`,
      create_upload_body('{"currencyUnit":"游戏"}'),
      new AbortController().signal,
    );

    const commands = resolve_material_import_commands(service, [
      { material_id: staged.material_id },
    ]);

    expect(commands).toEqual([
      {
        source_path: staged.path,
        target_rel_path: `${BATCH_DIRECTORY}/www/data/Map001.json`,
      },
    ]);
    expect(staged.path).toBe(
      path.join(staging_root, BATCH_DIRECTORY, "www", "data", "Map001.json"),
    );
  });
});
