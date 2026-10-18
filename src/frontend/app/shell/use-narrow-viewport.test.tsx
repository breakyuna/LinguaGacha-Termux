import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useNarrowViewport } from "./use-narrow-viewport";

it("按视口断点给出侧栏形态，跨断点更新并在卸载时释放监听", async () => {
  const queries: (EventTarget & {
    matches: boolean;
    removeEventListener: ReturnType<typeof vi.fn>;
  })[] = [];
  const match = vi.spyOn(window, "matchMedia").mockImplementation(() => {
    const target = new EventTarget();
    const remove = vi.spyOn(target, "removeEventListener");
    queries.push(Object.assign(target, { matches: false, removeEventListener: remove }));
    return target as MediaQueryList;
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  /** 通过实际渲染值观察 Hook 的视口判断。 */
  function Reader() {
    return <span>{useNarrowViewport() ? "drawer" : "inline"}</span>;
  }

  try {
    await act(async () => root.render(<Reader />));
    expect(container.textContent).toBe("inline");
    expect(match).toHaveBeenCalledWith("(max-width: 767px)");

    const query = queries.at(-1)!;
    await act(async () => {
      query.matches = true;
      query.dispatchEvent(new Event("change"));
    });
    expect(container.textContent).toBe("drawer");
  } finally {
    await act(async () => root.unmount());
    expect(queries.at(-1)!.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
    vi.restoreAllMocks();
  }
});
