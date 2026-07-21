describe('beforeEach skip', () => {
  beforeEach(function () {
    if (this.currentTest.title === 'skips when its hook precondition is unavailable') {
      this.skip();
    }
  });

  it('skips when its hook precondition is unavailable', () => {});

  it('does not run the following sibling', () => {
    throw new Error('a hook precondition skip must block following siblings');
  });
});
