import { agent_tool_call } from "../../../test/agent-tool-fixture";
import { describe, expect, it, vi } from "vitest";
import { workspace_execution } from "../../../test/agent-workspace-fixture";
import { create_agent_workspace_run_tool } from "./workspace-run";
import { AgentToolError } from "../tool-definition";
import type { AgentWorkspaceHostCapabilities, AgentWorkspacePort } from "../workspace/service";

const FULL_CAPABILITIES: AgentWorkspaceHostCapabilities = Object.freeze({
  imageOutput: true,
  pdf: true,
});

describe("workspace_run", () => {
  it("工作区图片作为 SDK image content 返回，摘要不包含图片字节", async () => {
    const run = vi.fn(async () => ({
      execution: workspace_execution(),
      images: [
        {
          path: "work/image.webp",
          image: {
            mimeType: "image/webp" as const,
            data: "aW1hZ2U=",
            width: 100,
            height: 50,
            originalWidth: 100,
            originalHeight: 50,
          },
        },
      ],
    }));
    const tool = create_tool(run);
    const result = await tool.execute(
      { script: "await ws.emitImage('work/image.webp');" },
      ...agent_tool_call("image"),
    );
    expect(result.output).toContainEqual({
      type: "image",
      mimeType: "image/webp",
      data: "aW1hZ2U=",
    });
    expect(result.details).toMatchObject({
      images: [
        {
          path: "work/image.webp",
          mime_type: "image/webp",
          width: 100,
          height: 50,
          original_width: 100,
          original_height: 50,
        },
      ],
    });
    expect(JSON.stringify(result.details)).not.toContain("aW1hZ2U=");
  });
  it("调用期间停止仍保留实际成功的执行结果", async () => {
    const released = Promise.withResolvers<void>();
    const run = vi.fn(async () => {
      await released.promise;
      return { images: [], execution: workspace_execution() };
    });
    const script_tool = create_tool(run);
    const controller = new AbortController();
    const reason = new Error("停止任务");

    const result = script_tool.execute(
      { script: "console.log(null);" },
      ...agent_tool_call("script", controller.signal),
    );
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    controller.abort(reason);
    released.resolve();

    await expect(result).resolves.toMatchObject({ details: workspace_execution() });
  });
  it("脚本和刷新同时失败保留主回执与两个原始原因", async () => {
    const script_error = new AgentToolError({ code: "script_failed", scriptPath: "work/run.mjs" });
    const refresh_error = new Error("刷新失败");
    const tool = create_agent_workspace_run_tool({
      run: async () => {
        throw script_error;
      },
      refresh_skills: async () => {
        throw refresh_error;
      },
      capabilities: FULL_CAPABILITIES,
    });
    await expect(
      tool.execute({ script: "throw 1;" }, ...agent_tool_call("failed")),
    ).rejects.toMatchObject({ cause: script_error, errors: [script_error, refresh_error] });
  });
  it("宿主能力齐备时说明声明图片输出与 PDF 打印接口", () => {
    const tool = create_tool(vi.fn());
    expect(tool.description).toContain("图片输出可用");
    expect(tool.description).toContain("PDF 打印可用");
    expect(tool.description).toContain("emitImage(path: string");
    expect(tool.description).toContain("host(request:");
  });
  it("宿主能力缺失时说明不声明对应接口并明确不可用", () => {
    const tool = create_agent_workspace_run_tool({
      run: vi.fn(),
      refresh_skills: async () => {},
      capabilities: Object.freeze({ imageOutput: false, pdf: false }),
    });
    expect(tool.description).toContain("图片输出不可用");
    expect(tool.description).toContain("PDF 打印不可用");
    expect(tool.description).not.toContain("emitImage(");
    expect(tool.description).not.toContain("host(request:");
    expect(tool.description).not.toContain("图片输出可用");
  });
});
/** 注入工作区执行端口，刷新结果由会话集成测试验证。 */
function create_tool(run: AgentWorkspacePort["run"]) {
  return create_agent_workspace_run_tool({
    run,
    refresh_skills: async () => {},
    capabilities: FULL_CAPABILITIES,
  });
}
