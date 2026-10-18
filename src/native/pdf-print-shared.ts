import path from "node:path";

import { default_native_fs } from "./native-fs";

/** 打印声明复用界面字体文件，字重与等宽字体缩放决定 PDF 排版。 */
export const PDF_PRINT_FONTS = [
  ["LGBaseFont", "LGBaseFont-Regular.woff2", "400", ""],
  ["LGBaseFont", "LGBaseFont-Bold.woff2", "500 700", ""],
  ["LGMono", "MonaspaceNeon.woff2", "400 700", "size-adjust:90%;"],
] as const;

/** 打印页面不执行脚本、不请求外部资源，图片与字体只接受内嵌数据。 */
export const PDF_PRINT_CSP =
  "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** 宿主注入共享样式，调用方只提供文档 HTML。 */
export function build_pdf_print_html(html: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PDF_PRINT_CSP}">${html}`;
}

/**
 * 只读取应用自带的固定字体与数学样式，内嵌为数据 URL。
 * 发行包与 UI 共用同一份文件，宿主生命周期内只需生成一次。
 */
export function build_pdf_print_styles(resources: {
  stylesPath: string;
  fontsDirectory: string;
}): string {
  return (
    PDF_PRINT_FONTS.map(([family, file, weight, extra]) => {
      const bytes = default_native_fs.read_file(path.join(resources.fontsDirectory, file));
      return `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2");font-weight:${weight};font-style:normal;${extra}}`;
    }).join("\n") +
    "\n" +
    default_native_fs.read_text_file(resources.stylesPath)
  );
}

/** 注入共享样式的页面脚本，宿主不信任调用方 HTML 携带任何样式来源。 */
export const PDF_PRINT_STYLES_SCRIPT = (styles: string): string =>
  `(() => { const style = document.createElement('style'); style.textContent = ${JSON.stringify(styles)}; document.head.prepend(style); })()`;

/**
 * 按已加载字体测量图注及紧邻标题，整组预留空间。
 * 长图注允许在前三行之后自然分页，避免图片被挤压成窄条。
 */
export const PDF_PRINT_FIGURE_LAYOUT_SCRIPT = `(() => {
  for (const figure of document.querySelectorAll('.pdf-document figure')) {
    const img = figure.querySelector('img');
    if (!img) continue;
    const caption = figure.querySelector('figcaption');
    const imageStyle = getComputedStyle(img);
    const figureStyle = getComputedStyle(figure);
    const height = parseFloat(imageStyle.maxHeight);
    if (!Number.isFinite(height)) continue;
    const captionStyle = caption && getComputedStyle(caption);
    const captionHeight = caption ? Math.min(caption.getBoundingClientRect().height, parseFloat(captionStyle.lineHeight) * 3) + parseFloat(captionStyle.marginTop) : 0;
    let headingHeight = 0;
    for (let heading = figure.previousElementSibling; heading?.matches('h1,h2,h3,h4,h5,h6'); heading = heading.previousElementSibling) {
      const style = getComputedStyle(heading);
      headingHeight += heading.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
    }
    img.style.maxHeight = Math.max(1, height - headingHeight - captionHeight - parseFloat(figureStyle.marginTop) - parseFloat(figureStyle.marginBottom)) + 'px';
  }
})()`;

/** 图片内嵌的 HTML 可能很大，通过脚本参数传递以避开导航 URL 长度限制。 */
export const PDF_PRINT_DOCUMENT_SCRIPT = (html: string): string =>
  `document.open();document.write(${JSON.stringify(html)});document.close();`;

/** 等字体与图片就绪后再测量与打印，避免排版按未加载字体计算。 */
export const PDF_PRINT_ASSETS_READY_SCRIPT =
  "Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.decode())]).then(() => undefined)";
