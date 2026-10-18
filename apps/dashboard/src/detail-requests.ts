type Pending<T> = {
  controller: AbortController;
  promise: Promise<T>;
  users: number;
  settled: boolean;
};

/** Share in-flight detail reads while keeping each caller's cancellation independent. */
export function createDetailReader<T>(
  load: (path: string, signal: AbortSignal) => Promise<T>,
) {
  const pending = new Map<string, Pending<T>>();
  const aborted = () => new DOMException('The request was aborted.', 'AbortError');

  return (path: string, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) return Promise.reject(aborted());
    let request = pending.get(path);
    if (!request) {
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw aborted();
        return load(path, controller.signal);
      });
      request = { controller, promise, users: 0, settled: false };
      pending.set(path, request);
      const entry = request;
      const settled = () => {
        entry.settled = true;
        if (pending.get(path) === entry) pending.delete(path);
      };
      void promise.then(settled, settled);
    }
    const entry = request;
    entry.users++;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const release = () => {
        if (finished) return false;
        finished = true;
        signal.removeEventListener('abort', cancel);
        entry.users--;
        if (!entry.users && !entry.settled) {
          if (pending.get(path) === entry) pending.delete(path);
          entry.controller.abort();
        }
        return true;
      };
      const cancel = () => {
        if (release()) reject(aborted());
      };
      signal.addEventListener('abort', cancel, { once: true });
      void entry.promise.then(
        (value) => {
          if (release()) resolve(value);
        },
        (error: unknown) => {
          if (release()) reject(error);
        },
      );
    });
  };
}
