/** 每个 PDF 的覆盖按原页计数，与重排后的输出页数独立。 */
export type PDFFileGenerationResult = {
  file_path: string;
  written: boolean; // 整份省略时正常完成且没有输出文件。
  translated_pages: number;
  original_pages: number; // 实际输出的原稿页，包含待处理与确认保留页
  omitted_pages: number;
};

/** 本次生成的输出文件；路径位于当前工程输出目录内，只用于受控下载定位。 */
export type TranslationGeneratedFile = {
  name: string;
  path: string;
  size: number;
};

export type TranslationFileGenerationResult = {
  accepted: true;
  output_path: string;
  bilingual_output_path?: string;
  pdf_files: PDFFileGenerationResult[];
  files?: TranslationGeneratedFile[]; // 只有 GUI 生成入口返回本次输出清单，CLI 目录入口不改变响应
};
