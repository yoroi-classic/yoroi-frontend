describe('failed sibling', () => {
  it('fails', () => {
    throw new Error('expected fixture failure');
  });

  it('does not run the following sibling', () => {
    throw new Error('a failed test must block following siblings');
  });
});
