import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import type { MantleCredential } from '@/services/api/bedrockMantle';
import { MantleWizard } from './MantleWizard';
import styles from './MantleWizard.module.scss';

export function MantleCredentialDetails({
  credential,
  fileName,
  disabled,
}: {
  credential: MantleCredential;
  fileName: string;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const expires = new Date(credential.expiresAt);
  const rows = [
    ['prefix', credential.prefix],
    ['account', credential.accountName || credential.accountId],
    ['role', credential.roleName],
    ['role_arn', credential.roleArn],
    ['region', credential.region],
    ['expires', Number.isNaN(expires.getTime()) ? '' : expires.toLocaleString()],
  ];
  return (
    <>
      <dl className={styles.details}>
        {rows
          .filter(([, value]) => value)
          .map(([key, value]) => (
            <div key={key} style={{ display: 'contents' }}>
              <dt>{t(`mantle.${key}`)}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        {Object.entries(credential.modelRegions).map(([model, region]) => (
          <div key={model} style={{ display: 'contents' }}>
            <dt>{model}</dt>
            <dd>{region}</dd>
          </div>
        ))}
      </dl>
      {credential.mode === 'sso' && (
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)} disabled={disabled}>
          {t('mantle.reauthenticate')}
        </Button>
      )}
      {open && <MantleWizard authFile={fileName} onClose={() => setOpen(false)} />}
    </>
  );
}
