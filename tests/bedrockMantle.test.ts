import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import {
  bedrockMantleApi,
  normalizeMantleChoices,
  normalizeMantleCredential,
  normalizeMantleDevice,
} from '@/services/api/bedrockMantle';
import { normalizeAuthFilesResponse } from '@/services/api/authFiles';
import {
  buildMantleRegionPatch,
  readMantleRegions,
  serializeModelRegions,
  validateMantleRegions,
} from '@/features/bedrockMantle/regions';
import { deriveAuthFileIdentity } from '@/features/authFiles/identity';
import en from '@/i18n/locales/en.json';
import cn from '@/i18n/locales/zh-CN.json';
import tw from '@/i18n/locales/zh-TW.json';
import ru from '@/i18n/locales/ru.json';

const setup = {
  startUrl: 'https://example.awsapps.com/start',
  ssoRegion: 'us-east-1',
  prefix: 'work',
  region: 'us-west-2',
  roleArn: 'arn:aws:iam::123456789012:role/chained',
};
const device = {
  state: 'mantle-example',
  url: 'https://example.awsapps.com/start/#/device',
  user_code: 'ABCD-EFGH',
  expires_in: 600,
};

afterEach(() => {
  get?.mockRestore();
  post?.mockRestore();
  remove?.mockRestore();
});
let get: ReturnType<typeof spyOn<typeof apiClient, 'get'>> | undefined;
let post: ReturnType<typeof spyOn<typeof apiClient, 'postForm'>> | undefined;
let remove: ReturnType<typeof spyOn<typeof apiClient, 'delete'>> | undefined;

describe('Mantle management contracts', () => {
  test('starts SSO with region, prefix and optional chained role', async () => {
    get = spyOn(apiClient, 'get').mockResolvedValue(device);
    expect(await bedrockMantleApi.start(setup)).toEqual({
      state: device.state,
      url: device.url,
      userCode: device.user_code,
      expiresIn: 600,
    });
    expect(get).toHaveBeenCalledWith('/bedrock-mantle-auth-url', {
      params: {
        start_url: setup.startUrl,
        sso_region: setup.ssoRegion,
        prefix: 'work',
        region: 'us-west-2',
        role_arn: setup.roleArn,
      },
    });
  });
  test('reauthenticates using the filename, not copied credential secrets', async () => {
    get = spyOn(apiClient, 'get').mockResolvedValue(device);
    await bedrockMantleApi.start(setup, 'original.json');
    expect(get).toHaveBeenCalledWith('/bedrock-mantle-auth-url', {
      params: { auth_file: 'original.json' },
    });
  });
  test('posts static keys only in the body', async () => {
    post = spyOn(apiClient, 'postForm').mockResolvedValue({ status: 'ok' });
    await bedrockMantleApi.addKey({
      ...setup,
      accessKeyId: 'TEST-ID',
      secretAccessKey: 'TEST-SECRET',
      sessionToken: 'TEST-SESSION',
    });
    expect(post.mock.calls[0][0]).toBe('/bedrock-mantle-key');
    const body = post.mock.calls[0][1] as FormData;
    expect(body.get('secret_access_key')).toBe('TEST-SECRET');
    expect(body.get('role_arn')).toBe(setup.roleArn);
    expect(post.mock.calls[0].length).toBe(2);
  });
  test('sends model regions in SSO setup and static form', async () => {
    const modelRegions = { 'openai.gpt-5.6-luna': 'us-west-2' };
    get = spyOn(apiClient, 'get').mockResolvedValue(device);
    await bedrockMantleApi.start({ ...setup, modelRegions });
    expect(get.mock.calls[0][1]?.params.model_regions).toBe(JSON.stringify(modelRegions));
    post = spyOn(apiClient, 'postForm').mockResolvedValue({ status: 'ok' });
    await bedrockMantleApi.addKey({
      ...setup,
      modelRegions,
      accessKeyId: 'TEST',
      secretAccessKey: 'TEST',
      sessionToken: '',
    });
    expect((post.mock.calls[0][1] as FormData).get('model_regions')).toBe(
      JSON.stringify(modelRegions)
    );
    get.mockClear();
    await bedrockMantleApi.start({ ...setup, modelRegions }, 'original.json');
    expect(get.mock.calls[0][1]?.params).toEqual({ auth_file: 'original.json' });
  });
  test('region settings preserve canonical IDs and produce whole-map patches', () => {
    const original = {
      default_region: 'us-east-1',
      model_regions: { 'openai.gpt-5.6-luna': 'us-west-2' },
      access_token: 'SECRET',
    };
    const settings = readMantleRegions(original);
    expect(validateMantleRegions(settings)).toBeNull();
    expect(serializeModelRegions(settings.overrides)).toEqual(original.model_regions);
    expect(buildMantleRegionPatch(original, settings)).toEqual({});
    expect(buildMantleRegionPatch(original, { ...settings, overrides: [] })).toEqual({
      model_regions: {},
    });
    expect(buildMantleRegionPatch(original, { ...settings, defaultRegion: 'eu-west-1' })).toEqual({
      default_region: 'eu-west-1',
    });
    expect(normalizeMantleCredential(original)?.modelRegions).toEqual(original.model_regions);
  });
  test('rejects duplicate models, credential prefixes and malformed regions', () => {
    const settings = {
      defaultRegion: 'us-east-1',
      overrides: [{ model: 'openai.gpt-5.6-luna', region: 'us-west-2' }],
    };
    expect(validateMantleRegions({ ...settings, defaultRegion: 'bad' })).toBe(
      'mantle.invalid_region'
    );
    expect(
      validateMantleRegions({
        ...settings,
        overrides: [...settings.overrides, { model: 'openai.GPT-5.6-LUNA', region: 'us-east-1' }],
      })
    ).toBe('mantle.duplicate_model');
    expect(
      validateMantleRegions({
        ...settings,
        overrides: [{ model: 'work/openai.gpt-5.6-luna', region: 'us-west-2' }],
      })
    ).toBe('mantle.invalid_model');
    expect(
      validateMantleRegions({
        ...settings,
        overrides: [{ model: 'openai.gpt-5.6-luna', region: '' }],
      })
    ).toBe('mantle.invalid_region');
    expect(
      validateMantleRegions({
        ...settings,
        overrides: [{ model: 'openai.gpt-5.6-luna', region: 'https://example.com' }],
      })
    ).toBe('mantle.invalid_region');
    expect(readMantleRegions({})).toEqual({ defaultRegion: 'us-east-1', overrides: [] });
  });
  test('submits only the selected account or role', async () => {
    post = spyOn(apiClient, 'postForm').mockResolvedValue({ status: 'ok' });
    await bedrockMantleApi.select('state', { accountId: '123' });
    const account = post.mock.calls[0][1] as FormData;
    expect(account.get('state')).toBe('state');
    expect(account.get('account_id')).toBe('123');
    expect(account.has('role_name')).toBe(false);
    await bedrockMantleApi.select('state', { roleName: 'Bedrock' });
    const role = post.mock.calls[1][1] as FormData;
    expect(role.get('role_name')).toBe('Bedrock');
    expect(role.has('account_id')).toBe(false);
  });
  test('cancels the backend session', async () => {
    remove = spyOn(apiClient, 'delete').mockResolvedValue({ status: 'ok' });
    await bedrockMantleApi.cancel('state');
    expect(remove).toHaveBeenCalledWith('/oauth-session', { params: { state: 'state' } });
  });
  test('handles completion without requesting deleted choices', async () => {
    get = spyOn(apiClient, 'get').mockResolvedValue({ status: 'ok' });
    expect(await bedrockMantleApi.progress('state')).toEqual({ status: 'done' });
    expect(get).toHaveBeenCalledTimes(1);
  });
  test('handles the race between status polling and choice deletion', async () => {
    get = spyOn(apiClient, 'get')
      .mockResolvedValueOnce({ status: 'wait' })
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ status: 'ok' });
    expect(await bedrockMantleApi.progress('state')).toEqual({ status: 'done' });
  });
  test('surfaces expired or cancelled sessions', async () => {
    get = spyOn(apiClient, 'get').mockResolvedValue({
      status: 'error',
      error: 'unknown or expired state',
    });
    await expect(bedrockMantleApi.progress('state')).rejects.toThrow('unknown or expired state');
  });
  test('handles multiple accounts and roles', async () => {
    get = spyOn(apiClient, 'get')
      .mockResolvedValueOnce({ status: 'wait' })
      .mockResolvedValueOnce({
        status: 'select_account',
        accounts: [
          { id: '123', name: 'Example' },
          { id: '456', name: 'Other' },
        ],
      });
    expect(await bedrockMantleApi.progress('state')).toEqual({
      status: 'select_account',
      accounts: [
        { id: '123', name: 'Example' },
        { id: '456', name: 'Other' },
      ],
    });
    expect(
      normalizeMantleChoices({
        status: 'select_role',
        account_id: '123',
        roles: ['Bedrock', 'Admin'],
      })
    ).toEqual({ status: 'select_role', accountId: '123', roles: ['Bedrock', 'Admin'] });
    expect(() => normalizeMantleChoices({ status: 'select_account', accounts: [] })).toThrow();
    expect(normalizeMantleChoices({ status: 'pending' })).toEqual({ status: 'pending' });
  });
  test('rejects unsafe approval links and invalid device sessions', () => {
    for (const url of [
      'javascript:alert(1)',
      'http://example.test',
      'https://user:pass@example.test',
    ]) {
      expect(() => normalizeMantleDevice({ ...device, url })).toThrow();
    }
    expect(() => normalizeMantleDevice({ ...device, state: '' })).toThrow();
    expect(() => normalizeMantleDevice({ ...device, expires_in: 0 })).toThrow();
  });
  test('normalizes public metadata without credential secrets', () => {
    const raw = {
      auth_mode: 'sso',
      prefix: 'work',
      account_name: 'Example',
      role_name: 'Bedrock',
      default_region: 'us-west-2',
      expired: '2027-01-01T00:00:00Z',
      access_token: 'SECRET',
      secret_access_key: 'SECRET',
    };
    const normalized = normalizeMantleCredential(raw);
    expect(JSON.stringify(normalized)).not.toContain('SECRET');
    expect(normalized?.accountName).toBe('Example');
    const file = normalizeAuthFilesResponse({
      files: [{ name: 'mantle.json', type: 'bedrock-mantle', bedrock_mantle: raw }],
    }).files[0];
    expect(file.bedrockMantle).toEqual(normalized);
    expect(deriveAuthFileIdentity(file).primary).toBe('Example');
    expect(deriveAuthFileIdentity(file).kind).toBe('accountName');
    expect(normalizeMantleCredential(null)).toBeUndefined();
  });
  test('all locales include the wizard labels', () => {
    for (const locale of [cn, tw, ru]) {
      expect(Object.keys(locale.mantle).sort()).toEqual(Object.keys(en.mantle).sort());
      expect(Object.values(locale.mantle).every(Boolean)).toBe(true);
    }
  });
});
