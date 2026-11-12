/** 解析项目目录：realpath 后必须位于注册根目录内的现存目录，防符号链接逃逸。 */
import { realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';

export function workspacePath(root: string, project: string): string {
  const base = realpathSync(root);
  const target = realpathSync(resolve(base, project));
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Workspace outside root');
  if (!statSync(target).isDirectory()) throw new Error('Workspace must be a directory');
  return target;
}
