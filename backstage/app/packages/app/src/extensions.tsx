import React, { useEffect, useState } from 'react';
import { createFrontendPlugin, PageBlueprint, NavItemBlueprint, createRouteRef } from '@backstage/frontend-plugin-api';
import { useApi, fetchApiRef, configApiRef } from '@backstage/core-plugin-api';
import {
  Content,
  Header,
  Page,
  Progress,
  Table,
  TableColumn,
} from '@backstage/core-components';
import AttachMoneyIcon from '@material-ui/icons/AttachMoney';

// ── FinOps / Cost Overview page ───────────────────────────────────────────────
// Queries OpenCost via the Backstage proxy (/api/proxy/opencost).
// Falls back gracefully when OpenCost is unreachable.

interface AllocationRow {
  namespace: string;
  totalCost: string;
  cpuCost: string;
  ramCost: string;
}

const COLUMNS: TableColumn<AllocationRow>[] = [
  { title: 'Namespace', field: 'namespace' },
  { title: 'Total Cost (USD)', field: 'totalCost' },
  { title: 'CPU Cost (USD)', field: 'cpuCost' },
  { title: 'RAM Cost (USD)', field: 'ramCost' },
];

function FinOpsPage() {
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const [rows, setRows] = useState<AllocationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const baseUrl = configApi.getString('backend.baseUrl');
    const url =
      `${baseUrl}/api/proxy/opencost/allocation/compute` +
      `?window=7d&aggregate=namespace&accumulate=true`;

    fetchApi
      .fetch(url)
      .then(r => {
        if (!r.ok) throw new Error(`OpenCost returned ${r.status}`);
        return r.json();
      })
      .then((data: any) => {
        const allocations: Record<string, any> = data?.data?.[0] ?? {};
        setRows(
          Object.entries(allocations).map(([namespace, info]) => ({
            namespace,
            totalCost: ((info as any).totalCost ?? 0).toFixed(4),
            cpuCost: ((info as any).cpuCost ?? 0).toFixed(4),
            ramCost: ((info as any).ramCost ?? 0).toFixed(4),
          })),
        );
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [fetchApi, configApi]);

  return (
    <Page themeId="tool">
      <Header
        title="FinOps — Cost Overview"
        subtitle="7-day spend by namespace · powered by OpenCost"
      />
      <Content>
        {loading && <Progress />}
        {!loading && error && (
          <p>
            Cost data unavailable: <strong>{error}</strong>. Ensure the OpenCost
            pod is running (<code>kubectl get po -n finops</code>) and the
            <code>/opencost</code> proxy is configured in{' '}
            <code>app-config.yaml</code>.
          </p>
        )}
        {!loading && !error && rows.length === 0 && (
          <p>No allocation data returned by OpenCost for the last 7 days.</p>
        )}
        {!loading && !error && rows.length > 0 && (
          <Table<AllocationRow>
            title="Cost by Namespace — last 7 days"
            options={{ search: false, paging: false }}
            columns={COLUMNS}
            data={rows}
          />
        )}
      </Content>
    </Page>
  );
}

const finOpsRouteRef = createRouteRef();

const finOpsPage = PageBlueprint.make({
  name: 'finops',
  params: {
    path: '/finops',
    routeRef: finOpsRouteRef,
    loader: async () => <FinOpsPage />,
  },
});

const finOpsNavItem = NavItemBlueprint.make({
  name: 'finops',
  params: {
    title: 'Cost Overview',
    icon: AttachMoneyIcon as any,
    routeRef: finOpsRouteRef,
  },
});

// ── Plugin registration ────────────────────────────────────────────────────────
export const customPagesPlugin = createFrontendPlugin({
  id: 'custom-pages',
  routes: {
    root: finOpsRouteRef,
  },
  extensions: [finOpsPage, finOpsNavItem],
});
