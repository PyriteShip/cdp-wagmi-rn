/**
 * cdpAccount orchestration — confirms the extracted core wires cdp-core +
 * cdpCswWrap the same way the former CdpEthersSigner did. cdp-core, the bridge,
 * and the CSW wrapping are mocked so this runs without the native SDK.
 */

jest.mock('@coinbase/cdp-core', () => ({
  signEvmTypedData: jest.fn(async () => ({ signature: '0xINNER' })),
  sendUserOperation: jest.fn(async () => ({ userOperationHash: '0xUOP' })),
  getUserOperation: jest.fn(async () => ({ status: 'complete', transactionHash: '0xTX' })),
}));
jest.mock('./cdpBridge', () => ({
  getCdpState: () => ({ evmAddress: '0xSmart', evmEoaAddress: '0xEoa' }),
}));
jest.mock('./cdpCswWrap', () => ({
  buildCswReplaySafeTypedData: jest.fn(() => ({ envelope: 'td' })),
  buildCswReplaySafeTypedDataForHash: jest.fn(() => ({ envelope: 'hash' })),
  wrapCswSignature: jest.fn((s: string) => `wrapped(${s})`),
  wrapErc6492: jest.fn(({ innerSig }: any) => `6492(${innerSig})`),
  buildCoinbaseFactoryCalldata: jest.fn(() => '0xFACTORY'),
  encodeAddressOwner: jest.fn((a: string) => a),
  coinbaseFactoryInterface: {
    encodeFunctionData: jest.fn(() => '0x'),
    decodeFunctionResult: jest.fn(() => ['0x0000000000000000000000000000000000000000']),
  },
  CDP_SMART_ACCOUNT_FACTORY: '0xFac',
}));

import {
  cdpGetAddress,
  cdpSignMessage,
  cdpSignTypedData,
  cdpSendCalls,
  CdpUserOperationFailedError,
} from './cdpAccount';
import * as cdpCore from '@coinbase/cdp-core';
import * as csw from './cdpCswWrap';

beforeEach(() => jest.clearAllMocks());

test('cdpGetAddress prefers the bridge address', () => {
  expect(cdpGetAddress('0xFallback')).toBe('0xSmart');
});

test('cdpSendCalls sends a sponsored userOp on the given network and returns the polled tx hash', async () => {
  const hash = await cdpSendCalls([{ to: '0xTo', value: 5n, data: '0xab' }], '0xSmart', {
    cdpNetwork: 'base-sepolia',
  });
  expect(hash).toBe('0xTX');
  expect(cdpCore.sendUserOperation).toHaveBeenCalledWith(
    expect.objectContaining({
      evmSmartAccount: '0xSmart',
      network: 'base-sepolia',
      useCdpPaymaster: true,
      calls: [{ to: '0xTo', value: 5n, data: '0xab' }],
    }),
  );
  expect(cdpCore.getUserOperation).toHaveBeenCalled();
});

test('cdpSendCalls throws when the userOp was included but failed', async () => {
  (cdpCore.getUserOperation as jest.Mock).mockResolvedValueOnce({ status: 'failed', transactionHash: '0xTX' });
  const err = await cdpSendCalls([{ to: '0xTo' }], '0xSmart', { cdpNetwork: 'base-sepolia' }).catch((e) => e);
  expect(err).toBeInstanceOf(CdpUserOperationFailedError);
  expect(err).toMatchObject({ userOperationHash: '0xUOP', status: 'failed', transactionHash: '0xTX' });
  expect(err.message).toBe('CDP UserOp 0xUOP failed (tx 0xTX)');
});

test('cdpSendCalls throws a typed error when the userOp is dropped', async () => {
  (cdpCore.getUserOperation as jest.Mock).mockResolvedValueOnce({ status: 'dropped' });
  const err = await cdpSendCalls([{ to: '0xTo' }], '0xSmart', { cdpNetwork: 'base-sepolia' }).catch((e) => e);
  expect(err).toBeInstanceOf(CdpUserOperationFailedError);
  expect(err).toMatchObject({ userOperationHash: '0xUOP', status: 'dropped' });
  expect(err.transactionHash).toBeUndefined();
  expect(err.message).toBe('CDP UserOp 0xUOP dropped');
});


test('cdpSendCalls throws on a failed userOp that carries no tx hash', async () => {
  (cdpCore.getUserOperation as jest.Mock).mockResolvedValueOnce({ status: 'failed' });
  const err = await cdpSendCalls([{ to: '0xTo' }], '0xSmart', { cdpNetwork: 'base-sepolia' }).catch((e) => e);
  expect(err).toBeInstanceOf(CdpUserOperationFailedError);
  expect(err.transactionHash).toBeUndefined();
  expect(err.message).toBe('CDP UserOp 0xUOP failed');
});

test('cdpSignTypedData wraps via CSW (using opts.chainId) and signs with the owner EOA', async () => {
  const sig = await cdpSignTypedData(
    { name: 'ToolRentalEscrow', version: '1' },
    { RentalOffer: [{ name: 'tokenId', type: 'uint256' }] },
    { tokenId: 1 },
    '0xSmart',
    { chainId: 84532 },
  );
  expect(csw.buildCswReplaySafeTypedData).toHaveBeenCalledWith(
    expect.objectContaining({ chainId: 84532 }),
  );
  expect(cdpCore.signEvmTypedData).toHaveBeenCalledWith(
    expect.objectContaining({ evmAccount: '0xEoa' }),
  );
  expect(sig).toBe('wrapped(0xINNER)'); // wrapCswSignature applied to the inner sig
});

test('cdpSignMessage binds the envelope to opts.chainId (verifier chain)', async () => {
  // A caller verifying on a different chain (e.g. XMTP on mainnet) passes 8453.
  const smart = '0x1111111111111111111111111111111111111111';
  const sig = await cdpSignMessage('hello', smart, null, { chainId: 8453 });
  expect(csw.buildCswReplaySafeTypedDataForHash).toHaveBeenCalledWith(
    expect.objectContaining({ chainId: 8453, smartAccount: smart }),
  );
  expect(sig).toBe('6492(wrapped(0xINNER))'); // ERC-6492-wrapped CSW signature
});
