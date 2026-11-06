import { describe, expect, it } from "vitest";

import {
  APP_TABLE_FLEX_COLUMN_MIN_WIDTH,
  build_app_table_placeholder_fill,
  build_app_table_spacer_heights,
  resolve_app_table_min_width,
} from "@frontend/widgets/app-table/app-table-virtualization";

describe("app-table-virtualization", () => {
  it("短列表会把视口剩余高度拆成占位行和残余 spacer", () => {
    const row_height = 30;
    const spacer_heights = build_app_table_spacer_heights({
      viewport_height: 120,
      total_size: 72,
      range_start: 0,
      range_end: 72,
    });
    const placeholder_fill = build_app_table_placeholder_fill(
      spacer_heights.viewport_fill_height,
      row_height,
    );

    expect(spacer_heights).toEqual({
      top_spacer_height: 0,
      virtual_bottom_spacer_height: 0,
      viewport_fill_height: 48,
      bottom_spacer_height: 48,
    });
    expect(placeholder_fill).toEqual({
      placeholder_row_heights: [row_height],
      residual_spacer_height: 18,
    });
  });

  it("表格最小宽度由声明列宽和弹性列下限相加", () => {
    expect(
      resolve_app_table_min_width([
        { width: 64 },
        {},
        { width: 96 },
        { width: 120 },
        {},
      ]),
    ).toBe(64 + 96 + 120 + 2 * APP_TABLE_FLEX_COLUMN_MIN_WIDTH);
    expect(resolve_app_table_min_width([])).toBe(0);
  });
});
