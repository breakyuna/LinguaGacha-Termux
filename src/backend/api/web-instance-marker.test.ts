import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NativeFs } from "../../native/native-fs";
import {
  acquire_web_instance_marker,
  release_web_instance_marker,
  WEB_INSTANCE_MARKER_FILE_NAME,
} from "./web-instance-marker";

const FIRST_STARTED_AT = "2026-10-18T09:30:00.000Z";
const SECOND_STARTED_AT = "2026-10-18T10:45:00.000Z";

describe("web-instance-marker", () => {
  const created_data_roots: string[] = [];

  afterEach(() => {
    while (created_data_roots.length > 0) {
      fs.rmSync(created_data_roots.pop()!, { force: true, recursive: true });
    }
  });

  /** 每个用例使用独立临时数据根与门面实例，互不干扰。 */
  function create_data_root(): { dataRoot: string; nativeFs: NativeFs; markerPath: string } {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-instance-marker-"));
    created_data_roots.push(dataRoot);
    return {
      dataRoot,
      nativeFs: new NativeFs(),
      markerPath: path.join(dataRoot, WEB_INSTANCE_MARKER_FILE_NAME),
    };
  }

  function read_marker(markerPath: string): unknown {
    return JSON.parse(fs.readFileSync(markerPath, "utf-8")) as unknown;
  }

  it("首次启动在数据根创建独占标记并记录进程、端口与启动时间", async () => {
    const { dataRoot, nativeFs, markerPath } = create_data_root();

    const result = await acquire_web_instance_marker({
      dataRoot,
      nativeFs,
      port: 38191,
      pid: process.pid,
      started_at: FIRST_STARTED_AT,
    });

    expect(result).toEqual({
      status: "acquired",
      marker: { pid: process.pid, port: 38191, started_at: FIRST_STARTED_AT },
    });
    expect(read_marker(markerPath)).toEqual({
      pid: process.pid,
      port: 38191,
      started_at: FIRST_STARTED_AT,
    });
  });

  it("标记已存在且进程存活时判定为第二实例且不覆盖既有标记", async () => {
    const { dataRoot, nativeFs, markerPath } = create_data_root();
    await acquire_web_instance_marker({
      dataRoot,
      nativeFs,
      port: 38191,
      pid: process.pid,
      started_at: FIRST_STARTED_AT,
    });

    const second = await acquire_web_instance_marker({
      dataRoot,
      nativeFs,
      port: 41234,
      pid: process.pid + 1,
      started_at: SECOND_STARTED_AT,
    });

    expect(second).toEqual({
      status: "conflict",
      existing: { pid: process.pid, port: 38191, started_at: FIRST_STARTED_AT },
    });
    expect(read_marker(markerPath)).toEqual({
      pid: process.pid,
      port: 38191,
      started_at: FIRST_STARTED_AT,
    });
  });

  it("标记进程已停止时按陈旧标记覆盖重建", async () => {
    const { dataRoot, nativeFs, markerPath } = create_data_root();
    const kill_spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    });
    await acquire_web_instance_marker({
      dataRoot,
      nativeFs,
      port: 38191,
      pid: 4242,
      started_at: FIRST_STARTED_AT,
    });

    const restarted = await acquire_web_instance_marker({
      dataRoot,
      nativeFs,
      port: 41234,
      pid: process.pid,
      started_at: SECOND_STARTED_AT,
    });

    expect(restarted).toEqual({
      status: "acquired",
      marker: { pid: process.pid, port: 41234, started_at: SECOND_STARTED_AT },
    });
    expect(read_marker(markerPath)).toEqual({
      pid: process.pid,
      port: 41234,
      started_at: SECOND_STARTED_AT,
    });
    expect(kill_spy).toHaveBeenCalledWith(4242, 0);
  });

  it("标记内容不可解析时按陈旧标记重建", async () => {
    const { dataRoot, nativeFs, markerPath } = create_data_root();
    // 崩溃在写入中途留下的空文件与半行 JSON 都不得挡住后续启动。
    for (const broken_content of ["", '{"pid":']) {
      fs.writeFileSync(markerPath, broken_content, "utf-8");

      const result = await acquire_web_instance_marker({
        dataRoot,
        nativeFs,
        port: 38191,
        pid: process.pid,
        started_at: FIRST_STARTED_AT,
      });

      expect(result.status).toBe("acquired");
      expect(read_marker(markerPath)).toEqual({
        pid: process.pid,
        port: 38191,
        started_at: FIRST_STARTED_AT,
      });
    }
  });

  it("标记记录本进程 PID 时按陈旧标记处理", async () => {
    const { dataRoot, nativeFs, markerPath } = create_data_root();
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ pid: process.pid, port: 38191, started_at: FIRST_STARTED_AT }),
      "utf-8",
    );

    const result = await acquire_web_instance_marker({
      dataRoot,
      nativeFs,
      port: 41234,
      pid: process.pid,
      started_at: SECOND_STARTED_AT,
    });

    expect(result).toEqual({
      status: "acquired",
      marker: { pid: process.pid, port: 41234, started_at: SECOND_STARTED_AT },
    });
    expect(read_marker(markerPath)).toEqual({
      pid: process.pid,
      port: 41234,
      started_at: SECOND_STARTED_AT,
    });
  });

  it("优雅停止删除本实例创建的标记", async () => {
    const { dataRoot, nativeFs, markerPath } = create_data_root();
    await acquire_web_instance_marker({
      dataRoot,
      nativeFs,
      port: 38191,
      pid: process.pid,
      started_at: FIRST_STARTED_AT,
    });

    await release_web_instance_marker({ dataRoot, nativeFs, pid: process.pid });

    expect(fs.existsSync(markerPath)).toBe(false);
    // 重复停止不得因标记缺失而失败。
    await expect(
      release_web_instance_marker({ dataRoot, nativeFs, pid: process.pid }),
    ).resolves.toBeUndefined();
  });

  it("停止时不删除归属已变更给其它实例的标记", async () => {
    const { dataRoot, nativeFs, markerPath } = create_data_root();
    await acquire_web_instance_marker({
      dataRoot,
      nativeFs,
      port: 38191,
      pid: process.pid,
      started_at: FIRST_STARTED_AT,
    });
    // 本实例已停止，另一实例把陈旧标记重建为自己的占位。
    const kill_spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    });
    const other = await acquire_web_instance_marker({
      dataRoot,
      nativeFs,
      port: 41234,
      pid: 777,
      started_at: SECOND_STARTED_AT,
    });
    expect(other.status).toBe("acquired");

    await release_web_instance_marker({ dataRoot, nativeFs, pid: process.pid });

    expect(read_marker(markerPath)).toEqual({
      pid: 777,
      port: 41234,
      started_at: SECOND_STARTED_AT,
    });
    expect(kill_spy).toHaveBeenCalledWith(process.pid, 0);
  });

  it("并发启动只有一个实例胜出，其余按第二实例提示", async () => {
    const { dataRoot, nativeFs, markerPath } = create_data_root();
    // 参与竞争的进程都在运行，信号探测对任意 PID 都报告存活。
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const competing_pids = [4101, 4102, 4103, 4104, 4105];

    const results = await Promise.all(
      competing_pids.map(async (pid, index) => {
        // 交错进入占位创建，模拟多个进程几乎同时启动。
        await Promise.resolve();
        return await acquire_web_instance_marker({
          dataRoot,
          nativeFs,
          port: 40_000 + index,
          pid,
          started_at: FIRST_STARTED_AT,
        });
      }),
    );

    const acquired = results.flatMap((result) =>
      result.status === "acquired" ? [result.marker] : [],
    );
    expect(acquired).toHaveLength(1);
    expect(results.filter((result) => result.status === "conflict")).toHaveLength(
      competing_pids.length - 1,
    );
    // 磁盘上的标记属于唯一胜出者，提示内容与胜出者一致。
    expect(read_marker(markerPath)).toEqual(acquired[0]);
  });

  it("数据根不可创建标记时报告不可用且不抛出", async () => {
    const { dataRoot, nativeFs } = create_data_root();
    // 用文件占住数据根路径，mkdir 与 open 都会失败。
    fs.rmSync(dataRoot, { force: true, recursive: true });
    fs.writeFileSync(dataRoot, "not a directory", "utf-8");

    const result = await acquire_web_instance_marker({
      dataRoot,
      nativeFs,
      port: 38191,
      pid: process.pid,
      started_at: FIRST_STARTED_AT,
    });

    expect(result.status).toBe("unavailable");
    expect(result).toMatchObject({ reason: expect.stringContaining("open_failed:") });
  });
});
