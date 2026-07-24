import { cache, call, getValue, lazy, makeAccessor, mutateFunc } from './objectModel';

describe('cache', () => {
  test('invalidates a cached nested value after a model change', async () => {
    let currentName = 'first';
    const accessor = cache(
      makeAccessor({
        profile: lazy(async () => ({ name: currentName })),
        setName: mutateFunc((_path, emitChange) => async nextName => {
          currentName = nextName;
          emitChange(['profile', 'name'], nextName);
        }),
      })
    );

    expect(await getValue(accessor.profile.name)).toEqual('first');

    await call(accessor.setName, 'second');

    expect(await getValue(accessor.profile.name)).toEqual('second');
  });
});
