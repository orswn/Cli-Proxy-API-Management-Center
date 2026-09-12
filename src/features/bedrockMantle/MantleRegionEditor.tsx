import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { authFilesApi } from '@/services/api/authFiles';
import { useAuthStore } from '@/stores';
import { validateMantleRegions, type MantleRegionSettings } from './regions';
import styles from './MantleRegionEditor.module.scss';

export function MantleRegionEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: MantleRegionSettings;
  onChange: (value: MantleRegionSettings) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const [catalog, setCatalog] = useState<{ connection: string; ids: string[]; failed: boolean }>();
  const connection = `${apiBase}:${managementKey}`;
  useEffect(() => {
    let active = true;
    void authFilesApi
      .getModelDefinitions('bedrock-mantle')
      .then((models) => {
        if (active) setCatalog({ connection, ids: models.map((model) => model.id), failed: false });
      })
      .catch(() => {
        if (active) setCatalog({ connection, ids: [], failed: true });
      });
    return () => {
      active = false;
    };
  }, [connection]);
  const error = validateMantleRegions(value);
  const models = catalog?.connection === connection ? catalog.ids : [];
  return (
    <fieldset className={styles.editor} disabled={disabled}>
      <legend>{t('mantle.region_settings')}</legend>
      <Input
        label={t('mantle.region')}
        value={value.defaultRegion}
        list={`${id}-regions`}
        onChange={(e) => onChange({ ...value, defaultRegion: e.target.value })}
        required
      />
      <datalist id={`${id}-regions`}>
        {['us-east-1', 'us-west-2', ...value.overrides.map((row) => row.region)]
          .filter((region, i, all) => region && all.indexOf(region) === i)
          .map((region) => (
            <option key={region} value={region} />
          ))}
      </datalist>
      <div className={styles.heading}>{t('mantle.region_overrides')}</div>
      <p className="hint">{t('mantle.region_overrides_hint')}</p>
      {catalog?.connection === connection && catalog.failed && (
        <p role="status" className="hint">
          {t('mantle.catalog_failed')}
        </p>
      )}
      <datalist id={`${id}-models`}>
        {models.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
      {value.overrides.map((row, index) => (
        <div className={styles.row} key={index}>
          <Input
            label={t('mantle.override_model', { number: index + 1 })}
            value={row.model}
            list={`${id}-models`}
            required
            onChange={(e) =>
              onChange({
                ...value,
                overrides: value.overrides.map((item, i) =>
                  i === index ? { ...item, model: e.target.value } : item
                ),
              })
            }
          />
          <Input
            label={t('mantle.override_region', { number: index + 1 })}
            value={row.region}
            list={`${id}-regions`}
            required
            onChange={(e) =>
              onChange({
                ...value,
                overrides: value.overrides.map((item, i) =>
                  i === index ? { ...item, region: e.target.value } : item
                ),
              })
            }
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              onChange({ ...value, overrides: value.overrides.filter((_, i) => i !== index) })
            }
          >
            {t('mantle.remove_override', { number: index + 1 })}
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        disabled={value.overrides.length >= 256}
        onClick={() =>
          onChange({
            ...value,
            overrides: [...value.overrides, { model: '', region: value.defaultRegion }],
          })
        }
      >
        {t('mantle.add_override')}
      </Button>
      {error && (
        <div role="alert" className="error-box">
          {t(error)}
        </div>
      )}
    </fieldset>
  );
}
