import { describe_emit_image } from "../../tools/emit-image";
import { describe_doing } from "../../tools/doing";
import { describe_host } from "../../tools/host";
import { describe_workspace_contract } from "../../tools/contract";
import { describe_user_skill_directory } from "../../tools/user-skill-directory";
import type { AgentWorkspaceHostCapabilities } from "../service";

/**
 * 使用 TypeScript 声明紧凑描述参数、联合类型与返回结构，减少模型能力说明的 token 开销。
 * 工作区脚本执行 JavaScript；声明用于能力说明，实际数据校验由运行时 Schema 负责。
 * 宿主能力按真实注入结果投影：能力缺失时不声明对应成员，模型不会看到必然失败的接口。
 */
export function format_agent_workspace_typescript_api(
  capabilities: AgentWorkspaceHostCapabilities,
): string {
  const contract = describe_workspace_contract();
  const members = [
    contract.member,
    describe_user_skill_directory(),
    ...(capabilities.imageOutput ? [describe_emit_image()] : []),
    describe_doing(),
    ...(capabilities.pdf ? [describe_host()] : []),
  ];
  return [
    contract.types,
    "",
    "declare const ws: Readonly<{",
    ...members.map((member) =>
      member
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    ),
    "}>;",
  ].join("\n");
}
