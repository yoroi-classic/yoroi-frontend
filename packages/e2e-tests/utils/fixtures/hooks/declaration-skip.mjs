describe('declaration-time skip', () => {
  it.skip('is intentionally pending', () => {
    throw new Error('a declaration-time skip must not run');
  });

  it('runs the live sibling', () => {});
});
