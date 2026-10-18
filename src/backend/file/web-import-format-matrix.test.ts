import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import iconv from "iconv-lite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PROJECT_SOURCE_FORMATS } from "../../shared/project-source-formats";
import { AppPathService } from "../app/app-path-service";
import { write_zip, type ZipContents } from "./epub/epub-zip";
import { FileFormatService } from "./file-format-service";
import { SourceFileParsePipeline } from "./source-file-parse-pipeline";
import { create_pdf_execution, create_pdf_fixture } from "./pdf/test-support";
import { encode as marshal_encode } from "./rpgmaker-rgss/marshal";
import { WebFileService, type WebStagedMaterial } from "./web-file-service";
import { rgss_archive_fixture } from "../../test/rgss-archive-fixture";
import { ruby_array, ruby_integer, ruby_object, ruby_string } from "../../test/rgss-fixture";
import { spreadsheet_fixture } from "../../test/spreadsheet-fixture";

const data_root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-import-matrix-"));
const paths = new AppPathService({
  appRoot: data_root,
  builtinRoot: path.join(data_root, "builtin"),
  dataRoot: path.join(data_root, "data"),
});
const staging_root = paths.get_user_data_path("web-imports");

/** 每个用例使用独立批次目录；暂存材料在服务释放前保持注册，目录不重复。 */
const BATCH_TEXT = "batch-1770000000000-f0rmat";
const BATCH_ENCODING = "batch-1770000000000-enc0de";
const BATCH_MV_MZ = "batch-1770000000000-mvmz0";
const BATCH_RGSS = "batch-1770000000000-rgss0";
const BATCH_EDGE = "batch-1770000000000-edge0";

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

/** 按 `批次目录/相对路径` 暂存一批合成文件，返回相对路径到暂存材料的映射。 */
async function stage_batch(
  batch: string,
  files: readonly (readonly [string, string | Uint8Array])[],
): Promise<Map<string, WebStagedMaterial>> {
  const staged = new Map<string, WebStagedMaterial>();
  for (const [relative_path, content] of files) {
    staged.set(
      relative_path,
      await service.stage_upload(
        `${batch}/${relative_path}`,
        create_upload_body(content),
        new AbortController().signal,
      ),
    );
  }
  return staged;
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
const SRT_FIXTURE = [
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

/** 合成 VTT：文件头 + 注释块 + 两个无标识 cue。 */
const VTT_FIXTURE = [
  "WEBVTT",
  "",
  "NOTE 片头注释",
  "kept",
  "",
  "00:00.000 --> 00:02.000",
  "第一句",
  "",
  "00:02.000 --> 00:04.000",
  "第二句",
  "",
].join("\n");

/** 合成 ASS：显式 Format 行，Text 位于末列。 */
const ASS_FIXTURE = [
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,第一句",
  "Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,第二句",
].join("\n");

/** 合成 SSA：缺少 Format 行时按标准布局识别。 */
const SSA_FIXTURE = [
  "[Events]",
  "Dialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,唯一一句",
].join("\n");

/** 合成 LRC：元数据行保留，时间标签行产生正文条目。 */
const LRC_FIXTURE = ["[ti:标题]", "[00:01.00]第一句", "[00:12.50]第二句"].join("\n");

/** 合成 Markdown：标题、段落与默认排除的代码块。 */
const MARKDOWN_FIXTURE = "# 标题\n\n正文第一行\n正文第二行\n\n```ts\ncode\n```\n";

/** 合成 RenPy：strings 配对与 start 翻译块。 */
const RENPY_FIXTURE = [
  "translate schinese strings:",
  '    old "START"',
  '    new "开始"',
  "translate schinese start:",
  '    # "Alice" "Hello"',
  '    "艾丽丝" "你好"',
].join("\n");

/** 合成 KVJSON：键值对决定默认翻译资格。 */
const KV_JSON_FIXTURE = JSON.stringify({ 已翻: "已处理", 待翻: "待翻" });

/** 合成 MESSAGEJSON：name / names / 纯 message 三种条目形状。 */
const MESSAGE_JSON_FIXTURE = JSON.stringify([
  { name: "Alice", message: "msg1" },
  { names: ["Bob", 123, "Carol"], message: "msg2" },
  { message: "msg3" },
]);

/** 合成 TRANS：携带引擎身份与同位扩展字段。 */
const TRANS_FIXTURE = JSON.stringify({
  project: {
    indexOriginal: 1,
    indexTranslation: 2,
    gameEngine: "kag",
    files: {
      "file.json": {
        data: [["id-1", "原文", "译文"]],
        tags: [["keep"]],
        context: [["ctx"]],
        parameters: [[{ note: "meta" }]],
      },
    },
  },
});

/** 合成 WOLF TRANS：白名单正文与黑名单内部标识分别给出默认资格。 */
const WOLF_TRANS_FIXTURE = JSON.stringify({
  project: {
    gameEngine: "wolf",
    indexOriginal: 0,
    indexTranslation: 1,
    files: {
      "Data/Map001.json": {
        data: [
          ["对话正文", ""],
          ["内部标识", ""],
        ],
        context: [
          ["common/1.json/Message/stringArgs/0"],
          ["common/1.json/Database/stringArgs/1"],
        ],
      },
    },
  },
});

/** MV/MZ 系统文件：无加密标志，准备阶段直接固化原稿。 */
const MV_MZ_SYSTEM_FIXTURE = JSON.stringify({ gameTitle: "原稿" });

/** MV/MZ 地图文件：101 头指令携带姓名，401 续行是对白正文。 */
const MV_MZ_MAP_FIXTURE = JSON.stringify({
  displayName: "地图",
  events: [
    null,
    {
      pages: [
        {
          list: [
            { code: 101, parameters: ["", 0, 0, 2, "勇者"], indent: 0 },
            { code: 401, parameters: ["对白文字"], indent: 0 },
            { code: 0, parameters: [], indent: 0 },
          ],
        },
      ],
    },
  ],
});

/** RGSS 归档成员：System、Actors 与脚本归档各自提供一类条目。 */
function create_rgss_members(): Map<string, Uint8Array> {
  const scripts = ruby_array([
    ruby_array([
      ruby_integer(1),
      ruby_string("Section1"),
      { t: '"', data: deflateSync(Buffer.from('puts "脚本文字"')) },
    ]),
  ]);
  return new Map([
    [
      "Data/System.rvdata2",
      marshal_encode(ruby_object("RPG::System", { "@currency_unit": ruby_string("金币") })),
    ],
    [
      "Data/Actors.rvdata2",
      marshal_encode(
        ruby_array([{ t: "0" }, ruby_object("RPG::Actor", { "@name": ruby_string("勇者") })]),
      ),
    ],
    ["Data/Scripts.rvdata2", marshal_encode(scripts)],
  ]);
}

/** 按文件汇总条目正文，顺序即解析流水线的条目顺序。 */
function collect_item_sources(
  items: readonly { file_path: string; src: string }[],
): Record<string, string[]> {
  const sources = new Map<string, string[]>();
  for (const item of items) {
    const group = sources.get(item.file_path) ?? [];
    group.push(item.src);
    sources.set(item.file_path, group);
  }
  return Object.fromEntries(sources);
}

beforeAll(() => {
  service = new WebFileService({ paths });
});

afterAll(async () => {
  await service.dispose();
  fs.rmSync(data_root, { recursive: true, force: true });
});

describe("Web 暂存导入的全格式矩阵", () => {
  it("文本、字幕、EPUB、Markdown、JSON、表格、TRANS、RenPy 与 PDF 经批次暂存进入解析流水线", async () => {
    const glossary = await spreadsheet_fixture({
      A1: "src",
      B1: "dst",
      A2: "原文",
      B2: "译文",
      A3: "待翻",
    });
    const wolf = await spreadsheet_fixture({
      A1: "code",
      B1: "flag",
      C1: "type",
      D1: "info",
      F2: { text: "原文1", fill: 9 },
      F3: { rich: ["原", "文2"], fill: 9 },
      G3: { formula: "F3", result: "已译" },
      F4: { text: "排除", fill: 44 },
      F5: "无填充",
    });
    const staged = await stage_batch(BATCH_TEXT, [
      ["book.epub", await create_minimal_epub("第一章正文")],
      ["data/kv.json", KV_JSON_FIXTURE],
      ["data/messages.json", MESSAGE_JSON_FIXTURE],
      ["docs/manual.pdf", create_pdf_fixture()],
      ["docs/readme.md", MARKDOWN_FIXTURE],
      ["lyrics/song.lrc", LRC_FIXTURE],
      ["novels/story.txt", "第一行\r\n第二行\n第三行"],
      ["patches/demo.trans", TRANS_FIXTURE],
      ["patches/wolf.trans", WOLF_TRANS_FIXTURE],
      ["scripts/game.rpy", RENPY_FIXTURE],
      ["subs/ep01.srt", SRT_FIXTURE],
      ["subs/ep02.vtt", VTT_FIXTURE],
      ["subs/ep03.ass", ASS_FIXTURE],
      ["subs/ep04.ssa", SSA_FIXTURE],
      ["tables/glossary.xlsx", glossary],
      ["tables/wolf.xlsx", wolf],
    ]);
    const batch_path = path.join(staging_root, BATCH_TEXT);
    const format_service = create_format_service();

    // 目录递归发现按暂存相对结构给出资产路径与格式身份。
    expect(
      Object.fromEntries(
        (await format_service.collect_source_file_entries([batch_path])).map((entry) => [
          entry.rel_path,
          entry.source.kind === "file" ? entry.source.format : null,
        ]),
      ),
    ).toEqual({
      [`${BATCH_TEXT}/book.epub`]: "epub",
      [`${BATCH_TEXT}/data/kv.json`]: "json",
      [`${BATCH_TEXT}/data/messages.json`]: "json",
      [`${BATCH_TEXT}/docs/manual.pdf`]: "pdf",
      [`${BATCH_TEXT}/docs/readme.md`]: "md",
      [`${BATCH_TEXT}/lyrics/song.lrc`]: "lrc",
      [`${BATCH_TEXT}/novels/story.txt`]: "txt",
      [`${BATCH_TEXT}/patches/demo.trans`]: "trans",
      [`${BATCH_TEXT}/patches/wolf.trans`]: "trans",
      [`${BATCH_TEXT}/scripts/game.rpy`]: "rpy",
      [`${BATCH_TEXT}/subs/ep01.srt`]: "srt",
      [`${BATCH_TEXT}/subs/ep02.vtt`]: "vtt",
      [`${BATCH_TEXT}/subs/ep03.ass`]: "ass",
      [`${BATCH_TEXT}/subs/ep04.ssa`]: "ssa",
      [`${BATCH_TEXT}/tables/glossary.xlsx`]: "xlsx",
      [`${BATCH_TEXT}/tables/wolf.xlsx`]: "xlsx",
    });

    // 摘要覆盖格式注册表的全部文件型身份，未命中项保持为零。
    const expected_hit_counts = Object.fromEntries(
      PROJECT_SOURCE_FORMATS.map((format) => [format.id, 0]),
    );
    Object.assign(expected_hit_counts, {
      txt: 1,
      md: 1,
      ass: 1,
      ssa: 1,
      lrc: 1,
      srt: 1,
      vtt: 1,
      pdf: 1,
      epub: 1,
      rpy: 1,
      json: 2,
      xlsx: 2,
      trans: 2,
    });
    const summary = await format_service.summarize_source_files([batch_path]);
    expect(summary.source_file_count).toBe(16);
    expect(summary.format_hit_counts).toEqual(expected_hit_counts);

    const draft = await new SourceFileParsePipeline(format_service).build_project_draft([
      batch_path,
    ]);

    expect(draft.failed_files).toEqual([]);
    expect(draft.warnings).toEqual([]);
    expect(Object.fromEntries(draft.files.map((file) => [file.rel_path, file.file_type]))).toEqual({
      [`${BATCH_TEXT}/book.epub`]: "EPUB",
      [`${BATCH_TEXT}/data/kv.json`]: "KVJSON",
      [`${BATCH_TEXT}/data/messages.json`]: "MESSAGEJSON",
      [`${BATCH_TEXT}/docs/manual.pdf`]: "PDF",
      [`${BATCH_TEXT}/docs/readme.md`]: "MD_V2",
      [`${BATCH_TEXT}/lyrics/song.lrc`]: "LRC",
      [`${BATCH_TEXT}/novels/story.txt`]: "TXT",
      [`${BATCH_TEXT}/patches/demo.trans`]: "TRANS",
      [`${BATCH_TEXT}/patches/wolf.trans`]: "TRANS",
      [`${BATCH_TEXT}/scripts/game.rpy`]: "RENPY",
      [`${BATCH_TEXT}/subs/ep01.srt`]: "SRT",
      [`${BATCH_TEXT}/subs/ep02.vtt`]: "VTT",
      [`${BATCH_TEXT}/subs/ep03.ass`]: "ASS",
      [`${BATCH_TEXT}/subs/ep04.ssa`]: "ASS",
      [`${BATCH_TEXT}/tables/glossary.xlsx`]: "XLSX",
      [`${BATCH_TEXT}/tables/wolf.xlsx`]: "WOLFXLSX",
    });

    // 条目数量与关键条目内容符合合成输入的预期。
    expect(collect_item_sources(draft.items)).toEqual({
      [`${BATCH_TEXT}/book.epub`]: ["第一章正文"],
      [`${BATCH_TEXT}/data/kv.json`]: ["已翻", "待翻"],
      [`${BATCH_TEXT}/data/messages.json`]: ["msg1", "msg2", "msg3"],
      [`${BATCH_TEXT}/docs/readme.md`]: ["# 标题", "正文第一行\n正文第二行", "```ts\ncode\n```"],
      [`${BATCH_TEXT}/lyrics/song.lrc`]: ["第一句", "第二句"],
      [`${BATCH_TEXT}/novels/story.txt`]: ["第一行", "第二行", "第三行"],
      [`${BATCH_TEXT}/patches/demo.trans`]: ["原文"],
      [`${BATCH_TEXT}/patches/wolf.trans`]: ["对话正文", "内部标识"],
      [`${BATCH_TEXT}/scripts/game.rpy`]: ["START", "Hello"],
      [`${BATCH_TEXT}/subs/ep01.srt`]: ["第一句台词", "第二句台词\n第二句的第二行"],
      [`${BATCH_TEXT}/subs/ep02.vtt`]: ["第一句", "第二句"],
      [`${BATCH_TEXT}/subs/ep03.ass`]: ["第一句", "第二句"],
      [`${BATCH_TEXT}/subs/ep04.ssa`]: ["唯一一句"],
      [`${BATCH_TEXT}/tables/glossary.xlsx`]: ["src", "原文", "待翻"],
      [`${BATCH_TEXT}/tables/wolf.xlsx`]: ["原文1", "原文2", "排除", "无填充"],
    });
    const find_item = (rel_path: string, src: string) =>
      draft.items.find((item) => item.file_path === rel_path && item.src === src)!;
    expect(find_item(`${BATCH_TEXT}/data/kv.json`, "已翻")).toMatchObject({
      dst: "已处理",
      status: "PROCESSED",
    });
    expect(find_item(`${BATCH_TEXT}/data/kv.json`, "待翻")).toMatchObject({ status: "NONE" });
    expect(find_item(`${BATCH_TEXT}/docs/readme.md`, "```ts\ncode\n```")).toMatchObject({
      status: "RULE_SKIPPED",
    });
    expect(find_item(`${BATCH_TEXT}/scripts/game.rpy`, "START")).toMatchObject({
      dst: "开始",
      status: "PROCESSED",
    });
    expect(find_item(`${BATCH_TEXT}/subs/ep01.srt`, "第一句台词")?.extra_field).toBe(
      "00:00:01,000 --> 00:00:03,500",
    );
    expect(find_item(`${BATCH_TEXT}/tables/glossary.xlsx`, "待翻")).toMatchObject({
      row: 3,
      status: "NONE",
    });
    expect(find_item(`${BATCH_TEXT}/tables/wolf.xlsx`, "原文2")).toMatchObject({
      dst: "已译",
      status: "PROCESSED",
      file_type: "WOLFXLSX",
    });
    expect(find_item(`${BATCH_TEXT}/tables/wolf.xlsx`, "排除")).toMatchObject({
      status: "RULE_SKIPPED",
    });
    // WOLF TRANS 的地址白名单与黑名单决定默认翻译资格。
    expect(find_item(`${BATCH_TEXT}/patches/wolf.trans`, "对话正文")).toMatchObject({
      status: "NONE",
    });
    expect(find_item(`${BATCH_TEXT}/patches/wolf.trans`, "内部标识")).toMatchObject({
      status: "RULE_SKIPPED",
    });

    // PDF 走独立文档，不产生文本条目。
    const pdf_file = draft.files.find((file) => file.rel_path === `${BATCH_TEXT}/docs/manual.pdf`)!;
    expect(pdf_file.file_type).toBe("PDF");
    expect(pdf_file.pdf_document).not.toBeNull();
    expect(draft.items.some((item) => item.file_path === pdf_file.rel_path)).toBe(false);

    // 暂存内容与磁盘一致，上传相对结构进入工程资产路径。
    const staged_wolf = staged.get("tables/wolf.xlsx")!;
    expect(staged_wolf.path).toBe(path.join(batch_path, "tables", "wolf.xlsx"));
    expect(staged_wolf.name).toBe(`${BATCH_TEXT}/tables/wolf.xlsx`);
    expect(fs.readFileSync(staged_wolf.path)).toEqual(wolf);
    expect(path.dirname(staged.get("book.epub")!.path)).toBe(batch_path);
  });

  it("非 UTF-8 编码的 TXT 按编码探测解码，UTF-8 走严格解码", async () => {
    // chardet 需要足够长的样本才能稳定判别 CJK 编码，短样本不进入断言。
    const simplified =
      "村庄的清晨弥漫着薄雾，旅人推开木门，看见井边站着一位少女。\n她说：往前走三里，有一座石桥，桥下流水潺潺。";
    const japanese =
      "朝の村には霧が立ちこめ、旅人が木戸を開けると、井戸端に娘が立っていた。\n「三里先に石橋があります。橋の下を水が流れています」と彼女は言った。";
    await stage_batch(BATCH_ENCODING, [
      ["novels/gbk.txt", iconv.encode(simplified, "gbk")],
      ["novels/shift_jis.txt", iconv.encode(japanese, "shift_jis")],
      ["novels/utf8.txt", "明文正文\n第二行"],
    ]);

    const draft = await new SourceFileParsePipeline(create_format_service()).build_project_draft([
      path.join(staging_root, BATCH_ENCODING),
    ]);

    expect(draft.failed_files).toEqual([]);
    const sources_of = (rel_path: string) =>
      draft.items.filter((item) => item.file_path === rel_path).map((item) => item.src);
    expect(sources_of(`${BATCH_ENCODING}/novels/gbk.txt`)).toEqual(simplified.split("\n"));
    expect(sources_of(`${BATCH_ENCODING}/novels/shift_jis.txt`)).toEqual(japanese.split("\n"));
    expect(sources_of(`${BATCH_ENCODING}/novels/utf8.txt`)).toEqual(["明文正文", "第二行"]);
  });

  it("MV/MZ 游戏目录经批次暂存保留相对结构并完成导入导出闭环", async () => {
    const staged = await stage_batch(BATCH_MV_MZ, [
      ["game/www/data/System.json", MV_MZ_SYSTEM_FIXTURE],
      ["game/www/data/Map001.json", MV_MZ_MAP_FIXTURE],
      ["game/www/js/rmmz_core.js", "// engine marker"],
    ]);
    const batch_path = path.join(staging_root, BATCH_MV_MZ);
    const format_service = create_format_service();

    // 目录型来源收拢为单个游戏容器，暂存相对结构保持原样。
    const entries = await format_service.collect_source_file_entries([batch_path]);
    expect(entries.map((entry) => [entry.rel_path, entry.file_type])).toEqual([
      ["game.zip", "RPGMAKER_MV_MZ"],
    ]);
    expect(entries[0]?.source.kind).toBe("mv_mz");
    const summary = await format_service.summarize_source_files([batch_path]);
    expect(summary.source_file_count).toBe(1);
    expect(summary.format_hit_counts.rpgmaker_mv_mz).toBe(1);
    const staged_map = staged.get("game/www/data/Map001.json")!;
    expect(staged_map.path).toBe(path.join(batch_path, "game", "www", "data", "Map001.json"));
    expect(staged_map.name).toBe(`${BATCH_MV_MZ}/game/www/data/Map001.json`);

    const draft = await new SourceFileParsePipeline(format_service).build_project_draft([
      batch_path,
    ]);

    expect(draft.failed_files).toEqual([]);
    expect(draft.warnings).toEqual([]);
    expect(draft.files.map((file) => [file.rel_path, file.file_type])).toEqual([
      ["game.zip", "RPGMAKER_MV_MZ"],
    ]);
    expect(draft.items.map((item) => [item.file_path, item.src, item.status])).toEqual([
      ["game.zip", "地图", "NONE"],
      ["game.zip", "对白文字", "NONE"],
      ["game.zip", "原稿", "NONE"],
    ]);
    const dialogue = draft.items.find((item) => item.src === "对白文字")!;
    expect(dialogue.name_src).toBe("勇者");

    // 准备阶段在暂存游戏目录内建立原稿备份，批次目录不被清空。
    expect(
      fs.readFileSync(path.join(batch_path, "game", "backup_lg", "www", "data", "System.json"), "utf8"),
    ).toBe(MV_MZ_SYSTEM_FIXTURE);

    // 导入后按容器结构导出译文，游戏目录相对结构进入输出目录。
    for (const item of draft.items)
      Object.assign(item, { status: "PROCESSED", dst: `${item.src}译` });
    const output = path.join(data_root, "exports", BATCH_MV_MZ);
    await format_service.write_items(draft.items, {
      paths: { translated_path: output, bilingual_path: path.join(output, "bilingual") },
      source_files: draft.files.map((file) => ({
        path: file.rel_path,
        file_type: file.file_type,
      })),
      asset_reader: (file) =>
        Buffer.from(draft.files.find((entry) => entry.rel_path === file)!.content),
    });
    const written_map = JSON.parse(
      fs.readFileSync(path.join(output, "game", "www", "data", "Map001.json"), "utf8"),
    );
    expect(written_map.displayName).toBe("地图译");
    expect(written_map.events[1].pages[0].list[1].parameters[0]).toBe("对白文字译");
    expect(
      JSON.parse(fs.readFileSync(path.join(output, "game", "www", "data", "System.json"), "utf8")),
    ).toEqual({ gameTitle: "原稿译" });
  });

  it("RGSS 归档游戏经批次暂存解包后提取 Marshal 数据条目", async () => {
    const members = create_rgss_members();
    const staged = await stage_batch(BATCH_RGSS, [
      ["rgss/Game.ini", "[Game]\nScripts=Data/Scripts.rvdata2"],
      ["rgss/Data/Actors.rvdata2", "old actors"],
      ["rgss/Game.rgss3a", rgss_archive_fixture(3, members)],
    ]);
    const batch_path = path.join(staging_root, BATCH_RGSS);
    const format_service = create_format_service();

    // 归档入口按 RGSS 身份收拢，暂存目录结构保持原样。
    const entries = await format_service.collect_source_file_entries([batch_path]);
    expect(entries.map((entry) => [entry.rel_path, entry.file_type])).toEqual([
      ["rgss.zip", "RPGMAKER_RGSS"],
    ]);
    expect(entries[0]?.source.kind).toBe("rgss");
    expect(staged.get("rgss/Game.ini")?.path).toBe(path.join(batch_path, "rgss", "Game.ini"));

    const draft = await new SourceFileParsePipeline(format_service).build_project_draft([
      batch_path,
    ]);

    expect(draft.failed_files).toEqual([]);
    expect(draft.warnings).toEqual([]);
    expect(draft.files.map((file) => [file.rel_path, file.file_type])).toEqual([
      ["rgss.zip", "RPGMAKER_RGSS"],
    ]);
    // 解包后的数据库字段、脚本字符串与系统词典分别给出默认资格。
    expect(draft.items.map((item) => [item.file_path, item.src, item.status])).toEqual([
      ["rgss.zip", "勇者", "NONE"],
      ["rgss.zip", "脚本文字", "RULE_SKIPPED"],
      ["rgss.zip", "金币", "NONE"],
    ]);

    // 归档解包覆盖暂存目录内的旧数据，原稿备份覆盖本次固化的全部成员。
    expect(fs.existsSync(path.join(batch_path, "rgss", "Game.rgss3a"))).toBe(false);
    expect(fs.readFileSync(path.join(batch_path, "rgss", "Data", "System.rvdata2"))).toEqual(
      members.get("Data/System.rvdata2")!,
    );
    for (const name of [
      "Game.ini",
      "Data/Actors.rvdata2",
      "Data/Scripts.rvdata2",
      "Data/System.rvdata2",
    ])
      expect(fs.existsSync(path.join(batch_path, "rgss", "backup_lg", name))).toBe(true);
  });

  it("零条目资产保留文件身份，空文件与损坏文件给出可观察失败", async () => {
    await stage_batch(BATCH_EDGE, [
      ["ok/story.txt", "正文"],
      ["zero/empty.txt", ""],
      ["zero/structure-only.vtt", "WEBVTT\n\nNOTE structure\n"],
      ["zero/no-dialogue.ssa", "[Events]\n"],
      ["zero/empty-object.json", "{}"],
      ["zero/empty-array.json", "[]"],
      ["broken/broken.json", "{"],
      ["broken/empty.json", ""],
      ["broken/broken.epub", "这不是 zip 文件"],
      ["broken/empty.epub", ""],
    ]);

    const draft = await new SourceFileParsePipeline(create_format_service()).build_project_draft([
      path.join(staging_root, BATCH_EDGE),
    ]);

    // 零条目资产是合法来源，保留文件身份但不产生条目。
    expect(Object.fromEntries(draft.files.map((file) => [file.rel_path, file.file_type]))).toEqual({
      [`${BATCH_EDGE}/ok/story.txt`]: "TXT",
      [`${BATCH_EDGE}/zero/empty.txt`]: "TXT",
      [`${BATCH_EDGE}/zero/structure-only.vtt`]: "VTT",
      [`${BATCH_EDGE}/zero/no-dialogue.ssa`]: "ASS",
      [`${BATCH_EDGE}/zero/empty-object.json`]: "KVJSON",
      [`${BATCH_EDGE}/zero/empty-array.json`]: "MESSAGEJSON",
    });
    expect(draft.items.map((item) => [item.file_path, item.src])).toEqual([
      [`${BATCH_EDGE}/ok/story.txt`, "正文"],
    ]);

    // 空文件与损坏文件按来源逐条报告，同批成功文件不受影响。
    expect(draft.failed_files.map((file) => [file.rel_path, file.filename, file.code])).toEqual([
      [`${BATCH_EDGE}/broken/broken.epub`, "broken.epub", "file.io_failed"],
      [`${BATCH_EDGE}/broken/broken.json`, "broken.json", "file.parse_failed"],
      [`${BATCH_EDGE}/broken/empty.epub`, "empty.epub", "file.io_failed"],
      [`${BATCH_EDGE}/broken/empty.json`, "empty.json", "file.parse_failed"],
    ]);
    for (const failure of draft.failed_files) expect(failure.message).not.toBe("");
  });
});
