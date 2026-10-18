/**
 * 浏览器没有系统文件对话框，宿主桥把路径选择请求发布到这条总线，
 * 由应用内的选择器界面承接；调用方只面对 Promise，不接触界面状态。
 */

export type WebFilePickIntent = {
  mode: "file" | "directory" | "save";
  default_name?: string; // save 模式的默认文件名
  allow_upload?: boolean; // file 模式是否开放上传暂存
};

export type WebFilePickResult = {
  canceled: boolean;
  paths: string[]; // 浏览或暂存出的绝对路径，后端导入接口直接消费
  material_ids: string[]; // 本次交付的暂存材料身份，由调用方在导入成功后释放
  web_download?: boolean; // 交付物经受控下载返回，调用方不写本地路径
};

/** 选择器界面按 intent 打开对话框，完成后经 resolve 回传结果。 */
export type WebFilePickRequestListener = (
  intent: WebFilePickIntent,
  resolve: (result: WebFilePickResult) => void,
) => void;

const WEB_FILE_PICKER_UNAVAILABLE_MESSAGE = "Web file picker host is not mounted.";

const listeners = new Set<WebFilePickRequestListener>();

/** 订阅选择请求；应用外壳只安装一个宿主，退订即表示界面离场。 */
export function subscribe_web_file_pick_requests(listener: WebFilePickRequestListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 发布一次选择请求；没有订阅者时说明选择器界面未挂载，按接线失败拒绝。 */
export function request_web_file_pick(intent: WebFilePickIntent): Promise<WebFilePickResult> {
  return new Promise<WebFilePickResult>((resolve, reject) => {
    if (listeners.size === 0) {
      reject(new Error(WEB_FILE_PICKER_UNAVAILABLE_MESSAGE));
      return;
    }

    // 听众可能在回调里退订，先复制再通知，避免遍历中修改集合。
    for (const listener of Array.from(listeners)) {
      listener(intent, resolve);
    }
  });
}
