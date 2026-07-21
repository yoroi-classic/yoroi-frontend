describe('failed parent test', () => {
  it('fails', () => {
    throw new Error('expected fixture failure');
  });

  describe('nested suite', () => {
    it('does not run after the parent failure', () => {
      throw new Error('a parent test failure must block nested tests');
    });
  });
});
