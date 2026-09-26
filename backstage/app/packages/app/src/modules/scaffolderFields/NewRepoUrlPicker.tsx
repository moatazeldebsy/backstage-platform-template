import { createElement } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  getComponentData,
} from '@backstage/core-plugin-api';
import { RepoUrlPickerFieldExtension } from '@backstage/plugin-scaffolder';
import type { CustomFieldValidator, FieldExtensionOptions } from '@backstage/plugin-scaffolder-react';
import { createFormField } from '@backstage/plugin-scaffolder-react/alpha';
import { newRepoNameError, RepoStatus } from './repoNameCheck';

// The stock RepoUrlPicker's component, schema and validation. They are not
// importable directly (the package's `exports` only allow the top-level and
// /alpha entries), but every legacy field extension carries them as component
// data under this key — the same lookup the scaffolder itself uses.
const FIELD_EXTENSION_KEY = 'scaffolder.extensions.field.v1';
const stock = getComponentData<FieldExtensionOptions<string>>(
  createElement(RepoUrlPickerFieldExtension),
  FIELD_EXTENSION_KEY,
);
if (!stock) {
  throw new Error('NewRepoUrlPicker: could not read the stock RepoUrlPicker field extension');
}

const validation: CustomFieldValidator<string> = async (value, field, context) => {
  // Keep every check the stock picker makes (allowed hosts/owners, required
  // parts), then add ours.
  await stock.validation?.(value, field, context);

  const error = await newRepoNameError(value, async (repoUrl): Promise<RepoStatus> => {
    const baseUrl = await context.apiHolder.get(discoveryApiRef)!.getBaseUrl('idp-repo-check');
    const res = await context.apiHolder
      .get(fetchApiRef)!
      .fetch(`${baseUrl}/status?repoUrl=${encodeURIComponent(repoUrl)}`);
    if (!res.ok) return 'unknown';
    return ((await res.json()).status as RepoStatus) ?? 'unknown';
  });
  if (error) field.addError(error);
};

/**
 * RepoUrlPicker for templates that CREATE a repository: same picker, plus a
 * check (on Next) that the name is not already taken. Templates that open a PR
 * against an existing repository must keep the stock RepoUrlPicker.
 */
export const NewRepoUrlPicker = createFormField({
  name: 'NewRepoUrlPicker',
  component: stock.component as any,
  schema: stock.schema as any,
  validation: validation as any,
});
