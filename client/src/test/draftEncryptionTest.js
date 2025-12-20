/**
 * Test script for draft encryption/decryption
 * This can be run in the browser console to test the encryption flow
 */

import { encryptDraft, decryptDraft, DRAFT_ENCRYPTION_SCHEMA } from '../utils/draftEncryption.js';

export async function testDraftEncryption(nostr, pubkey) {
  console.log('[test] Starting draft encryption test...');

  // Test data
  const testDraft = {
    id: 'test-draft-id-123',
    content: 'This is a test draft with sensitive content that should be encrypted!',
    tags: '#test #encryption',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  try {
    // 1. Encrypt the draft
    console.log('[test] Encrypting draft...');
    const ciphertext = await encryptDraft(nostr, pubkey, testDraft);
    console.log('[test] Encrypted ciphertext:', ciphertext.substring(0, 100) + '...');

    // 2. Decrypt the draft
    console.log('[test] Decrypting draft...');
    const decrypted = await decryptDraft(nostr, pubkey, ciphertext);
    console.log('[test] Decrypted data:', decrypted);

    // 3. Verify the decrypted data matches original
    const isMatch = (
      decrypted.id === testDraft.id &&
      decrypted.content === testDraft.content &&
      decrypted.tags === testDraft.tags
    );

    console.log('[test] Verification:', isMatch ? '✅ SUCCESS' : '❌ FAILED');

    if (!isMatch) {
      console.error('[test] Original:', testDraft);
      console.error('[test] Decrypted:', decrypted);
    }

    // 4. Test that invalid data is rejected
    console.log('[test] Testing invalid ciphertext...');
    const invalidResult = await decryptDraft(nostr, pubkey, 'invalid-ciphertext');
    console.log('[test] Invalid result (should be null):', invalidResult);

    return isMatch;
  } catch (error) {
    console.error('[test] Test failed with error:', error);
    return false;
  }
}

// Export for use in browser console
if (typeof window !== 'undefined') {
  window.testDraftEncryption = testDraftEncryption;
  console.log('[test] testDraftEncryption function available. Run: testDraftEncryption(window.nostr, window.userPubkey)');
}