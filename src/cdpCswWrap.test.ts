/**
 * Tests for the CSW (Coinbase Smart Wallet) signature wrapping helpers in
 * `cdpCswWrap.ts`. These are the load-bearing pure-logic pieces that bridge
 * EIP-712 offer signing to what CSW's on-chain `_isValidSignature` accepts.
 *
 * Why pure-logic only: signing needs the CDP SDK's auth state, which isn't
 * available in jest. The helpers are deterministic, so unit tests catch the
 * wrap-format bugs that otherwise surface only on-chain ("RentalEscrow:
 * invalid offer signature").
 *
 * ethers is the independent reference: the helpers encode with viem, and each
 * encoding is checked against ethers' own encoder or decoder.
 */

import { ethers } from 'ethers';
import {
  buildCswReplaySafeTypedData,
  wrapCswSignature,
  wrapErc6492,
  encodeAddressOwner,
  buildCoinbaseFactoryCalldata,
  ERC6492_MAGIC,
  CDP_SMART_ACCOUNT_FACTORY,
} from './cdpCswWrap';

const SMART_ACCOUNT = '0x1234567890123456789012345678901234567890';

const ETHERS_FACTORY_INTERFACE = new ethers.Interface([
  'function createAccount(bytes[] owners, uint256 nonce) payable returns (address)',
]);
const CHAIN_ID = 84532;

// A representative RentalOffer matches `signedOffer.ts`'s EIP712_TYPES.
const RENTAL_OFFER_DOMAIN = {
  name: 'ToolRentalEscrow',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: '0xE82886e55Fd866B1425D15039C27a253c891954c',
} as const;
const RENTAL_OFFER_TYPES = {
  RentalOffer: [
    { name: 'tokenId', type: 'uint256' },
    { name: 'lender', type: 'address' },
    { name: 'minimumFee', type: 'uint128' },
    { name: 'dailyRate', type: 'uint128' },
    { name: 'borrowerDeposit', type: 'uint128' },
    { name: 'gracePeriod', type: 'uint32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'borrower', type: 'address' },
  ],
};
const SAMPLE_OFFER = {
  tokenId: '5',
  lender: SMART_ACCOUNT,
  minimumFee: '1000000',
  dailyRate: '500000',
  borrowerDeposit: '5000000',
  gracePeriod: 86400,
  nonce: '1',
  borrower: ethers.ZeroAddress,
};

describe('buildCswReplaySafeTypedData', () => {
  test('uses CSW domain (name, version, chainId, verifyingContract)', () => {
    const envelope = buildCswReplaySafeTypedData({
      originalDomain: RENTAL_OFFER_DOMAIN,
      originalTypes: RENTAL_OFFER_TYPES,
      originalValue: SAMPLE_OFFER,
      smartAccount: SMART_ACCOUNT,
      chainId: CHAIN_ID,
    });

    expect(envelope.domain).toEqual({
      name: 'Coinbase Smart Wallet',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: SMART_ACCOUNT,
    });
  });

  test('primary type is CoinbaseSmartWalletMessage(bytes32 hash)', () => {
    const envelope = buildCswReplaySafeTypedData({
      originalDomain: RENTAL_OFFER_DOMAIN,
      originalTypes: RENTAL_OFFER_TYPES,
      originalValue: SAMPLE_OFFER,
      smartAccount: SMART_ACCOUNT,
      chainId: CHAIN_ID,
    });

    expect(envelope.primaryType).toBe('CoinbaseSmartWalletMessage');
    expect(envelope.types.CoinbaseSmartWalletMessage).toEqual([
      { name: 'hash', type: 'bytes32' },
    ]);
  });

  test('inner hash equals EIP-712 hash of the original typed data', () => {
    const envelope = buildCswReplaySafeTypedData({
      originalDomain: RENTAL_OFFER_DOMAIN,
      originalTypes: RENTAL_OFFER_TYPES,
      originalValue: SAMPLE_OFFER,
      smartAccount: SMART_ACCOUNT,
      chainId: CHAIN_ID,
    });

    const expected = ethers.TypedDataEncoder.hash(
      RENTAL_OFFER_DOMAIN,
      RENTAL_OFFER_TYPES,
      SAMPLE_OFFER,
    );
    expect(envelope.message.hash).toBe(expected);
  });

  test('replay-safe digest matches CSW.replaySafeHash(originalDigest)', () => {
    // CSW's replaySafeHash is `_hashTypedData(keccak256(abi.encode(
    //   keccak256("CoinbaseSmartWalletMessage(bytes32 hash)"), hash)))`
    // — i.e. EIP-712 hash of (CSW domain, CoinbaseSmartWalletMessage{hash}).
    // ethers.TypedDataEncoder.hash of our envelope must produce the same
    // bytes32 the smart wallet computes internally.
    const envelope = buildCswReplaySafeTypedData({
      originalDomain: RENTAL_OFFER_DOMAIN,
      originalTypes: RENTAL_OFFER_TYPES,
      originalValue: SAMPLE_OFFER,
      smartAccount: SMART_ACCOUNT,
      chainId: CHAIN_ID,
    });

    const cswDomain = {
      name: 'Coinbase Smart Wallet',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: SMART_ACCOUNT,
    };
    const cswTypes = {
      CoinbaseSmartWalletMessage: [{ name: 'hash', type: 'bytes32' }],
    };
    const originalDigest = ethers.TypedDataEncoder.hash(
      RENTAL_OFFER_DOMAIN,
      RENTAL_OFFER_TYPES,
      SAMPLE_OFFER,
    );

    // The envelope digest the EOA actually signs.
    const envelopeDigest = ethers.TypedDataEncoder.hash(
      cswDomain,
      cswTypes,
      { hash: originalDigest },
    );
    // Sanity: it must equal the hash computed directly from the structured
    // envelope our helper builds.
    const fromHelper = ethers.TypedDataEncoder.hash(
      cswDomain,
      cswTypes,
      { hash: envelope.message.hash },
    );
    expect(fromHelper).toBe(envelopeDigest);
  });

  test('accepts inbound types that already include EIP712Domain', () => {
    // Some call sites (e.g. via ethers.AbstractSigner subclass conventions)
    // pass types that include the EIP712Domain entry; the helper must
    // tolerate both shapes since ethers.TypedDataEncoder.hash rejects the
    // form with EIP712Domain present.
    const typesWithDomain = {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ...RENTAL_OFFER_TYPES,
    };
    const envelope = buildCswReplaySafeTypedData({
      originalDomain: RENTAL_OFFER_DOMAIN,
      originalTypes: typesWithDomain,
      originalValue: SAMPLE_OFFER,
      smartAccount: SMART_ACCOUNT,
      chainId: CHAIN_ID,
    });
    expect(envelope.message.hash).toBe(
      ethers.TypedDataEncoder.hash(RENTAL_OFFER_DOMAIN, RENTAL_OFFER_TYPES, SAMPLE_OFFER),
    );
  });

  // A nested struct listed before its parent: the struct being signed is the
  // one no other type references, not the first key.
  const MAIL_TYPES = {
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
    ],
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person[]' },
      { name: 'contents', type: 'string' },
    ],
  };
  const MAIL = {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: [{ name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' }],
    contents: 'Hello, Bob!',
  };

  test('hashes the root struct of nested types, matching ethers', () => {
    const envelope = buildCswReplaySafeTypedData({
      originalDomain: RENTAL_OFFER_DOMAIN,
      originalTypes: MAIL_TYPES,
      originalValue: MAIL,
      smartAccount: SMART_ACCOUNT,
      chainId: CHAIN_ID,
    });
    expect(envelope.message.hash).toBe(ethers.TypedDataEncoder.hash(RENTAL_OFFER_DOMAIN, MAIL_TYPES, MAIL));
  });

  test('an explicit primaryType selects the struct being signed', () => {
    const person = MAIL.from;
    const envelope = buildCswReplaySafeTypedData({
      originalDomain: RENTAL_OFFER_DOMAIN,
      originalTypes: MAIL_TYPES,
      originalValue: person,
      originalPrimaryType: 'Person',
      smartAccount: SMART_ACCOUNT,
      chainId: CHAIN_ID,
    });
    // ethers infers Person as the only type in a Person-only set.
    expect(envelope.message.hash).toBe(
      ethers.TypedDataEncoder.hash(RENTAL_OFFER_DOMAIN, { Person: MAIL_TYPES.Person }, person),
    );
  });

  test('throws when the types have more than one root struct', () => {
    expect(() =>
      buildCswReplaySafeTypedData({
        originalDomain: RENTAL_OFFER_DOMAIN,
        originalTypes: { A: [{ name: 'x', type: 'uint256' }], B: [{ name: 'y', type: 'uint256' }] },
        originalValue: { x: 1 },
        smartAccount: SMART_ACCOUNT,
        chainId: CHAIN_ID,
      }),
    ).toThrow(/root types/);
  });

  test('a domain chainId given as a hex or decimal string hashes like the number', () => {
    const expected = ethers.TypedDataEncoder.hash(RENTAL_OFFER_DOMAIN, RENTAL_OFFER_TYPES, SAMPLE_OFFER);
    for (const chainId of [`0x${CHAIN_ID.toString(16)}`, String(CHAIN_ID)]) {
      const envelope = buildCswReplaySafeTypedData({
        originalDomain: { ...RENTAL_OFFER_DOMAIN, chainId: chainId as unknown as number },
        originalTypes: RENTAL_OFFER_TYPES,
        originalValue: SAMPLE_OFFER,
        smartAccount: SMART_ACCOUNT,
        chainId: CHAIN_ID,
      });
      expect(envelope.message.hash).toBe(expected);
    }
  });
});

describe('wrapCswSignature', () => {
  // A canonical 65-byte ECDSA sig (random r/s/v values for layout tests).
  const RAW_SIG =
    '0x' +
    'aa'.repeat(32) + // r
    'bb'.repeat(32) + // s
    '1b';             // v = 27

  test('output decodes as SignatureWrapper(uint8 ownerIndex, bytes signatureData)', () => {
    const wrapped = wrapCswSignature(RAW_SIG);
    const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode(
      ['tuple(uint8 ownerIndex, bytes signatureData)'],
      wrapped,
    );
    expect(decoded.ownerIndex).toBe(0n);
    expect(decoded.signatureData).toBe(RAW_SIG);
  });

  test('uses tuple-struct layout (not two top-level params)', () => {
    // The tuple-struct ABI layout starts with a 32-byte offset to the tuple
    // data (always 0x20 for a single-tuple parameter). The flat form
    // (`encode(['uint8','bytes'], [0, sig])`) does NOT start with that
    // offset. CSW's `_isValidSignature` calls
    // `abi.decode(signature, (SignatureWrapper))` which expects the tuple
    // layout — a flat encoding decodes the offset bytes as `ownerIndex`
    // and the wrong region as `signatureData`, producing garbage and
    // returning the "not valid" magic value.
    const wrapped = wrapCswSignature(RAW_SIG);
    const firstWord = wrapped.slice(2, 2 + 64);
    // 32-byte offset to tuple-head; value is 0x20.
    expect(firstWord).toBe('0'.repeat(62) + '20');

    const flat = ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint8', 'bytes'],
      [0, RAW_SIG],
    );
    expect(wrapped).not.toBe(flat);
  });

  test('is byte-identical to the ethers tuple encoding', () => {
    expect(wrapCswSignature(RAW_SIG)).toBe(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(uint8 ownerIndex, bytes signatureData)'],
        [{ ownerIndex: 0, signatureData: RAW_SIG }],
      ),
    );
  });

  test('zero-pads ownerIndex correctly (uint8 → 32 bytes)', () => {
    const wrapped = wrapCswSignature(RAW_SIG);
    // After the 32-byte tuple offset, the next 32 bytes are ownerIndex.
    const ownerIndexWord = wrapped.slice(2 + 64, 2 + 128);
    expect(ownerIndexWord).toBe('0'.repeat(64));
  });
});

describe('ERC-6492 wrapping', () => {
  const EOA = '0xabcdef0123456789abcdef0123456789abcdef01';
  const INNER_SIG = wrapCswSignature(
    '0x' + 'aa'.repeat(32) + 'bb'.repeat(32) + '1b',
  );

  test('encodeAddressOwner left-pads to a 32-byte checksum-agnostic word', () => {
    const owner = encodeAddressOwner(EOA);
    expect(owner).toBe('0x' + '00'.repeat(12) + EOA.slice(2).toLowerCase());
  });

  test('wrapErc6492 ends with the magic suffix', () => {
    const wrapped = wrapErc6492({
      factory: CDP_SMART_ACCOUNT_FACTORY,
      factoryCalldata: '0x1234',
      innerSig: INNER_SIG,
    });
    expect(wrapped.toLowerCase().endsWith(ERC6492_MAGIC.slice(2).toLowerCase())).toBe(true);
  });

  test('wrapErc6492 round-trips to (factory, factoryCalldata, innerSig)', () => {
    const factoryCalldata = buildCoinbaseFactoryCalldata([encodeAddressOwner(EOA)], 0);
    const wrapped = wrapErc6492({
      factory: CDP_SMART_ACCOUNT_FACTORY,
      factoryCalldata,
      innerSig: INNER_SIG,
    });
    // Strip the trailing 32 magic bytes (64 hex chars), decode the prefix.
    const prefix = wrapped.slice(0, wrapped.length - 64);
    const [factory, calldata, sig] = ethers.AbiCoder.defaultAbiCoder().decode(
      ['address', 'bytes', 'bytes'],
      prefix,
    );
    expect(ethers.getAddress(factory)).toBe(ethers.getAddress(CDP_SMART_ACCOUNT_FACTORY));
    expect(calldata).toBe(factoryCalldata);
    expect(sig).toBe(INNER_SIG);
  });

  test('wrapErc6492 is byte-identical to the ethers encoding', () => {
    const factoryCalldata = buildCoinbaseFactoryCalldata([encodeAddressOwner(EOA)], 0);
    const expected = ethers.concat([
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'bytes', 'bytes'],
        [CDP_SMART_ACCOUNT_FACTORY, factoryCalldata, INNER_SIG],
      ),
      ERC6492_MAGIC,
    ]);
    expect(wrapErc6492({ factory: CDP_SMART_ACCOUNT_FACTORY, factoryCalldata, innerSig: INNER_SIG })).toBe(
      expected,
    );
  });

  test('factory calldata decodes back to createAccount(owners, nonce)', () => {
    const owners = [encodeAddressOwner(EOA)];
    const calldata = buildCoinbaseFactoryCalldata(owners, 3);
    const decoded = ETHERS_FACTORY_INTERFACE.decodeFunctionData('createAccount', calldata);
    expect(decoded.owners).toEqual(owners);
    expect(decoded.nonce).toBe(3n);
    expect(calldata).toBe(ETHERS_FACTORY_INTERFACE.encodeFunctionData('createAccount', [owners, 3]));
  });
});
