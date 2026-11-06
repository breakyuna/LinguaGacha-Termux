import { useEffect, useState } from "react";

/** 抽屉导航与并排侧栏共用同一断点，避免同一视口下两种形态同时成立。 */
const NARROW_VIEWPORT_QUERY = "(max-width: 767px)";

/** 同步读取当前视口形态；首屏初始化没有 effect 时机，由本函数提供同一求值来源。 */
export function read_is_narrow_viewport(): boolean {
  return window.matchMedia(NARROW_VIEWPORT_QUERY).matches;
}

/** 当前视口是否只放得下抽屉导航；查询变化时重新求值，监听随消费者卸载释放。 */
export function useNarrowViewport(): boolean {
  const [is_narrow, set_is_narrow] = useState(read_is_narrow_viewport);

  useEffect(() => {
    const query = window.matchMedia(NARROW_VIEWPORT_QUERY);
    /** 跨断点时标题栏开关与侧栏形态必须同时切换，两侧读取同一次求值结果。 */
    const update = (): void => {
      set_is_narrow(query.matches);
    };

    update();
    query.addEventListener("change", update);
    return () => {
      query.removeEventListener("change", update);
    };
  }, []);

  return is_narrow;
}
