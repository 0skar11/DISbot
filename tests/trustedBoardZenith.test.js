import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trustedBoardChannelFor, isTrustedBoardChannel, TRUSTED_BOARD_CHANNEL_ID } from '../src/services/trustedBoardService.js';

test('each server has its own trusted board room; Zenith uses #bot-status', () => {
  assert.equal(trustedBoardChannelFor('1569932761471524874'), '1571078435927887952');
  assert.equal(trustedBoardChannelFor('1155236281706627173'), TRUSTED_BOARD_CHANNEL_ID);
  assert.equal(trustedBoardChannelFor('1'), TRUSTED_BOARD_CHANNEL_ID);
  assert.equal(isTrustedBoardChannel('1571078435927887952'), true);
  assert.equal(isTrustedBoardChannel(TRUSTED_BOARD_CHANNEL_ID), true);
  assert.equal(isTrustedBoardChannel('123'), false);
});
