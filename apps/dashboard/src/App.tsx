import { useEffect, useMemo, useState, type ReactNode } from 'react';

type View = 'overview' | 'projects' | 'deployments' | 'releases';
type State = 'loading' | 'ready' | 'error';
type Stream = 'connecting' | 'live' | 'reconnecting' | 'unavailable';
type Page<T> = { items: T[]; nextCursor: string | null };
type Project = {
  id: string;
  provider: string;
  owner: string;
  repository: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
};
type Deployment = {
  id: string;
  projectId: string;
  provider: string;
  commitSha: string;
  status: string;
  stage: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};
type Health = { statusCode: number; attempts: number; completedAt: string };
type Detail = Deployment & {
  ci?: {
    status: string;
    startedAt?: string;
    finishedAt?: string;
    failureKind?: string;
    steps: {
      stage: string;
      status: string;
      startedAt?: string;
      finishedAt?: string;
      durationMs?: number;
      exitCode?: number;
    }[];
  };
  release?: {
    status: string;
    releaseId: string;
    startedAt?: string;
    finishedAt?: string;
    failureKind?: string;
    success?: {
      releaseId: string;
      commitSha: string;
      completedAt: string;
      nginx: { validated: boolean; reloaded: boolean };
    };
    health?: Health;
    rollback?: {
      mode: string;
      outcome: string;
      targetDeploymentId: string;
      targetReleaseId: string;
      targetCommitSha: string;
      health?: Health;
      completedAt: string;
    };
    manualRollback?: {
      status: string;
      targetDeploymentId: string;
      startedAt: string;
      finishedAt?: string;
    };
  };
  activity: { kind: string; label: string; occurredAt: string; outcome?: string }[];
};

const format = (value?: string) =>
  value
    ? value
        .toLowerCase()
        .replaceAll('_', ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
    : 'Unavailable';
const date = (value?: string) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value))
    : 'Unavailable';
const sha = (value?: string) => (value ? value.slice(0, 8) : 'Unavailable');
const query = (cursor: string | null) =>
  '?limit=25' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
const tone = (value?: string) =>
  !value
    ? 'neutral'
    : ['SUCCESS', 'PASSED', 'HEALTHY', 'DEPLOYED', 'RESTORED'].includes(value)
      ? 'success'
      : ['FAILED', 'UNHEALTHY', 'ERROR'].includes(value)
        ? 'danger'
        : ['RUNNING', 'IN_PROGRESS'].includes(value)
          ? 'progress'
          : 'neutral';

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    signal: signal ?? null,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? 'This record is no longer available.'
        : 'Request failed (' + response.status + ').',
    );
  return response.json() as Promise<T>;
}

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    overview: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    projects: (
      <>
        <path d="m12 2 9 5-9 5-9-5 9-5Z" />
        <path d="m3 7 9 5 9-5M3 7v10l9 5 9-5V7M12 12v10" />
      </>
    ),
    deployments: (
      <>
        <path d="M4 17h16M12 3l5 9-5-2-5 2 5-9ZM12 10v7" />
        <path d="M6 21h12" />
      </>
    ),
    releases: (
      <>
        <path d="M3 7h18M5 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7M9 12h6" />
      </>
    ),
    search: (
      <>
        <circle cx="10.8" cy="10.8" r="6.8" />
        <path d="m16 16 5 5" />
      </>
    ),
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    activity: <path d="M2 12h4l3-8 5 16 3-8h5" />,
    refresh: (
      <>
        <path d="M20 11a8 8 0 1 0-2 6" />
        <path d="M20 4v7h-7" />
      </>
    ),
    check: <path d="m4 12 5 5L20 6" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function Brand() {
  return (
    <div className="brand">
      <svg className="brand-mark" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#3b82f6" d="m4 16 12 5 13-8 7 3 8-9v10l-8 8-7-4-13 9-12-5z" />
        <path fill="#536478" d="m4 28 12 6 17-11 11 5v6L32 30 16 41 4 35z" />
        <path fill="#111827" d="m4 37 12 6 16-10 12 4v5l-12-3-16 9-12-6z" />
      </svg>
      <span>ReleaseDeck</span>
    </div>
  );
}
function Badge({ value }: { value?: string | undefined }) {
  return (
    <span className={'badge ' + tone(value)}>
      <span className="badge-dot" />
      {format(value)}
    </span>
  );
}
function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty">
      <span className="empty-mark">
        <Icon name="projects" size={26} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="error" role="alert">
      <strong>Could not load this view</strong>
      <p>{message}</p>
      <button className="button" onClick={retry}>
        <Icon name="refresh" size={16} /> Try again
      </button>
    </div>
  );
}
function Heading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
function Pager({
  page,
  previous,
  next,
}: {
  page: number;
  previous: () => void;
  next?: (() => void) | undefined;
}) {
  return (
    <div className="pager">
      <span>Page {page + 1} · Up to 25 records per page</span>
      <div>
        <button className="button" disabled={!page} onClick={previous}>
          Previous
        </button>
        <button className="button" disabled={!next} onClick={next}>
          Next <Icon name="chevron" size={14} />
        </button>
      </div>
    </div>
  );
}
function Metric({
  icon,
  label,
  value,
}: {
  icon: string;
  label: string;
  value: string;
}) {
  return (
    <div className="metric card">
      <span className="metric-mark">
        <Icon name={icon} size={23} />
      </span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}
function SectionTitle({
  icon,
  title,
  action,
}: {
  icon: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-title">
      <div>
        <Icon name={icon} />
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}
function Field({ label, value }: { label: string; value?: ReactNode }) {
  return (
    <div className="field">
      <span>{label}</span>
      <strong>{value ?? 'Unavailable'}</strong>
    </div>
  );
}
function Pipeline({ detail }: { detail: Detail }) {
  const ciRunning = ['CHECKOUT', 'INSTALL', 'TEST', 'BUILD'].includes(detail.stage);
  const steps = [
    { label: 'Queued', done: true, current: detail.stage === 'QUEUED' },
    { label: 'CI', done: detail.ci?.status === 'PASSED', current: ciRunning },
    {
      label: 'Release',
      done: Boolean(detail.release?.success),
      current: detail.stage === 'DEPLOY',
    },
    {
      label: 'Health gate',
      done: Boolean(detail.release?.health),
      current: detail.stage === 'HEALTH_CHECK',
    },
    {
      label: 'Promotion',
      done: Boolean(detail.release?.success),
      current: detail.stage === 'PROMOTE',
    },
    ...(detail.stage === 'ROLLBACK' ||
    detail.release?.rollback ||
    detail.release?.manualRollback
      ? [
          {
            label: 'Rollback',
            done: Boolean(
              detail.release?.rollback?.completedAt ||
              detail.release?.manualRollback?.finishedAt,
            ),
            current: detail.stage === 'ROLLBACK',
          },
        ]
      : []),
  ];
  return (
    <div className="pipeline" aria-label={'Deployment stage ' + format(detail.stage)}>
      {steps.map((step, position) => (
        <div
          className={
            'pipeline-step ' + (step.current ? 'current' : step.done ? 'done' : '')
          }
          key={step.label}
        >
          <span>
            {step.done && !step.current ? (
              <Icon name="check" size={12} />
            ) : (
              position + 1
            )}
          </span>
          <small>{step.label}</small>
        </div>
      ))}
    </div>
  );
}
function Activity({ items }: { items: Detail['activity'] }) {
  return (
    <ol className="activity-list">
      {items.map((item, index) => (
        <li key={item.kind + item.occurredAt + index}>
          <span className={'activity-dot ' + tone(item.outcome)} />
          <div>
            <strong>{item.label}</strong>
            <small>
              {format(item.kind)}
              {item.outcome ? ' · ' + format(item.outcome) : ''}
            </small>
          </div>
          <time dateTime={item.occurredAt}>{date(item.occurredAt)}</time>
        </li>
      ))}
    </ol>
  );
}
function DeploymentTable({
  items,
  choose,
  selected,
}: {
  items: Deployment[];
  choose: (id: string) => void;
  selected?: string | null;
}) {
  if (!items.length)
    return (
      <Empty
        title="No deployments on this page"
        description="Try another page or clear the loaded-record filter."
      />
    );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Commit</th>
            <th scope="col">Status</th>
            <th scope="col">Stage</th>
            <th scope="col">Updated</th>
            <th scope="col">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className={item.id === selected ? 'selected' : ''}>
              <td>
                <button
                  className="table-link"
                  onClick={() => choose(item.id)}
                  aria-label={'View deployment ' + sha(item.commitSha)}
                >
                  <code>{sha(item.commitSha)}</code>
                </button>
              </td>
              <td>
                <Badge value={item.status} />
              </td>
              <td>{format(item.stage)}</td>
              <td>{date(item.updatedAt)}</td>
              <td>
                <button
                  className="icon-button"
                  onClick={() => choose(item.id)}
                  aria-label={'View deployment ' + sha(item.commitSha)}
                >
                  <Icon name="chevron" size={17} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>('overview');
  const [search, setSearch] = useState('');
  const [projectCursors, setProjectCursors] = useState<(string | null)[]>([null]);
  const [projectPage, setProjectPage] = useState(0);
  const [projects, setProjects] = useState<Page<Project>>({
    items: [],
    nextCursor: null,
  });
  const [projectState, setProjectState] = useState<State>('loading');
  const [projectError, setProjectError] = useState('');
  const [projectRetry, setProjectRetry] = useState(0);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [deploymentCursors, setDeploymentCursors] = useState<(string | null)[]>([null]);
  const [deploymentPage, setDeploymentPage] = useState(0);
  const [deployments, setDeployments] = useState<Page<Deployment>>({
    items: [],
    nextCursor: null,
  });
  const [deploymentState, setDeploymentState] = useState<State>('loading');
  const [deploymentError, setDeploymentError] = useState('');
  const [deploymentRetry, setDeploymentRetry] = useState(0);
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [detailError, setDetailError] = useState('');
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [stream, setStream] = useState<Stream>('connecting');

  useEffect(() => {
    let stopped = false;
    let pending = false;
    let active: AbortController | undefined;
    setProjectState('loading');
    setProjectId(null);
    setProjects({ items: [], nextCursor: null });
    const load = () => {
      if (pending || stopped) return;
      pending = true;
      const controller = new AbortController();
      active = controller;
      const timeout = setTimeout(() => controller.abort(), 10000);
      void get<{ projects: Project[]; nextCursor: string | null }>(
        '/api/projects' + query(projectCursors[projectPage] ?? null),
        controller.signal,
      )
        .then((result) => {
          if (stopped) return;
          setProjects({ items: result.projects, nextCursor: result.nextCursor });
          setProjectState('ready');
          setProjectError('');
        })
        .catch((error: unknown) => {
          if (stopped) return;
          setProjectError(
            error instanceof Error && error.name === 'AbortError'
              ? 'The project request timed out.'
              : error instanceof Error
                ? error.message
                : 'The project request failed.',
          );
          setProjectState('error');
        })
        .finally(() => {
          clearTimeout(timeout);
          pending = false;
          if (active === controller) active = undefined;
        });
    };
    load();
    const timer = setInterval(load, 15000);
    return () => {
      stopped = true;
      clearInterval(timer);
      active?.abort();
    };
  }, [projectCursors, projectPage, projectRetry]);

  useEffect(() => {
    if (projectState !== 'ready') return;
    if (!projects.items.some((item) => item.id === projectId)) {
      setProjectId(projects.items[0]?.id ?? null);
    }
  }, [projectId, projectState, projects]);
  useEffect(() => {
    if (!projectId) {
      setDeployments({ items: [], nextCursor: null });
      setDeploymentState('ready');
      return;
    }
    let stopped = false;
    let pending = false;
    let active: AbortController | undefined;
    setDeploymentState('loading');
    setDeployments({ items: [], nextCursor: null });
    const load = () => {
      if (pending || stopped) return;
      pending = true;
      const controller = new AbortController();
      active = controller;
      const timeout = setTimeout(() => controller.abort(), 10000);
      void get<{ deployments: Deployment[]; nextCursor: string | null }>(
        '/api/projects/' +
          encodeURIComponent(projectId) +
          '/deployments' +
          query(deploymentCursors[deploymentPage] ?? null),
        controller.signal,
      )
        .then((result) => {
          if (stopped) return;
          setDeployments((current) => ({
            items: result.deployments.map((item) => {
              const newer = current.items.find((existing) => existing.id === item.id);
              return newer && newer.version > item.version ? newer : item;
            }),
            nextCursor: result.nextCursor,
          }));
          setDeploymentState('ready');
          setDeploymentError('');
          setDetailRefresh((count) => count + 1);
        })
        .catch((error: unknown) => {
          if (stopped) return;
          setDeploymentError(
            error instanceof Error && error.name === 'AbortError'
              ? 'The deployment request timed out.'
              : error instanceof Error
                ? error.message
                : 'The deployment request failed.',
          );
          setDeploymentState('error');
        })
        .finally(() => {
          clearTimeout(timeout);
          pending = false;
          if (active === controller) active = undefined;
        });
    };
    load();
    const timer = setInterval(load, 15000);
    return () => {
      stopped = true;
      clearInterval(timer);
      active?.abort();
    };
  }, [projectId, deploymentCursors, deploymentPage, deploymentRetry]);
  useEffect(() => {
    if (
      deployments.items.length &&
      !deployments.items.some((item) => item.id === deploymentId)
    )
      setDeploymentId(deployments.items[0]?.id ?? null);
    if (!deployments.items.length) setDeploymentId(null);
  }, [deployments, deploymentId]);
  const deploymentIds = deployments.items.map((item) => item.id).join(',');
  useEffect(() => {
    if (deploymentState !== 'ready' || !deployments.items.length) return;
    const controller = new AbortController();
    let stopped = false;
    const timeout = setTimeout(() => controller.abort(), 8000);
    const ids = deploymentIds.split(',');
    void Promise.allSettled(
      ids.map((id) =>
        get<{ deployment: Detail }>(
          '/api/deployments/' + encodeURIComponent(id),
          controller.signal,
        ),
      ),
    ).then((results) => {
      clearTimeout(timeout);
      if (stopped) return;
      setDetails((current) => {
        const updated = { ...current };
        results.forEach((result, index) => {
          const id = ids[index];
          if (
            result.status === 'fulfilled' &&
            id &&
            (!updated[id] || updated[id].version <= result.value.deployment.version)
          )
            updated[id] = result.value.deployment;
        });
        return updated;
      });
      setDeployments((current) => ({
        ...current,
        items: current.items.map((item) => {
          const result = results[ids.indexOf(item.id)];
          if (
            result?.status !== 'fulfilled' ||
            result.value.deployment.version <= item.version
          )
            return item;
          const update = result.value.deployment;
          return {
            ...item,
            status: update.status,
            stage: update.stage,
            version: update.version,
            updatedAt: update.updatedAt,
          };
        }),
      }));
      setDetailError(
        results.some((result) => result.status === 'rejected')
          ? 'Some deployment evidence could not be loaded. It will retry automatically.'
          : '',
      );
    });
    return () => {
      stopped = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [deploymentIds, deploymentState, deploymentRetry, detailRefresh]);
  useEffect(() => {
    if (!deploymentId) return;
    const id = deploymentId;
    let closed = false;
    let source: EventSource | undefined;
    setStream('connecting');
    const update = (deployment: Detail) => {
      setDetails((current) =>
        current[id] && current[id].version > deployment.version
          ? current
          : { ...current, [id]: deployment },
      );
      setDeployments((current) => {
        if (
          !current.items.some(
            (item) => item.id === id && item.version < deployment.version,
          )
        )
          return current;
        return {
          ...current,
          items: current.items.map((item) =>
            item.id === id && item.version < deployment.version
              ? {
                  ...item,
                  status: deployment.status,
                  stage: deployment.stage,
                  version: deployment.version,
                  updatedAt: deployment.updatedAt,
                }
              : item,
          ),
        };
      });
    };
    const poll = () => {
      void get<{ deployment: Detail }>('/api/deployments/' + encodeURIComponent(id))
        .then(({ deployment }) => {
          if (!closed) update(deployment);
        })
        .catch(() => {
          if (!closed) setStream('unavailable');
        });
    };
    if (typeof EventSource !== 'undefined') {
      source = new EventSource(
        '/api/deployments/' + encodeURIComponent(id) + '/events',
      );
      source.addEventListener('deployment', (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as {
            deployment: Detail;
          };
          if (!closed) {
            update(payload.deployment);
            setStream('live');
          }
        } catch {
          if (!closed) setStream('reconnecting');
        }
      });
      source.onerror = () => {
        if (!closed) {
          setStream('reconnecting');
          poll();
        }
      };
    } else setStream('unavailable');
    const timer = setInterval(poll, 15000);
    return () => {
      closed = true;
      source?.close();
      clearInterval(timer);
    };
  }, [deploymentId]);

  const project = projects.items.find((item) => item.id === projectId);
  const name = project
    ? project.owner + '/' + project.repository
    : 'No project selected';
  const visibleProjects = useMemo(
    () =>
      projects.items.filter((item) =>
        (item.owner + '/' + item.repository + ' ' + item.defaultBranch)
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [projects, search],
  );
  const visibleDeployments = useMemo(
    () =>
      deployments.items.filter((item) =>
        (item.id + ' ' + item.commitSha + ' ' + item.status + ' ' + item.stage)
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [deployments, search],
  );
  const loadedDetails = deployments.items
    .map((item) => {
      const detail = details[item.id];
      return detail && detail.version >= item.version ? detail : undefined;
    })
    .filter((item): item is Detail => Boolean(item));
  const selectedBase = deployments.items.find((item) => item.id === deploymentId);
  const selectedDetail = deploymentId ? details[deploymentId] : undefined;
  const current =
    selectedDetail && selectedBase && selectedDetail.version >= selectedBase.version
      ? selectedDetail
      : undefined;
  const activities = loadedDetails
    .flatMap((item) => item.activity ?? [])
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .slice(0, 7);
  const releases = loadedDetails.filter((item) => item.release);
  const changeProject = (id: string) => {
    setProjectId(id);
    setDeploymentId(null);
    setDeploymentCursors([null]);
    setDeploymentPage(0);
  };
  const projectPager = (
    <Pager
      page={projectPage}
      previous={() => {
        setProjectPage((page) => page - 1);
        setProjectId(null);
      }}
      next={
        projects.nextCursor
          ? () => {
              setProjectCursors((items) => [
                ...items.slice(0, projectPage + 1),
                projects.nextCursor,
              ]);
              setProjectPage((page) => page + 1);
              setProjectId(null);
            }
          : undefined
      }
    />
  );
  const deploymentPager = (
    <Pager
      page={deploymentPage}
      previous={() => {
        setDeploymentPage((page) => page - 1);
        setDeploymentId(null);
      }}
      next={
        deployments.nextCursor
          ? () => {
              setDeploymentCursors((items) => [
                ...items.slice(0, deploymentPage + 1),
                deployments.nextCursor,
              ]);
              setDeploymentPage((page) => page + 1);
              setDeploymentId(null);
            }
          : undefined
      }
    />
  );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Primary navigation">
        <Brand />
        <nav>
          {(['overview', 'projects', 'deployments', 'releases'] as View[]).map(
            (item) => (
              <button
                key={item}
                className={'nav-link ' + (view === item ? 'active' : '')}
                aria-current={view === item ? 'page' : undefined}
                onClick={() => setView(item)}
              >
                <Icon name={item} />
                {format(item)}
              </button>
            ),
          )}
        </nav>
        <div className="sidebar-bottom">
          <span>SELF HOSTED RELEASES</span>
          <p>Build. Release. Roll back.</p>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="mobile-brand">
            <Brand />
          </div>
          <label className="search">
            <Icon name="search" size={18} />
            <span className="sr-only">Filter loaded records</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter loaded records..."
            />
          </label>
          <div className="read-only">
            <span />
            Read only workspace
          </div>
        </header>
        <main id="main-content" className="content">
          {view === 'overview' && (
            <>
              <Heading
                eyebrow="OVERVIEW"
                title="Deployment control"
                description="Current page records refresh every 15 seconds."
              />
              <div className="metrics">
                <Metric
                  icon="projects"
                  label="Projects on this page"
                  value={projectState === 'ready' ? String(projects.items.length) : '—'}
                />
                <Metric
                  icon="deployments"
                  label="Deployments on this page"
                  value={
                    deploymentState === 'ready' ? String(deployments.items.length) : '—'
                  }
                />
                <Metric
                  icon="check"
                  label="Succeeded on this page"
                  value={
                    deploymentState === 'ready'
                      ? String(
                          deployments.items.filter((item) => item.status === 'SUCCESS')
                            .length,
                        )
                      : '—'
                  }
                />
                <Metric
                  icon="activity"
                  label="Running on this page"
                  value={
                    deploymentState === 'ready'
                      ? String(
                          deployments.items.filter((item) => item.status === 'RUNNING')
                            .length,
                        )
                      : '—'
                  }
                />
              </div>
              {projectState === 'error' ? (
                <ErrorState
                  message={projectError}
                  retry={() => setProjectRetry((n) => n + 1)}
                />
              ) : projectState === 'loading' ? (
                <p className="loading" role="status">
                  Loading projects…
                </p>
              ) : !projects.items.length ? (
                <Empty
                  title="No projects yet"
                  description="Projects appear here after registration through the API."
                />
              ) : (
                <>
                  <div className="overview-grid">
                    <section className="card feature">
                      <div className="feature-top">
                        <span className="feature-mark">
                          <Icon name="projects" size={26} />
                        </span>
                        <span className="eyebrow">SELECTED PROJECT</span>
                      </div>
                      <h2>{name}</h2>
                      <p>
                        Tracking deployments from{' '}
                        <strong>{project?.defaultBranch}</strong>
                      </p>
                      <div className="feature-facts">
                        <Field label="Provider" value={format(project?.provider)} />
                        <Field
                          label="Latest commit on this page"
                          value={
                            deployments.items[0]
                              ? sha(deployments.items[0].commitSha)
                              : undefined
                          }
                        />
                        <Field label="Updated" value={date(project?.updatedAt)} />
                      </div>
                      <button
                        className="text-action"
                        onClick={() => setView('projects')}
                      >
                        View projects <Icon name="arrow" size={16} />
                      </button>
                    </section>
                    <section className="card peek">
                      <SectionTitle
                        icon="activity"
                        title="Selected deployment"
                        action={current ? <Badge value={current.status} /> : undefined}
                      />
                      {current ? (
                        <>
                          <h3>
                            {sha(current.commitSha)}{' '}
                            <small>· {format(current.stage)}</small>
                          </h3>
                          <p>Updated {date(current.updatedAt)}</p>
                          <Pipeline detail={current} />
                          <button
                            className="text-action"
                            onClick={() => setView('deployments')}
                          >
                            View deployment <Icon name="arrow" size={16} />
                          </button>
                        </>
                      ) : deploymentState === 'loading' ? (
                        <p className="loading" role="status">
                          Loading deployments…
                        </p>
                      ) : (
                        <p className="muted">No deployment available on this page.</p>
                      )}
                    </section>
                  </div>
                  <div className="overview-grid">
                    <section className="card panel">
                      <SectionTitle
                        icon="clock"
                        title="Recent deployments"
                        action={
                          <button
                            className="text-action"
                            onClick={() => setView('deployments')}
                          >
                            View all <Icon name="arrow" size={15} />
                          </button>
                        }
                      />
                      <p className="section-note">Selected project · current page</p>
                      {deploymentState === 'error' ? (
                        <ErrorState
                          message={deploymentError}
                          retry={() => setDeploymentRetry((n) => n + 1)}
                        />
                      ) : (
                        <DeploymentTable
                          items={visibleDeployments.slice(0, 5)}
                          choose={(id) => {
                            setDeploymentId(id);
                            setView('deployments');
                          }}
                        />
                      )}
                    </section>
                    <section className="card panel">
                      <SectionTitle icon="activity" title="Recorded activity" />
                      <p className="section-note">
                        Persisted milestones from loaded deployments
                      </p>
                      {activities.length ? (
                        <Activity items={activities} />
                      ) : (
                        <Empty
                          title="No activity available"
                          description="Milestones appear when deployments record evidence."
                        />
                      )}
                      {detailError && (
                        <p className="warning" role="status">
                          {detailError}
                        </p>
                      )}
                    </section>
                  </div>
                </>
              )}
            </>
          )}
          {view === 'projects' && (
            <>
              <Heading
                eyebrow="PROJECTS"
                title="Projects"
                description="Registered repositories on the current page. Refreshes every 15 seconds."
              />
              {projectState === 'error' ? (
                <ErrorState
                  message={projectError}
                  retry={() => setProjectRetry((n) => n + 1)}
                />
              ) : projectState === 'loading' ? (
                <p className="loading" role="status">
                  Loading projects…
                </p>
              ) : (
                <section className="card collection">
                  {visibleProjects.length ? (
                    visibleProjects.map((item) => (
                      <button
                        key={item.id}
                        className={
                          'project-row ' + (item.id === projectId ? 'selected' : '')
                        }
                        onClick={() => {
                          changeProject(item.id);
                          setView('deployments');
                        }}
                      >
                        <span className="row-mark">
                          <Icon name="projects" />
                        </span>
                        <span className="row-main">
                          <strong>
                            {item.owner}/{item.repository}
                          </strong>
                          <small>
                            {format(item.provider)} · {item.defaultBranch}
                          </small>
                        </span>
                        <span className="row-date">Updated {date(item.updatedAt)}</span>
                        <Icon name="chevron" size={16} />
                      </button>
                    ))
                  ) : (
                    <Empty
                      title={search ? 'No loaded projects match' : 'No projects yet'}
                      description={
                        search
                          ? 'Search filters only this page. Try another term or page.'
                          : 'Registered projects will appear here.'
                      }
                    />
                  )}
                  {projectPager}
                </section>
              )}
            </>
          )}
          {view === 'deployments' && (
            <>
              <Heading
                eyebrow="DEPLOYMENTS"
                title="Deployments"
                description={
                  'Selected project: ' + name + ' · refreshes every 15 seconds'
                }
                action={
                  projects.items.length > 1 ? (
                    <select
                      className="project-select"
                      aria-label="Select project"
                      value={projectId ?? ''}
                      onChange={(event) => changeProject(event.target.value)}
                    >
                      {projects.items.map((item) => (
                        <option value={item.id} key={item.id}>
                          {item.owner}/{item.repository}
                        </option>
                      ))}
                    </select>
                  ) : undefined
                }
              />
              {projectState === 'error' ? (
                <ErrorState
                  message={projectError}
                  retry={() => setProjectRetry((n) => n + 1)}
                />
              ) : deploymentState === 'error' ? (
                <ErrorState
                  message={deploymentError}
                  retry={() => setDeploymentRetry((n) => n + 1)}
                />
              ) : deploymentState === 'loading' ? (
                <p className="loading" role="status">
                  Loading deployments…
                </p>
              ) : (
                <>
                  <section className="card collection">
                    <SectionTitle
                      icon="deployments"
                      title="Deployment history"
                      action={<span className="eyebrow">CURRENT PAGE</span>}
                    />
                    <DeploymentTable
                      items={visibleDeployments}
                      choose={setDeploymentId}
                      selected={deploymentId}
                    />
                    {deploymentPager}
                  </section>
                  {deploymentId && (
                    <DeploymentDetail
                      key={deploymentId}
                      detail={current}
                      base={deployments.items.find((item) => item.id === deploymentId)}
                      stream={stream}
                      error={detailError}
                      retry={() => setDeploymentRetry((n) => n + 1)}
                    />
                  )}
                </>
              )}
            </>
          )}
          {view === 'releases' && (
            <>
              <Heading
                eyebrow="RELEASES"
                title="Release evidence"
                description={
                  'Recorded releases for loaded deployments in ' +
                  name +
                  '. Refreshes every 15 seconds.'
                }
              />
              {deploymentState === 'error' ? (
                <ErrorState
                  message={deploymentError}
                  retry={() => setDeploymentRetry((n) => n + 1)}
                />
              ) : deploymentState === 'loading' ? (
                <p className="loading" role="status">
                  Loading release evidence…
                </p>
              ) : (
                <div className="release-list">
                  {releases.length ? (
                    releases.map((item) => (
                      <article className="card release-card" key={item.id}>
                        <div className="release-head">
                          <div>
                            <span className="eyebrow">RELEASE ID</span>
                            <h2>{item.release?.releaseId ?? 'Unavailable'}</h2>
                          </div>
                          <Badge value={item.release?.status} />
                        </div>
                        <div className="release-facts">
                          <Field
                            label="Commit"
                            value={<code>{sha(item.commitSha)}</code>}
                          />
                          <Field
                            label="Promotion"
                            value={date(item.release?.success?.completedAt)}
                          />
                          <Field
                            label="Health proof"
                            value={
                              item.release?.health
                                ? 'HTTP ' +
                                  item.release.health.statusCode +
                                  ' · ' +
                                  item.release.health.attempts +
                                  ' attempts'
                                : undefined
                            }
                          />
                          <Field
                            label="Rollback"
                            value={
                              item.release?.rollback
                                ? format(item.release.rollback.mode) +
                                  ' · ' +
                                  format(item.release.rollback.outcome)
                                : item.release?.manualRollback
                                  ? format(item.release.manualRollback.status)
                                  : undefined
                            }
                          />
                        </div>
                        <button
                          className="text-action"
                          onClick={() => {
                            setDeploymentId(item.id);
                            setView('deployments');
                          }}
                        >
                          View deployment <Icon name="arrow" size={16} />
                        </button>
                      </article>
                    ))
                  ) : (
                    <div className="card">
                      <Empty
                        title="No release evidence on this page"
                        description="A release appears after a deployment records a release attempt."
                      />
                    </div>
                  )}
                  {detailError && (
                    <p className="warning" role="status">
                      {detailError}
                    </p>
                  )}
                  {deploymentPager}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function DeploymentDetail({
  detail,
  base,
  stream,
  error,
  retry,
}: {
  detail: Detail | undefined;
  base: Deployment | undefined;
  stream: Stream;
  error: string;
  retry: () => void;
}) {
  return (
    <section className="card deployment-detail" aria-label="Deployment details">
      <div className="detail-head">
        <div>
          <span className="eyebrow">DEPLOYMENT DETAIL</span>
          <h2>{sha(base?.commitSha)}</h2>
        </div>
        <div className="detail-indicators">
          {base && <Badge value={base.status} />}
          <span className={'stream ' + stream} role="status">
            {stream === 'live'
              ? 'Live updates'
              : stream === 'connecting'
                ? 'Connecting…'
                : stream === 'reconnecting'
                  ? 'Reconnecting…'
                  : 'Live stream unavailable · refreshing periodically'}
          </span>
        </div>
      </div>
      {!detail ? (
        <p className="loading" role="status">
          Loading recorded evidence…{' '}
          {error && (
            <button className="text-action" onClick={retry}>
              Retry
            </button>
          )}
        </p>
      ) : (
        <>
          <Pipeline detail={detail} />
          <div className="evidence-grid">
            <Field
              label="Status / stage"
              value={format(detail.status) + ' / ' + format(detail.stage)}
            />
            <Field
              label="Full commit"
              value={<code className="wrap">{detail.commitSha}</code>}
            />
            <Field label="Created" value={date(detail.createdAt)} />
            <Field label="Updated" value={date(detail.updatedAt)} />
          </div>
          <div className="detail-columns">
            <div>
              <h3>CI execution</h3>
              {detail.ci ? (
                <>
                  <div className="summary">
                    <Badge value={detail.ci.status} />
                    {detail.ci.failureKind && (
                      <span>{format(detail.ci.failureKind)}</span>
                    )}
                  </div>
                  <div className="steps">
                    {detail.ci.steps.map((step) => (
                      <div key={step.stage}>
                        <span>{format(step.stage)}</span>
                        <Badge value={step.status} />
                        <small>
                          {step.finishedAt ? date(step.finishedAt) : 'Not completed'}
                        </small>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="muted">CI evidence unavailable.</p>
              )}
            </div>
            <div>
              <h3>Release and health</h3>
              {detail.release ? (
                <>
                  <div className="summary">
                    <Badge value={detail.release.status} />
                    {detail.release.failureKind && (
                      <span>{format(detail.release.failureKind)}</span>
                    )}
                  </div>
                  <div className="evidence-grid compact">
                    <Field label="Release ID" value={detail.release.releaseId} />
                    <Field
                      label="Promoted"
                      value={date(detail.release.success?.completedAt)}
                    />
                    <Field
                      label="Health gate"
                      value={
                        detail.release.health
                          ? 'HTTP ' +
                            detail.release.health.statusCode +
                            ' after ' +
                            detail.release.health.attempts +
                            ' attempts'
                          : undefined
                      }
                    />
                    <Field
                      label="Nginx proof"
                      value={
                        detail.release.success
                          ? (detail.release.success.nginx.validated
                              ? 'Validated'
                              : 'Not validated') +
                            ' · ' +
                            (detail.release.success.nginx.reloaded
                              ? 'Reloaded'
                              : 'Not reloaded')
                          : undefined
                      }
                    />
                  </div>
                </>
              ) : (
                <p className="muted">Release evidence unavailable.</p>
              )}
            </div>
          </div>
          <div className="detail-columns">
            <div>
              <h3>Rollback outcome</h3>
              {detail.release?.rollback ? (
                <div className="evidence-grid compact">
                  <Field
                    label="Mode / result"
                    value={
                      format(detail.release.rollback.mode) +
                      ' / ' +
                      format(detail.release.rollback.outcome)
                    }
                  />
                  <Field
                    label="Restored release"
                    value={detail.release.rollback.targetReleaseId}
                  />
                  <Field
                    label="Restored commit"
                    value={<code>{sha(detail.release.rollback.targetCommitSha)}</code>}
                  />
                  <Field
                    label="Health proof"
                    value={
                      detail.release.rollback.health
                        ? 'HTTP ' + detail.release.rollback.health.statusCode
                        : undefined
                    }
                  />
                  <Field
                    label="Completed"
                    value={date(detail.release.rollback.completedAt)}
                  />
                </div>
              ) : (
                <p className="muted">No automatic rollback outcome recorded.</p>
              )}
              {detail.release?.manualRollback && (
                <div className="manual">
                  <strong>Manual rollback</strong>
                  <span>
                    {format(detail.release.manualRollback.status)} ·{' '}
                    {date(detail.release.manualRollback.finishedAt)}
                  </span>
                </div>
              )}
            </div>
            <div>
              <h3>Recorded activity</h3>
              {detail.activity?.length ? (
                <Activity items={detail.activity} />
              ) : (
                <p className="muted">No persisted milestones available.</p>
              )}
            </div>
          </div>
        </>
      )}
      {error && (
        <p className="warning" role="status">
          {error}
        </p>
      )}
    </section>
  );
}
