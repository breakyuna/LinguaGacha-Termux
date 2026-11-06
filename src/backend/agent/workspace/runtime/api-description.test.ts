import { describe, expect, it } from "vitest";

import { check_typescript } from "../../../../test/typescript-fixture";
import { format_agent_workspace_typescript_api } from "./api-description";

const FULL_CAPABILITIES = Object.freeze({ imageOutput: true, pdf: true });
const NO_HOST_CAPABILITIES = Object.freeze({ imageOutput: false, pdf: false });

describe("Agent Workspace 工具说明投影", () => {
  it("生成声明可用于读取契约和调用宿主，缺少必填参数时报错", () => {
    check_typescript([
      `${format_agent_workspace_typescript_api(FULL_CAPABILITIES)}
ws.host({ kind: "print_pdf", html: "<p>preview</p>" }).then(result => result.path);
ws.emitImage("work/page.png");
const doing: Promise<void> = ws.doing("检查章节");
ws.doing(null);
// @ts-expect-error 阶段只接受文本或 null。
ws.doing(1);
// @ts-expect-error 清空必须显式传入 null。
ws.doing();
ws.emitImage("work/detail.png", { maxEdge: 3840 });
// @ts-expect-error 尺寸使用数字。
ws.emitImage("work/detail.png", { maxEdge: "3840" });
const reference: string = ws.contract.datasets.items.reference;
const skillDirectory: string = ws.userSkillDirectory;
// @ts-expect-error 宿主打印请求必须包含 html。
ws.host({ kind: "print_pdf" });
`,
    ]);
  });
  it("宿主能力缺失时不声明图片输出与宿主打印成员", () => {
    const declaration = format_agent_workspace_typescript_api(NO_HOST_CAPABILITIES);
    expect(declaration).not.toContain("emitImage(");
    expect(declaration).not.toContain("host(request:");
    // 与宿主无关的成员仍然声明，模型可继续使用契约与进度反馈。
    expect(declaration).toContain("contract: WorkspaceContract;");
    expect(declaration).toContain("doing(text:");
    expect(declaration).toContain("userSkillDirectory");
    check_typescript([
      `${declaration}
const reference: string = ws.contract.datasets.items.reference;
// @ts-expect-error 图片宿主未注入时不提供 emitImage。
ws.emitImage("work/page.png");
// @ts-expect-error PDF 宿主未注入时不提供 host。
ws.host({ kind: "print_pdf", html: "<p>preview</p>" });
`,
    ]);
  });
});
