import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuthStore, useNotificationStore } from '@/stores';
import { notifyAuthFilesChanged } from '@/features/authFiles/authFilesEvents';
import {
  bedrockMantleApi,
  type MantleDevice,
  type MantleProgress,
  type MantleSetup,
} from '@/services/api/bedrockMantle';
import { getErrorMessage } from '@/utils/helpers';
import { copyToClipboard } from '@/utils/clipboard';
import { MantleRegionEditor } from './MantleRegionEditor';
import { serializeModelRegions, validateMantleRegions, type MantleRegionRow } from './regions';
import styles from './MantleWizard.module.scss';

interface Props {
  onClose: () => void;
  authFile?: string;
}

type Phase = 'setup' | 'starting' | 'waiting' | 'selecting' | 'saving' | 'done' | 'error';

export function MantleWizard({ onClose, authFile }: Props) {
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  return (
    <MantleWizardSession
      key={`${apiBase}:${managementKey}`}
      onClose={onClose}
      authFile={authFile}
    />
  );
}

function MantleWizardSession({ onClose, authFile }: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'sso' | 'static'>('sso');
  const [setup, setSetup] = useState<MantleSetup>({
    startUrl: '',
    ssoRegion: 'us-east-1',
    prefix: '',
    region: 'us-east-1',
    roleArn: '',
  });
  const [overrides, setOverrides] = useState<MantleRegionRow[]>([]);
  const regionError = validateMantleRegions({ defaultRegion: setup.region, overrides });
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [phase, setPhase] = useState<Phase>('setup');
  const [device, setDevice] = useState<MantleDevice>();
  const [progress, setProgress] = useState<MantleProgress>({ status: 'pending' });
  const [selection, setSelection] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const active = useRef(false);
  const session = useRef('');
  const deadline = useRef(0);
  const connection = useRef(useAuthStore.getState());

  const sameConnection = useCallback(() => {
    const current = useAuthStore.getState();
    return (
      current.apiBase === connection.current.apiBase &&
      current.managementKey === connection.current.managementKey
    );
  }, []);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (session.current && sameConnection()) {
        void bedrockMantleApi.cancel(session.current).catch((cause) => {
          useNotificationStore.getState().showNotification(getErrorMessage(cause), 'error');
        });
      }
    };
  }, [sameConnection]);

  useEffect(() => {
    if (phase !== 'waiting' || !device) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (Date.now() >= deadline.current) throw new Error(t('mantle.expired'));
        const next = await bedrockMantleApi.progress(device.state);
        if (cancelled || !active.current || !sameConnection()) return;
        setProgress(next);
        if (next.status === 'done') {
          session.current = '';
          setPhase('done');
          notifyAuthFilesChanged();
        } else if (next.status === 'select_account' || next.status === 'select_role') {
          setSelection('');
          setPhase('selecting');
        } else {
          timer = setTimeout(() => void poll(), 2000);
        }
      } catch (cause) {
        if (cancelled || !active.current) return;
        setError(getErrorMessage(cause));
        setPhase('error');
      }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, device, t, sameConnection]);

  const start = async () => {
    setError('');
    setPhase('starting');
    try {
      const next = await bedrockMantleApi.start(
        { ...setup, modelRegions: serializeModelRegions(overrides) },
        authFile
      );
      if (!active.current) {
        if (sameConnection()) await bedrockMantleApi.cancel(next.state);
        return;
      }
      session.current = next.state;
      deadline.current = Date.now() + next.expiresIn * 1000;
      setDevice(next);
      setPhase('waiting');
    } catch (cause) {
      if (active.current) {
        setError(getErrorMessage(cause));
        setPhase('error');
      }
    }
  };

  const select = async () => {
    if (!device || !selection) return;
    setPhase('saving');
    try {
      await bedrockMantleApi.select(
        device.state,
        progress.status === 'select_account' ? { accountId: selection } : { roleName: selection }
      );
      if (active.current) {
        // Account selection can outlive the device approval window.
        deadline.current = Date.now() + 5 * 60 * 1000;
        setPhase('waiting');
      }
    } catch (cause) {
      if (active.current) {
        setError(getErrorMessage(cause));
        setPhase('error');
      }
    }
  };

  const saveKey = async () => {
    setPhase('saving');
    setError('');
    try {
      await bedrockMantleApi.addKey({
        ...setup,
        modelRegions: serializeModelRegions(overrides),
        accessKeyId,
        secretAccessKey,
        sessionToken,
      });
      if (active.current) {
        setAccessKeyId('');
        setSecretAccessKey('');
        setSessionToken('');
        setPhase('done');
        notifyAuthFilesChanged();
      }
    } catch (cause) {
      if (active.current) {
        setError(getErrorMessage(cause));
        setPhase('error');
      }
    }
  };

  const close = async () => {
    if (session.current) {
      try {
        await bedrockMantleApi.cancel(session.current);
        session.current = '';
      } catch (cause) {
        setError(`${t('mantle.cancel_failed')} ${getErrorMessage(cause)}`);
        return;
      }
    }
    onClose();
  };
  const busy = phase === 'starting' || phase === 'saving';
  const editable = phase === 'setup' || (phase === 'error' && !device);
  const field = (key: Exclude<keyof MantleSetup, 'modelRegions'>, label: string, hint?: string) => (
    <Input
      label={t(`mantle.${label}`)}
      hint={hint && t(`mantle.${hint}`)}
      value={setup[key]}
      disabled={!editable}
      onChange={(event) => setSetup((previous) => ({ ...previous, [key]: event.target.value }))}
      required={key === 'startUrl' || key === 'region' || key === 'ssoRegion'}
      type={key === 'startUrl' ? 'url' : 'text'}
      pattern={key === 'startUrl' ? 'https://.+' : key === 'prefix' ? '[^/\\s]*' : undefined}
    />
  );

  return (
    <Modal
      open
      title={t(authFile ? 'mantle.reauthenticate' : 'mantle.title')}
      onClose={() => void close()}
      width={640}
      closeDisabled={busy}
      footer={
        <Button variant="secondary" onClick={() => void close()} disabled={busy}>
          {t(phase === 'done' ? 'common.close' : 'common.cancel')}
        </Button>
      }
    >
      <div className={styles.wizard}>
        <p className="hint">{t('mantle.description')}</p>
        {authFile && <p className={styles.filename}>{authFile}</p>}
        <ol className={styles.steps} aria-label={t('mantle.steps')}>
          {[
            t('mantle.setup'),
            t('mantle.approve'),
            t('mantle.account_role'),
            t('mantle.saved'),
          ].map((label, index) => (
            <li
              key={label}
              aria-current={
                index ===
                (phase === 'done' ? 3 : phase === 'selecting' ? 2 : phase === 'waiting' ? 1 : 0)
                  ? 'step'
                  : undefined
              }
            >
              {label}
            </li>
          ))}
        </ol>
        {error && (
          <div role="alert" className="error-box">
            {error}
          </div>
        )}
        {phase === 'done' ? (
          <div role="status" className="status-badge success">
            {t('mantle.success')}
          </div>
        ) : (
          <>
            {(editable || phase === 'starting') && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!authFile && regionError) return;
                  void (mode === 'static' ? saveKey() : start());
                }}
              >
                {!authFile && (
                  <>
                    <fieldset className={styles.modes} disabled={!editable}>
                      <legend>{t('mantle.method')}</legend>
                      <label>
                        <input
                          type="radio"
                          name="mantle-mode"
                          checked={mode === 'sso'}
                          onChange={() => setMode('sso')}
                        />
                        {t('mantle.sso')}
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="mantle-mode"
                          checked={mode === 'static'}
                          onChange={() => setMode('static')}
                        />
                        {t('mantle.static')}
                      </label>
                    </fieldset>
                    {mode === 'sso' && field('startUrl', 'start_url')}
                    {field('prefix', 'prefix', 'prefix_hint')}
                    {mode === 'static' && (
                      <>
                        <Input
                          label={t('mantle.access_key')}
                          value={accessKeyId}
                          onChange={(e) => setAccessKeyId(e.target.value)}
                          required
                          autoComplete="off"
                        />
                        <Input
                          label={t('mantle.secret_key')}
                          value={secretAccessKey}
                          onChange={(e) => setSecretAccessKey(e.target.value)}
                          required
                          type="password"
                          autoComplete="new-password"
                        />
                        <Input
                          label={t('mantle.session_token')}
                          value={sessionToken}
                          onChange={(e) => setSessionToken(e.target.value)}
                          type="password"
                          autoComplete="new-password"
                        />
                      </>
                    )}
                    <MantleRegionEditor
                      value={{ defaultRegion: setup.region, overrides }}
                      disabled={!editable}
                      onChange={(value) => {
                        setSetup((previous) => ({ ...previous, region: value.defaultRegion }));
                        setOverrides(value.overrides);
                      }}
                    />
                    <details className={styles.advanced}>
                      <summary>{t('mantle.advanced')}</summary>
                      {mode === 'sso' && field('ssoRegion', 'sso_region')}
                      {field('roleArn', 'role_arn', 'role_arn_hint')}
                    </details>
                  </>
                )}
                <Button
                  type="submit"
                  loading={phase === 'starting'}
                  disabled={!editable || (!authFile && Boolean(regionError))}
                >
                  {t(mode === 'static' ? 'common.save' : 'mantle.start')}
                </Button>
              </form>
            )}
            {device && phase === 'waiting' && progress.status === 'pending' && (
              <section className={styles.device}>
                <p>{t('mantle.device_hint')}</p>
                <code className={styles.code}>{device.userCode}</code>
                <div className={styles.actions}>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void copyToClipboard(device.userCode).then((ok) => {
                        setCopied(ok);
                        if (!ok) setError(t('mantle.copy_failed'));
                      })
                    }
                  >
                    {t(copied ? 'mantle.copied' : 'mantle.copy_code')}
                  </Button>
                  <a href={device.url} target="_blank" rel="noopener noreferrer">
                    {t('mantle.open_aws')}
                  </a>
                </div>
                <p role="status" className="hint">
                  {t('mantle.waiting')}
                </p>
                <p className="hint">{t('mantle.auto_select')}</p>
              </section>
            )}
            {phase === 'selecting' &&
              (progress.status === 'select_account' || progress.status === 'select_role') && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void select();
                  }}
                >
                  <label className={styles.choice}>
                    {t(progress.status === 'select_account' ? 'mantle.account' : 'mantle.role')}
                    <select
                      className="input"
                      value={selection}
                      onChange={(event) => setSelection(event.target.value)}
                      required
                    >
                      <option value="">{t('mantle.choose')}</option>
                      {progress.status === 'select_account'
                        ? progress.accounts.map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.name || account.id} · {account.id}
                            </option>
                          ))
                        : progress.roles.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                    </select>
                  </label>
                  <Button type="submit" disabled={!selection}>
                    {t('mantle.continue')}
                  </Button>
                </form>
              )}
            {phase === 'saving' && <p role="status">{t('mantle.saving')}</p>}
            {phase === 'error' && device && (
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    await bedrockMantleApi.cancel(session.current);
                    session.current = '';
                    setDevice(undefined);
                    setProgress({ status: 'pending' });
                    setPhase('setup');
                    setError('');
                  } catch (cause) {
                    setError(getErrorMessage(cause));
                  }
                }}
              >
                {t('mantle.restart')}
              </Button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
