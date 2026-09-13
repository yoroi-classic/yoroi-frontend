import { cache, call, getValue, lazy, makeAccessor, mutateFunc } from './objectModel';

describe('cache', () => {
  test('invalidates a cached nested value after a model change', async () => {
    let currentName = 'first';
    let profileReads = 0;
    const accessor = cache(
      makeAccessor({
        profile: lazy(async () => {
          profileReads += 1;
          return { name: currentName };
        }),
        setName: mutateFunc((_path, emitChange) => async nextName => {
          currentName = nextName;
          emitChange(['profile', 'name'], nextName);
        }),
      })
    );

    expect(await getValue(accessor.profile.name, { cache: true })).toEqual('first');
    expect(await getValue(accessor.profile.name, { cache: true })).toEqual('first');
    expect(profileReads).toEqual(1);

    await call(accessor.setName, 'second');

    expect(await getValue(accessor.profile.name, { cache: true })).toEqual('second');
    expect(profileReads).toEqual(2);
  });
});
