/** 保留命令集中解析；原生未知 slash 指令仍作为普通任务交给 Claude。 */
const names = new Set(['help', 'commands', 'tools', 'plan', 'usage', 'capabilities', 'config', 'questions', 'answer', 'skip', 'steer', 'sessions', 'resume', 'mode', 'model', 'effort']);
export function nativeCommand(text: string): { name: string; argument: string } | undefined {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  return match && names.has(match[1]) ? { name: match[1], argument: (match[2] ?? '').trim() } : undefined;
}
export const NativeHelp = `任务管理：/status /queue /cancel /cancel <编号> /cancel all /result /result <编号> /result failed /new
Claude 能力：/commands /tools /plan /usage /capabilities /config
任务引导：/steer <补充要求>（只作用于本人正在执行的任务）
交互回答：/questions /answer <问题编号> <回答或 JSON> /skip <问题编号>
会话历史：/sessions /resume <会话编号>（仅本人当前聊天和话题）
执行偏好：/mode plan 或 /mode execute；/model <值>；/effort <值>；default 恢复默认
偏好设置在本会话无执行中和排队任务时修改，下次执行生效；/config 查看运行时可选值。
可发送 PNG/JPEG/GIF/WebP 图片（最多 5 MiB）或 UTF-8 文本附件（最多 256 KiB）。
检查点回退及后台任务管理尚未启用。Claude 原生命令仍按普通任务排队。`;
