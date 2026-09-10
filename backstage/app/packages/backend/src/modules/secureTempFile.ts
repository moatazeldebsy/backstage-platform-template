import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/**
 * Writes `contents` to a freshly created, uniquely-named temp directory
 * (fs.mkdtemp, mode 0700) rather than a predictable path directly under the
 * shared system temp dir. A predictable name (e.g. `namespace-${name}-
 * ${Date.now()}.yaml`) written straight into /tmp lets another process or
 * user on the same host pre-plant a symlink at that path; writeFile follows
 * symlinks, so the write can land somewhere unintended (SonarQube S5443).
 * mkdtemp's directory name is unpredictable and atomically unique, so
 * there's nothing to pre-plant.
 */
export async function writeSecureTempFile(
  prefix: string,
  filename: string,
  contents: string,
): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, contents, 'utf8');
  return { dir, filePath };
}

/** Removes the directory created by writeSecureTempFile. Best-effort. */
export async function cleanupSecureTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
