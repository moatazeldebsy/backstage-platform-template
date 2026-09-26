import { newRepoNameError, repoFromValue } from './repoNameCheck';

describe('repoFromValue', () => {
  it('reads owner and repo from a RepoUrlPicker value', () => {
    expect(repoFromValue('github.com?owner=moatazeldebsy&repo=flutter-demo')).toEqual({
      owner: 'moatazeldebsy',
      repo: 'flutter-demo',
    });
  });

  it('returns null while the value is incomplete', () => {
    expect(repoFromValue('github.com?owner=moatazeldebsy')).toBeNull();
    expect(repoFromValue('github.com')).toBeNull();
    expect(repoFromValue(undefined)).toBeNull();
  });
});

describe('newRepoNameError', () => {
  const taken = 'github.com?owner=moatazeldebsy&repo=flutter-demo';

  // The reason this field exists: flutter-app failed at publish:github with
  // "name already exists on this account" after the form and earlier steps.
  it('blocks a name that already exists, naming the repository', async () => {
    const error = await newRepoNameError(taken, async () => 'exists');
    expect(error).toMatch(/^moatazeldebsy\/flutter-demo already exists on GitHub/);
  });

  it('allows a name that is free', async () => {
    await expect(newRepoNameError(taken, async () => 'available')).resolves.toBeNull();
  });

  it('never blocks when the check could not be made', async () => {
    await expect(newRepoNameError(taken, async () => 'unknown')).resolves.toBeNull();
    await expect(
      newRepoNameError(taken, async () => {
        throw new Error('backend down');
      }),
    ).resolves.toBeNull();
  });

  it('does not call the backend for an incomplete value', async () => {
    const getStatus = jest.fn();
    await expect(newRepoNameError('github.com?owner=x', getStatus)).resolves.toBeNull();
    expect(getStatus).not.toHaveBeenCalled();
  });
});
