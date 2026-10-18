import { describe, expect, it } from "vitest";

import { request_web_file_pick, subscribe_web_file_pick_requests } from "./picker-request-bus";

describe("web file pick request bus", () => {
  it("没有订阅者时按接线失败拒绝", async () => {
    await expect(request_web_file_pick({ mode: "file" })).rejects.toThrow(
      "Web file picker host is not mounted.",
    );
  });

  it("订阅后交付请求，解析结果后退订不再接收", async () => {
    const received_intents: unknown[] = [];
    const unsubscribe = subscribe_web_file_pick_requests((intent, resolve) => {
      received_intents.push(intent);
      resolve({ canceled: false, paths: ["/data/demo.txt"], material_ids: ["mat-1"] });
    });

    await expect(request_web_file_pick({ mode: "file", allow_upload: true })).resolves.toEqual({
      canceled: false,
      paths: ["/data/demo.txt"],
      material_ids: ["mat-1"],
    });
    expect(received_intents).toEqual([{ mode: "file", allow_upload: true }]);

    unsubscribe();
    await expect(request_web_file_pick({ mode: "directory" })).rejects.toThrow(
      "Web file picker host is not mounted.",
    );
  });
});
