import TrezorConnect from 'trezor-connect-flow';
import { wrapWithFrame } from './TrezorWrapper';

describe('wrapWithFrame', () => {
  it('disposes Trezor Connect once when the callback rejects', async () => {
    const error = new Error('callback failed');
    const dispose = jest.spyOn(TrezorConnect, 'dispose').mockResolvedValue(undefined);

    await expect(
      wrapWithFrame(async () => {
        throw error;
      })
    ).rejects.toBe(error);
    expect(dispose).toHaveBeenCalledTimes(1);

    dispose.mockRestore();
  });
});
