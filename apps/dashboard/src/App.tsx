import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ComponentType,
  type ReactNode,
} from 'react';
import {
  ArrowClockwise,
  ArrowRight,
  CaretDown,
  CaretRight,
  Check,
  Clock,
  GitBranch,
  GithubLogo,
  MagnifyingGlass,
  Package,
  Pulse,
  RocketLaunch,
  SignOut,
  SquaresFour,
  Stack,
  UserCircle,
  WarningCircle,
} from '@phosphor-icons/react';

import { createDetailReader } from './detail-requests';

type View = 'overview' | 'projects' | 'deployments' | 'releases';
type State = 'loading' | 'ready' | 'error';
type Stream = 'connecting' | 'live' | 'reconnecting' | 'unavailable';
type AuthState =
  'checking' | 'authenticated' | 'unauthenticated' | 'unavailable' | 'forbidden';
type OperatorSession = {
  operator: { id: string; role: 'operator' };
  csrfToken: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
};
type Page<T> = { items: T[]; nextCursor: string | null };
type ProjectSummary = {
  state: State;
  deployment?: Deployment;
  detail?: Detail;
  error?: string;
};
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
type ActivityItem = Detail['activity'][number] & { context?: string };

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
const allProjectsQuery = (cursor: string | null) =>
  '?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
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

class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    signal: signal ?? null,
    headers: { Accept: 'application/json', ...options.headers },
  });
  if (!response.ok)
    throw new ApiRequestError(
      response.status,
      response.status === 404
        ? 'This record is no longer available.'
        : 'Request failed (' + response.status + ').',
    );
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const get = <T,>(path: string, signal?: AbortSignal) => request<T>(path, {}, signal);

const icons: Record<
  string,
  ComponentType<{ size?: number; weight?: 'regular' | 'bold' }>
> = {
  overview: SquaresFour,
  projects: Stack,
  deployments: RocketLaunch,
  releases: Package,
  search: MagnifyingGlass,
  arrow: ArrowRight,
  chevron: CaretRight,
  down: CaretDown,
  clock: Clock,
  branch: GitBranch,
  provider: GithubLogo,
  activity: Pulse,
  refresh: ArrowClockwise,
  check: Check,
  account: UserCircle,
  signout: SignOut,
  warning: WarningCircle,
};

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const Glyph = icons[name] ?? SquaresFour;
  return <Glyph size={size} weight="regular" aria-hidden="true" />;
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
function Activity({ items }: { items: ActivityItem[] }) {
  return (
    <ol className="activity-list">
      {items.map((item, index) => (
        <li key={item.kind + item.occurredAt + index}>
          <span className={'activity-icon ' + tone(item.outcome)}>
            <Icon
              name={
                item.kind.toLowerCase().includes('rollback')
                  ? 'refresh'
                  : item.kind.toLowerCase().includes('release')
                    ? 'releases'
                    : item.outcome && tone(item.outcome) === 'success'
                      ? 'check'
                      : 'activity'
              }
              size={13}
            />
          </span>
          <div>
            <strong>{item.label}</strong>
            <small>
              {item.context ? item.context + ' · ' : ''}
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
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [session, setSession] = useState<OperatorSession | null>(null);
  const [authMessage, setAuthMessage] = useState('');
  const [authAttempt, setAuthAttempt] = useState(0);

  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    setAuthState('checking');
    setAuthMessage('');
    void get<OperatorSession>('/api/auth/session', controller.signal)
      .then((value) => {
        if (stopped) return;
        setSession(value);
        setAuthState('authenticated');
      })
      .catch((error: unknown) => {
        if (stopped) return;
        setSession(null);
        if (error instanceof ApiRequestError && error.status === 401) {
          setAuthState('unauthenticated');
        } else if (error instanceof ApiRequestError && error.status === 403) {
          setAuthState('forbidden');
        } else {
          setAuthState('unavailable');
          setAuthMessage(
            error instanceof Error && error.name === 'AbortError'
              ? 'The authentication service did not respond in time.'
              : 'The authentication service is unavailable.',
          );
        }
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      stopped = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [authAttempt]);

  const authenticationFailed = useCallback(() => {
    setSession(null);
    setAuthMessage('Your session has expired. Sign in again.');
    setAuthState('unauthenticated');
  }, []);

  if (authState !== 'authenticated' || !session) {
    return (
      <AuthenticationGate
        state={authState}
        message={authMessage}
        retry={() => setAuthAttempt((attempt) => attempt + 1)}
        signedIn={(value) => {
          setSession(value);
          setAuthMessage('');
          setAuthState('authenticated');
        }}
      />
    );
  }

  return (
    <Dashboard
      session={session}
      authenticationFailed={authenticationFailed}
      signedOut={() => {
        setSession(null);
        setAuthMessage('You have signed out.');
        setAuthState('unauthenticated');
      }}
    />
  );
}

function AuthenticationGate({
  state,
  message,
  retry,
  signedIn,
}: {
  state: AuthState;
  message: string;
  retry: () => void;
  signedIn: (session: OperatorSession) => void;
}) {
  const [operatorId, setOperatorId] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loginError, setLoginError] = useState('');

  const login = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    setSubmitting(true);
    setLoginError('');
    void request<void>(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorId, password }),
      },
      controller.signal,
    )
      .then(() => get<OperatorSession>('/api/auth/session', controller.signal))
      .then((value) => {
        setPassword('');
        setSubmitting(false);
        signedIn(value);
      })
      .catch((error: unknown) => {
        setPassword('');
        setSubmitting(false);
        if (error instanceof ApiRequestError && error.status === 429) {
          setLoginError('Too many sign-in attempts. Try again later.');
        } else if (error instanceof ApiRequestError && error.status === 401) {
          setLoginError('The operator identifier or password is invalid.');
        } else if (error instanceof Error && error.name === 'AbortError') {
          setLoginError('The sign-in request timed out.');
        } else {
          setLoginError('Sign-in is currently unavailable.');
        }
      })
      .finally(() => clearTimeout(timeout));
  };

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <Brand />
        {state === 'checking' ? (
          <p className="loading" role="status">
            Restoring operator session…
          </p>
        ) : state === 'unavailable' ? (
          <>
            <h1 id="auth-title">ReleaseDeck is unavailable</h1>
            <p>{message || 'The authentication service could not be reached.'}</p>
            <button className="button" onClick={retry}>
              Retry connection
            </button>
          </>
        ) : state === 'forbidden' ? (
          <>
            <h1 id="auth-title">Operator access required</h1>
            <p>The current session is not authorized for this workspace.</p>
            <button className="button" onClick={retry}>
              Check session again
            </button>
          </>
        ) : (
          <>
            <span className="eyebrow">OPERATOR ACCESS</span>
            <h1 id="auth-title">Sign in to ReleaseDeck</h1>
            <p>Use the operator credentials configured on this ReleaseDeck server.</p>
            {message && <p className="auth-notice">{message}</p>}
            <form onSubmit={login} className="auth-form">
              <label>
                Operator identifier
                <input
                  name="operatorId"
                  autoComplete="username"
                  value={operatorId}
                  onChange={(event) => setOperatorId(event.target.value)}
                  required
                />
              </label>
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>
              {loginError && (
                <p className="warning" role="alert">
                  {loginError}
                </p>
              )}
              <button className="button" type="submit" disabled={submitting}>
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}

function Dashboard({
  session,
  authenticationFailed,
  signedOut,
}: {
  session: OperatorSession;
  authenticationFailed: () => void;
  signedOut: () => void;
}) {
  const authenticatedGet = useMemo(() => {
    let authFailureReported = false;
    return async <T,>(path: string, signal?: AbortSignal) => {
      try {
        return await get<T>(path, signal);
      } catch (error) {
        if (
          !authFailureReported &&
          error instanceof ApiRequestError &&
          [401, 403].includes(error.status)
        ) {
          authFailureReported = true;
          authenticationFailed();
        }
        throw error;
      }
    };
  }, [authenticationFailed]);
  const readDetail = useMemo(
    () =>
      createDetailReader((path, signal) =>
        authenticatedGet<{ deployment: Detail }>(path, signal),
      ),
    [authenticatedGet],
  );
  const [view, setView] = useState<View>('overview');
  const [search, setSearch] = useState('');
  const [overviewProjects, setOverviewProjects] = useState<Project[]>([]);
  const [overviewProjectState, setOverviewProjectState] = useState<State>('loading');
  const [overviewProjectError, setOverviewProjectError] = useState('');
  const [overviewRetry, setOverviewRetry] = useState(0);
  const [overviewRevision, setOverviewRevision] = useState(0);
  const [projectSummaries, setProjectSummaries] = useState<
    Record<string, ProjectSummary>
  >({});
  const [projectSort, setProjectSort] = useState<'updated' | 'name'>('updated');
  const [projectStatus, setProjectStatus] = useState('all');
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
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');

  const logout = () => {
    if (loggingOut) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    setLoggingOut(true);
    setLogoutError('');
    void request<void>(
      '/api/auth/logout',
      {
        method: 'POST',
        headers: { 'X-ReleaseDeck-CSRF': session.csrfToken },
      },
      controller.signal,
    )
      .then(() => {
        setLoggingOut(false);
        signedOut();
      })
      .catch((error: unknown) => {
        setLoggingOut(false);
        if (error instanceof ApiRequestError && [401, 403].includes(error.status)) {
          authenticationFailed();
        } else {
          setLogoutError(
            error instanceof Error && error.name === 'AbortError'
              ? 'Sign-out timed out.'
              : 'Sign-out failed. Your session remains active.',
          );
        }
      })
      .finally(() => clearTimeout(timeout));
  };

  useEffect(() => {
    let stopped = false;
    let pending = false;
    let active: AbortController | undefined;
    let hasLoaded = false;
    setOverviewProjectState('loading');
    const load = () => {
      if (pending || stopped) return;
      pending = true;
      const controller = new AbortController();
      active = controller;
      const timeout = setTimeout(() => controller.abort(), 15000);
      const readAll = async () => {
        const items = new Map<string, Project>();
        const cursors = new Set<string>();
        let cursor: string | null = null;
        do {
          const page: { projects: Project[]; nextCursor: string | null } =
            await authenticatedGet<{
              projects: Project[];
              nextCursor: string | null;
            }>('/api/projects' + allProjectsQuery(cursor), controller.signal);
          for (const project of page.projects) items.set(project.id, project);
          if (page.nextCursor && cursors.has(page.nextCursor))
            throw new Error('The project list returned a repeated cursor.');
          if (page.nextCursor) cursors.add(page.nextCursor);
          cursor = page.nextCursor;
        } while (cursor);
        return [...items.values()];
      };
      void readAll()
        .then((items) => {
          if (stopped) return;
          setOverviewProjects(items);
          setOverviewProjectState('ready');
          setOverviewProjectError('');
          setOverviewRevision((revision) => revision + 1);
          hasLoaded = true;
        })
        .catch((error: unknown) => {
          if (stopped) return;
          setOverviewProjectError(
            error instanceof Error && error.name === 'AbortError'
              ? 'The complete project list did not respond in time.'
              : error instanceof Error
                ? error.message
                : 'The project request failed.',
          );
          if (!hasLoaded) setOverviewProjectState('error');
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
  }, [authenticatedGet, overviewRetry]);

  const overviewProjectIds = overviewProjects.map((item) => item.id).join(',');
  useEffect(() => {
    if (overviewProjectState !== 'ready' || !overviewProjects.length) {
      if (overviewProjectState === 'ready') setProjectSummaries({});
      return;
    }
    let stopped = false;
    const controller = new AbortController();
    setProjectSummaries((current) => {
      const next: Record<string, ProjectSummary> = {};
      for (const project of overviewProjects) {
        const existing = current[project.id];
        next[project.id] = existing?.deployment
          ? {
              state: 'loading',
              deployment: existing.deployment,
              ...(existing.detail ? { detail: existing.detail } : {}),
            }
          : { state: 'loading' };
      }
      return next;
    });
    const load = async () => {
      for (let index = 0; index < overviewProjects.length; index += 5) {
        const batch = overviewProjects.slice(index, index + 5);
        const results = await Promise.all(
          batch.map(async (project): Promise<[string, ProjectSummary]> => {
            try {
              const page = await authenticatedGet<{
                deployments: Deployment[];
                nextCursor: string | null;
              }>(
                '/api/projects/' +
                  encodeURIComponent(project.id) +
                  '/deployments?limit=1',
                controller.signal,
              );
              const deployment = page.deployments[0];
              if (!deployment) return [project.id, { state: 'ready' }];
              if (!stopped)
                setProjectSummaries((current) => ({
                  ...current,
                  [project.id]: { state: 'ready', deployment },
                }));
              try {
                const result = await readDetail(
                  '/api/deployments/' + encodeURIComponent(deployment.id),
                  controller.signal,
                );
                return [
                  project.id,
                  { state: 'ready', deployment, detail: result.deployment },
                ];
              } catch (error) {
                if (controller.signal.aborted) throw error;
                return [
                  project.id,
                  {
                    state: 'ready',
                    deployment,
                    error: 'Release evidence is temporarily unavailable.',
                  },
                ];
              }
            } catch (error) {
              return [
                project.id,
                {
                  state: 'error',
                  error:
                    error instanceof Error && error.name === 'AbortError'
                      ? 'Latest deployment request timed out.'
                      : 'Latest deployment is unavailable.',
                },
              ];
            }
          }),
        );
        if (stopped) return;
        setProjectSummaries((current) => ({
          ...current,
          ...Object.fromEntries(results),
        }));
      }
    };
    const timeout = setTimeout(() => controller.abort(), 12000);
    void load().finally(() => clearTimeout(timeout));
    return () => {
      stopped = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [
    authenticatedGet,
    overviewProjectIds,
    overviewProjectState,
    overviewProjects,
    overviewRevision,
    readDetail,
  ]);

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
      void authenticatedGet<{ projects: Project[]; nextCursor: string | null }>(
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
  }, [authenticatedGet, projectCursors, projectPage, projectRetry]);

  useEffect(() => {
    if (projectState !== 'ready') return;
    const projectIsAvailable =
      projects.items.some((item) => item.id === projectId) ||
      (view !== 'projects' && overviewProjects.some((item) => item.id === projectId));
    if (!projectIsAvailable) {
      setProjectId(projects.items[0]?.id ?? null);
      setDeploymentId(null);
      setDeploymentCursors([null]);
      setDeploymentPage(0);
    }
  }, [overviewProjects, projectId, projectState, projects, view]);
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
      void authenticatedGet<{ deployments: Deployment[]; nextCursor: string | null }>(
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
  }, [authenticatedGet, projectId, deploymentCursors, deploymentPage, deploymentRetry]);
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
        readDetail('/api/deployments/' + encodeURIComponent(id), controller.signal),
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
  }, [deploymentIds, deploymentState, deploymentRetry, detailRefresh, readDetail]);
  useEffect(() => {
    if (!deploymentId) return;
    const id = deploymentId;
    let closed = false;
    let source: EventSource | undefined;
    let active: AbortController | undefined;
    let requestTimeout: ReturnType<typeof setTimeout> | undefined;
    const requestTimeoutMs = 10000;
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
      if (closed || active) return;
      const controller = new AbortController();
      active = controller;
      requestTimeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      void readDetail('/api/deployments/' + encodeURIComponent(id), controller.signal)
        .then(({ deployment }) => {
          if (!closed && !controller.signal.aborted) update(deployment);
        })
        .catch(() => {
          if (!closed) setStream('unavailable');
        })
        .finally(() => {
          clearTimeout(requestTimeout);
          active = undefined;
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
      clearTimeout(requestTimeout);
      active?.abort();
    };
  }, [deploymentId, readDetail]);

  const project =
    projects.items.find((item) => item.id === projectId) ??
    overviewProjects.find((item) => item.id === projectId);
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
  const visibleOverviewProjects = useMemo(() => {
    const term = search.trim().toLowerCase();
    return overviewProjects
      .filter((item) => {
        const summary = projectSummaries[item.id];
        const matchesSearch = (
          item.owner +
          '/' +
          item.repository +
          ' ' +
          item.defaultBranch
        )
          .toLowerCase()
          .includes(term);
        const status = summary?.deployment?.status;
        const matchesStatus =
          projectStatus === 'all' ||
          (projectStatus === 'none'
            ? summary?.state === 'ready' && !status
            : status === projectStatus);
        return matchesSearch && matchesStatus;
      })
      .sort((left, right) => {
        if (projectSort === 'name')
          return (left.owner + '/' + left.repository).localeCompare(
            right.owner + '/' + right.repository,
          );
        const leftUpdated =
          projectSummaries[left.id]?.deployment?.updatedAt ?? left.updatedAt;
        const rightUpdated =
          projectSummaries[right.id]?.deployment?.updatedAt ?? right.updatedAt;
        return Date.parse(rightUpdated) - Date.parse(leftUpdated);
      });
  }, [overviewProjects, projectSort, projectStatus, projectSummaries, search]);
  const recentOverviewDeployments = useMemo(
    () =>
      overviewProjects
        .flatMap((item) => {
          const summary = projectSummaries[item.id];
          return summary?.deployment
            ? [
                {
                  project: item,
                  deployment: summary.deployment,
                  detail: summary.detail,
                },
              ]
            : [];
        })
        .sort(
          (left, right) =>
            Date.parse(right.deployment.updatedAt) -
            Date.parse(left.deployment.updatedAt),
        )
        .slice(0, 8),
    [overviewProjects, projectSummaries],
  );
  const overviewActivities = useMemo(
    () =>
      overviewProjects
        .flatMap((project) =>
          (projectSummaries[project.id]?.detail?.activity ?? []).map((activity) => ({
            ...activity,
            context: project.owner + '/' + project.repository,
          })),
        )
        .sort(
          (left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt),
        )
        .slice(0, 12),
    [overviewProjects, projectSummaries],
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
          <div className="operator-actions">
            <span className="read-only">
              <span /> Read-only
            </span>
            <details className="account-menu">
              <summary aria-label="Open account menu">
                <span className="account-avatar">
                  <Icon name="account" size={18} />
                </span>
                <span>{session.operator.id}</span>
                <Icon name="down" size={14} />
              </summary>
              <div className="account-popover">
                <span className="eyebrow">OPERATOR SESSION</span>
                <strong>{session.operator.id}</strong>
                <small>Read-only dashboard access</small>
                <button className="sign-out" onClick={logout} disabled={loggingOut}>
                  <Icon name="signout" size={15} />
                  {loggingOut ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            </details>
          </div>
        </header>
        {logoutError && (
          <p className="topbar-warning" role="alert">
            {logoutError}
          </p>
        )}
        <main id="main-content" className="content">
          {view === 'overview' && (
            <>
              <Heading
                eyebrow="OVERVIEW"
                title="Overview"
                description="Projects and their latest recorded release state. Refreshes every 15 seconds."
              />
              <section className="overview-section" aria-labelledby="projects-title">
                <div className="overview-section-head">
                  <div>
                    <div className="section-heading-line">
                      <Icon name="projects" size={18} />
                      <h2 id="projects-title">Your projects</h2>
                      {overviewProjectState === 'ready' && (
                        <span className="count-pill">{overviewProjects.length}</span>
                      )}
                    </div>
                    <p>
                      Every registered repository, with its latest known deployment.
                    </p>
                  </div>
                  <div
                    className="compact-controls"
                    aria-label="Project display options"
                  >
                    <select
                      value={projectStatus}
                      onChange={(event) => setProjectStatus(event.target.value)}
                      aria-label="Filter projects by deployment status"
                    >
                      <option value="all">All statuses</option>
                      <option value="SUCCESS">Successful</option>
                      <option value="RUNNING">Running</option>
                      <option value="FAILED">Failed</option>
                      <option value="ROLLED_BACK">Rolled back</option>
                      <option value="none">No deployments</option>
                    </select>
                    <select
                      value={projectSort}
                      onChange={(event) =>
                        setProjectSort(event.target.value as 'updated' | 'name')
                      }
                      aria-label="Sort projects"
                    >
                      <option value="updated">Recently updated</option>
                      <option value="name">Project name</option>
                    </select>
                  </div>
                </div>
                {overviewProjectState === 'error' ? (
                  <ErrorState
                    message={overviewProjectError}
                    retry={() => setOverviewRetry((retry) => retry + 1)}
                  />
                ) : overviewProjectState === 'loading' ? (
                  <div
                    className="project-list"
                    role="status"
                    aria-label="Loading projects"
                  >
                    {[0, 1, 2].map((item) => (
                      <div className="project-skeleton" key={item} />
                    ))}
                  </div>
                ) : !overviewProjects.length ? (
                  <Empty
                    title="No projects yet"
                    description="Projects appear here after registration through the API."
                  />
                ) : visibleOverviewProjects.length ? (
                  <div className="project-list">
                    {visibleOverviewProjects.map((item) => {
                      const summary = projectSummaries[item.id];
                      const deployment = summary?.deployment;
                      const detail = summary?.detail;
                      return (
                        <details className="project-card" key={item.id}>
                          <summary>
                            <span className="row-mark">
                              <Icon name="projects" size={18} />
                            </span>
                            <span className="project-identity">
                              <strong>{item.repository}</strong>
                              <small>
                                {item.owner}/{item.repository}
                              </small>
                            </span>
                            <span className="project-branch">
                              <Icon name="branch" size={14} /> {item.defaultBranch}
                            </span>
                            <span className="project-state">
                              {summary?.state === 'loading' ? (
                                <span className="badge neutral">Loading</span>
                              ) : summary?.state === 'error' ? (
                                <span className="badge danger">Unavailable</span>
                              ) : deployment ? (
                                <Badge value={deployment.status} />
                              ) : (
                                <span className="badge neutral">No deployments</span>
                              )}
                              <small>
                                {deployment
                                  ? format(deployment.stage)
                                  : 'No stage recorded'}
                              </small>
                            </span>
                            <span className="project-release">
                              <strong>
                                {detail?.release?.releaseId ?? 'No release'}
                              </strong>
                              <small>
                                {detail?.release
                                  ? format(detail.release.status)
                                  : (summary?.error ?? 'No release evidence')}
                              </small>
                            </span>
                            <time dateTime={deployment?.updatedAt ?? item.updatedAt}>
                              {date(deployment?.updatedAt ?? item.updatedAt)}
                            </time>
                            <span className="disclosure-icon">
                              <Icon name="down" size={16} />
                            </span>
                          </summary>
                          <div className="project-detail-body">
                            <div className="compact-facts">
                              <Field label="Provider" value={format(item.provider)} />
                              <Field
                                label="Latest commit"
                                value={
                                  deployment ? (
                                    <code>{sha(deployment.commitSha)}</code>
                                  ) : undefined
                                }
                              />
                              <Field
                                label="Tracked branch"
                                value={item.defaultBranch}
                              />
                              <Field
                                label="Health gate"
                                value={
                                  detail?.release?.health
                                    ? 'HTTP ' +
                                      detail.release.health.statusCode +
                                      ' after ' +
                                      detail.release.health.attempts +
                                      ' attempts'
                                    : undefined
                                }
                              />
                              <Field
                                label="Promoted"
                                value={date(detail?.release?.success?.completedAt)}
                              />
                              <Field
                                label="Rollback"
                                value={
                                  detail?.release?.rollback
                                    ? format(detail.release.rollback.mode) +
                                      ' / ' +
                                      format(detail.release.rollback.outcome)
                                    : undefined
                                }
                              />
                            </div>
                            {summary?.error && (
                              <p className="inline-note" role="status">
                                <Icon name="warning" size={15} /> {summary.error}
                              </p>
                            )}
                            <button
                              className="text-action"
                              onClick={() => {
                                changeProject(item.id);
                                if (deployment) setDeploymentId(deployment.id);
                                setView('deployments');
                              }}
                            >
                              Open project <Icon name="arrow" size={15} />
                            </button>
                          </div>
                        </details>
                      );
                    })}
                  </div>
                ) : (
                  <Empty
                    title="No projects match"
                    description="Clear the loaded-record search or choose another status."
                  />
                )}
                {overviewProjectError && overviewProjectState === 'ready' && (
                  <p className="warning" role="status">
                    {overviewProjectError}
                  </p>
                )}
              </section>

              <section className="overview-section" aria-labelledby="recent-title">
                <div className="overview-section-head">
                  <div>
                    <div className="section-heading-line">
                      <Icon name="deployments" size={18} />
                      <h2 id="recent-title">Recent deployments</h2>
                    </div>
                    <p>
                      Latest known deployment from each project, ordered by update time.
                    </p>
                  </div>
                </div>
                {recentOverviewDeployments.length ? (
                  <div className="deployment-list">
                    {recentOverviewDeployments.map(
                      ({ project, deployment, detail }) => (
                        <details className="deployment-row" key={deployment.id}>
                          <summary>
                            <code>{sha(deployment.commitSha)}</code>
                            <span className="deployment-project">
                              {project.owner}/{project.repository}
                            </span>
                            <Badge value={deployment.status} />
                            <span className="deployment-stage">
                              {format(deployment.stage)}
                            </span>
                            <time dateTime={deployment.updatedAt}>
                              {date(deployment.updatedAt)}
                            </time>
                            <span className="disclosure-icon">
                              <Icon name="down" size={16} />
                            </span>
                          </summary>
                          <div className="deployment-row-detail">
                            {detail ? (
                              <Pipeline detail={detail} />
                            ) : (
                              <p className="muted">
                                Detailed evidence is not currently available.
                              </p>
                            )}
                            <div className="compact-facts">
                              <Field
                                label="Full commit"
                                value={
                                  <code className="wrap">{deployment.commitSha}</code>
                                }
                              />
                              <Field
                                label="Release ID"
                                value={detail?.release?.releaseId}
                              />
                              <Field
                                label="Release state"
                                value={format(detail?.release?.status)}
                              />
                              <Field
                                label="Updated"
                                value={date(deployment.updatedAt)}
                              />
                            </div>
                            <button
                              className="text-action"
                              onClick={() => {
                                changeProject(project.id);
                                setDeploymentId(deployment.id);
                                setView('deployments');
                              }}
                            >
                              View deployment <Icon name="arrow" size={15} />
                            </button>
                          </div>
                        </details>
                      ),
                    )}
                  </div>
                ) : overviewProjectState === 'loading' ? (
                  <p className="loading" role="status">
                    Loading recent deployments...
                  </p>
                ) : (
                  <Empty
                    title="No deployments recorded"
                    description="Latest deployment attempts will appear here when recorded."
                  />
                )}
              </section>

              <details className="overview-section activity-section">
                <summary>
                  <span className="section-heading-line">
                    <Icon name="activity" size={18} />
                    <span>
                      <strong>Recorded activity</strong>
                      <small>
                        Persisted milestones from latest project deployments
                      </small>
                    </span>
                  </span>
                  <span className="activity-count">
                    {overviewActivities.length} events <Icon name="down" size={16} />
                  </span>
                </summary>
                <div className="activity-body">
                  {overviewActivities.length ? (
                    <Activity items={overviewActivities} />
                  ) : (
                    <Empty
                      title="No activity available"
                      description="Milestones appear when deployments record evidence."
                    />
                  )}
                </div>
              </details>
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
                  (overviewProjects.length || projects.items.length) > 1 ? (
                    <select
                      className="project-select"
                      aria-label="Select project"
                      value={projectId ?? ''}
                      onChange={(event) => changeProject(event.target.value)}
                    >
                      {(overviewProjects.length
                        ? overviewProjects
                        : projects.items
                      ).map((item) => (
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
                    label={
                      detail.release.rollback.outcome === 'RESTORED'
                        ? 'Restored release'
                        : 'Attempted release (not restored)'
                    }
                    value={detail.release.rollback.targetReleaseId}
                  />
                  <Field
                    label={
                      detail.release.rollback.outcome === 'RESTORED'
                        ? 'Restored commit'
                        : 'Attempted commit (not restored)'
                    }
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
