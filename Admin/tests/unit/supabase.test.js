'use strict';

const supabaseProvider = require('../../src/providers/supabase');

const { verifyPasswordCredentials, setMockSupabaseClient, resetSupabaseClient } = supabaseProvider;

const {
  createPresignedUploadUrl,
  createPresignedDownloadUrl,
  getPublicUrl,
  setMockStorageProvider,
  resetMockStorageProvider,
} = require('../../src/providers/supabase-storage');

describe('Unit: Supabase Provider Integration', () => {
  afterEach(() => {
    resetSupabaseClient();
    resetMockStorageProvider();
  });

  describe('Admin auth surface', () => {
    it('no longer exposes Supabase JWT verification or phone OTP helpers', () => {
      expect(supabaseProvider.verifySupabaseToken).toBeUndefined();
      expect(supabaseProvider.sendPhoneOtp).toBeUndefined();
      expect(supabaseProvider.verifyPhoneOtp).toBeUndefined();
    });
  });

  describe('verifyPasswordCredentials (legacy admin password migration only)', () => {
    it('returns the Supabase user id when the password is accepted', async () => {
      const signInWithPassword = jest.fn().mockResolvedValue({ data: { user: { id: 'sup-1' } }, error: null });
      setMockSupabaseClient({ auth: { signInWithPassword } });
      await expect(verifyPasswordCredentials({ email: 'a@x.com', password: 'pw' }))
        .resolves.toEqual({ valid: true, userId: 'sup-1' });
    });

    it('rejects wrong or missing credentials', async () => {
      setMockSupabaseClient({
        auth: { signInWithPassword: jest.fn().mockResolvedValue({ data: { user: null }, error: { message: 'bad' } }) },
      });
      await expect(verifyPasswordCredentials({ email: 'a@x.com', password: 'nope' }))
        .resolves.toEqual({ valid: false, userId: null });
      await expect(verifyPasswordCredentials({ email: '', password: 'x' }))
        .resolves.toEqual({ valid: false, userId: null });
    });
  });

  describe('Supabase Storage Provider', () => {
    it('generates a presigned upload URL', async () => {
      const result = await createPresignedUploadUrl({
        bucket: 'gongo-uploads',
        path: 'test/kyc.pdf',
      });
      expect(result.uploadUrl).toBeDefined();
      expect(result.path).toBe('test/kyc.pdf');
    });

    it('generates a presigned download URL', async () => {
      const result = await createPresignedDownloadUrl({
        bucket: 'gongo-uploads',
        path: 'test/kyc.pdf',
        expiresInSeconds: 600,
      });
      expect(result.downloadUrl).toBeDefined();
    });

    it('generates a public URL', () => {
      const url = getPublicUrl('assets/logo.png', 'public-assets');
      expect(url).toContain('public-assets/assets/logo.png');
    });
  });
});
