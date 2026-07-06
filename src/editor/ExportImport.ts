/**
 * ExportImport — 坦克视觉参数 JSON 导出/导入
 * ============================================================
 * 将当前编辑的视觉参数导出为可下载的 JSON 文件，
 * 或从 JSON 文件导入覆盖当前参数。
 */
/**
 * 将视觉参数对象导出为 JSON 字符串（带格式化）
 */
export function exportToJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * 触发浏览器下载 JSON 文件
 */
export function downloadJson(json: string, filename: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 从 JSON 字符串解析视觉参数
 * @returns 解析后的对象，或 null（解析失败）
 */
export function importFromJson(json: string): unknown | null {
  try {
    const data = JSON.parse(json);
    if (data && typeof data === 'object') return data;
    return null;
  } catch {
    return null;
  }
}
