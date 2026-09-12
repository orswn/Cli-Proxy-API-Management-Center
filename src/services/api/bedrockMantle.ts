import { apiClient } from './client';
import { readModelRegions } from '@/features/bedrockMantle/regions';
import { isRecord } from '@/utils/helpers';

export interface MantleSetup {
  startUrl: string;
  ssoRegion: string;
  prefix: string;
  region: string;
  roleArn: string;
  modelRegions?: Record<string, string>;
}

export interface MantleKey extends Pick<
  MantleSetup,
  'prefix' | 'region' | 'roleArn' | 'modelRegions'
> {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export interface MantleDevice {
  state: string;
  url: string;
  userCode: string;
  expiresIn: number;
}

export interface MantleAccount {
  id: string;
  name: string;
}

export type MantleProgress =
  | { status: 'pending' | 'done' }
  | { status: 'select_account'; accounts: MantleAccount[] }
  | { status: 'select_role'; roles: string[]; accountId: string };

export interface MantleCredential {
  mode: string;
  prefix: string;
  accountId: string;
  accountName: string;
  roleName: string;
  roleArn: string;
  region: string;
  expiresAt: string;
  modelRegions: Record<string, string>;
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export function normalizeMantleCredential(value: unknown): MantleCredential | undefined {
  if (!isRecord(value)) return undefined;
  return {
    mode: text(value.auth_mode),
    prefix: text(value.prefix),
    accountId: text(value.account_id),
    accountName: text(value.account_name),
    roleName: text(value.role_name),
    roleArn: text(value.role_arn),
    region: text(value.default_region),
    expiresAt: text(value.expired),
    modelRegions: readModelRegions(value.model_regions),
  };
}

export function normalizeMantleDevice(value: unknown): MantleDevice {
  if (!isRecord(value)) throw new Error('Invalid device authorization response');
  const state = text(value.state);
  const userCode = text(value.user_code);
  const url = new URL(text(value.url));
  if (url.protocol !== 'https:' || url.username || url.password || !state || !userCode) {
    throw new Error('Invalid device authorization response');
  }
  const expiresIn = Number(value.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('Invalid device authorization expiry');
  }
  return { state, userCode, url: url.href, expiresIn };
}

export function normalizeMantleChoices(value: unknown): MantleProgress {
  if (!isRecord(value)) throw new Error('Invalid account selection response');
  if (value.status === 'pending') return { status: 'pending' };
  if (value.status === 'done') return { status: 'done' };
  if (value.status === 'select_account' && Array.isArray(value.accounts)) {
    const accounts = value.accounts
      .filter(isRecord)
      .map((account) => ({
        id: text(account.id),
        name: text(account.name),
      }))
      .filter((account) => account.id);
    if (accounts.length) return { status: 'select_account', accounts };
  }
  if (value.status === 'select_role' && Array.isArray(value.roles)) {
    const roles = value.roles.map(text).filter(Boolean);
    if (roles.length) return { status: 'select_role', roles, accountId: text(value.account_id) };
  }
  throw new Error('No AWS accounts or roles are available');
}

function form(values: Record<string, string>) {
  const body = new FormData();
  Object.entries(values).forEach(([key, value]) => body.append(key, value.trim()));
  return body;
}

export const bedrockMantleApi = {
  async start(setup: MantleSetup, authFile?: string): Promise<MantleDevice> {
    const params = authFile
      ? { auth_file: authFile }
      : {
          start_url: setup.startUrl.trim(),
          sso_region: setup.ssoRegion.trim(),
          prefix: setup.prefix.trim(),
          region: setup.region.trim(),
          role_arn: setup.roleArn.trim(),
          ...(setup.modelRegions ? { model_regions: JSON.stringify(setup.modelRegions) } : {}),
        };
    return normalizeMantleDevice(await apiClient.get('/bedrock-mantle-auth-url', { params }));
  },
  async progress(state: string): Promise<MantleProgress> {
    const status = await apiClient.get<{ status: string; error?: string }>('/get-auth-status', {
      params: { state },
    });
    if (status.status === 'ok') return { status: 'done' };
    if (status.status === 'error') throw new Error(status.error || 'Authentication failed');
    try {
      return normalizeMantleChoices(
        await apiClient.get('/bedrock-mantle-choices', {
          params: { state },
        })
      );
    } catch (error) {
      // The backend removes choices immediately after saving the credential.
      if (isRecord(error) && error.status === 404) {
        const final = await apiClient.get<{ status: string; error?: string }>('/get-auth-status', {
          params: { state },
        });
        if (final.status === 'ok') return { status: 'done' };
        if (final.status === 'error') {
          const failure = Object.assign(new Error(final.error || 'Authentication failed'), {
            cause: error,
          });
          throw failure;
        }
      }
      throw error;
    }
  },
  select: (state: string, selection: { accountId: string } | { roleName: string }) =>
    apiClient.postForm(
      '/bedrock-mantle-select',
      form({
        state,
        ...('accountId' in selection
          ? { account_id: selection.accountId }
          : { role_name: selection.roleName }),
      })
    ),
  cancel: (state: string) => apiClient.delete('/oauth-session', { params: { state } }),
  addKey: (key: MantleKey) =>
    apiClient.postForm(
      '/bedrock-mantle-key',
      form({
        access_key_id: key.accessKeyId,
        secret_access_key: key.secretAccessKey,
        session_token: key.sessionToken,
        prefix: key.prefix,
        region: key.region,
        role_arn: key.roleArn,
        ...(key.modelRegions ? { model_regions: JSON.stringify(key.modelRegions) } : {}),
      })
    ),
};
