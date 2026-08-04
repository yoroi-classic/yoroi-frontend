describe('runtime skip', () => {
  it('skips when its runtime precondition is unavailable', function () {
    this.skip();
  });

  it('does not run the following sibling', () => {
    throw new Error('a runtime precondition skip must block following siblings');
  });
});
