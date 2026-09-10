import { writeSecureTempFile, cleanupSecureTempDir } from '../secureTempFile';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('writeSecureTempFile', () => {
  it('creates a fresh, unpredictable directory per call and writes the file inside it', async () => {
    const a = await writeSecureTempFile('idp-test', 'a.yaml', 'content-a');
    const b = await writeSecureTempFile('idp-test', 'b.yaml', 'content-b');

    expect(a.dir).not.toBe(b.dir);
    expect(a.filePath).toBe(path.join(a.dir, 'a.yaml'));
    expect(await fs.readFile(a.filePath, 'utf8')).toBe('content-a');
    expect(await fs.readFile(b.filePath, 'utf8')).toBe('content-b');

    await cleanupSecureTempDir(a.dir);
    await cleanupSecureTempDir(b.dir);
  });

  it('creates the temp directory with owner-only permissions', async () => {
    const { dir } = await writeSecureTempFile('idp-test', 'a.yaml', 'x');
    const stat = await fs.stat(dir);
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).toBe(0o700);
    await cleanupSecureTempDir(dir);
  });
});

describe('cleanupSecureTempDir', () => {
  it('removes the directory and its contents', async () => {
    const { dir } = await writeSecureTempFile('idp-test', 'a.yaml', 'x');
    await cleanupSecureTempDir(dir);
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it('is best-effort — does not throw when the directory is already gone', async () => {
    await expect(cleanupSecureTempDir('/tmp/does-not-exist-idp-test-dir')).resolves.toBeUndefined();
  });
});
