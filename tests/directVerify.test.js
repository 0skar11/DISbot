import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canMemberVerify,
  isVerifyCommand,
  resolveTargetMember,
  executeVerification,
  TEXT,
} from '../src/services/verification/directVerifyService.js';
import { ZENITH_GUILD_ID } from '../src/config/homeGuild.js';

describe('directVerifyService (.توثيق / /verify)', () => {
  const ZENITH_VERIFIER_ROLE = '1572977938092134410';
  const ZENITH_VERIFIED_ROLE = '1570728144086765640';

  test('isVerifyCommand recognizes commands', () => {
    assert.equal(isVerifyCommand({ commandName: 'توثيق' }), true);
    assert.equal(isVerifyCommand({ commandName: 'verify' }), true);
    assert.equal(isVerifyCommand({ commandName: 'other' }), false);
    assert.equal(isVerifyCommand(null), false);
  });

  test('canMemberVerify checks verifier permissions', () => {
    // Owner
    assert.equal(canMemberVerify({ id: '1159601661392715906', guild: { id: ZENITH_GUILD_ID, ownerId: '1159601661392715906' } }), true);

    // Verifier role holder in Zenith
    const verifierMember = {
      id: 'v1',
      guild: { id: ZENITH_GUILD_ID, ownerId: 'owner' },
      roles: { cache: new Map([[ZENITH_VERIFIER_ROLE, { id: ZENITH_VERIFIER_ROLE }]]) },
      permissions: { has: () => false },
    };
    assert.equal(canMemberVerify(verifierMember), true);

    // Regular member without role or admin
    const regularMember = {
      id: 'reg1',
      guild: { id: ZENITH_GUILD_ID, ownerId: 'owner' },
      roles: { cache: new Map() },
      permissions: { has: () => false },
    };
    assert.equal(canMemberVerify(regularMember), false);
  });

  test('executeVerification refuses unauthorized member', async () => {
    let replied = null;
    const respond = (p) => { replied = p; return p; };

    const regularMember = {
      id: 'reg1',
      guild: { id: ZENITH_GUILD_ID, ownerId: 'owner' },
      roles: { cache: new Map() },
      permissions: { has: () => false },
    };

    await executeVerification({
      guild: regularMember.guild,
      executorMember: regularMember,
      targetMember: { id: 'target1' },
      respond,
    });

    assert.equal(replied.content, TEXT.noPermission);
  });

  test('executeVerification informs if target already verified', async () => {
    let replied = null;
    const respond = (p) => { replied = p; return p; };

    const verifierMember = {
      id: 'v1',
      guild: { id: ZENITH_GUILD_ID, ownerId: 'owner', roles: { cache: new Map([[ZENITH_VERIFIED_ROLE, { id: ZENITH_VERIFIED_ROLE }]]) } },
      roles: { cache: new Map([[ZENITH_VERIFIER_ROLE, { id: ZENITH_VERIFIER_ROLE }]]) },
      permissions: { has: () => false },
    };

    const targetMember = {
      id: 'target1',
      roles: { cache: new Map([[ZENITH_VERIFIED_ROLE, { id: ZENITH_VERIFIED_ROLE }]]) },
    };

    await executeVerification({
      guild: verifierMember.guild,
      executorMember: verifierMember,
      targetMember,
      respond,
    });

    assert.equal(replied.content, TEXT.alreadyVerified('target1'));
  });

  test('executeVerification grants role on success', async () => {
    let replied = null;
    const respond = (p) => { replied = p; return p; };
    let addedRole = null;

    const roleObj = { id: ZENITH_VERIFIED_ROLE };
    const verifierMember = {
      id: 'v1',
      user: { tag: 'verifier#0001' },
      guild: { id: ZENITH_GUILD_ID, ownerId: 'owner', roles: { cache: new Map([[ZENITH_VERIFIED_ROLE, roleObj]]) } },
      roles: { cache: new Map([[ZENITH_VERIFIER_ROLE, { id: ZENITH_VERIFIER_ROLE }]]) },
      permissions: { has: () => false },
    };

    const targetMember = {
      id: 'target2',
      roles: {
        cache: new Map(),
        add: async (role) => { addedRole = role; },
      },
    };

    await executeVerification({
      guild: verifierMember.guild,
      executorMember: verifierMember,
      targetMember,
      respond,
    });

    assert.equal(addedRole, roleObj);
    assert.equal(replied.content, TEXT.success('target2'));
  });
});
