import { Suspense, lazy, useState, type ComponentProps, type ReactNode } from 'react';
import { Boundary, Loading } from '../ui/bits';

const CascadeGraphLazy = lazy(() => import('./Graphs').then((m) => ({ default: m.CascadeGraph })));
const PlanGraphLazy = lazy(() => import('./Graphs').then((m) => ({ default: m.PlanGraph })));
const SampleDiffLazy = lazy(() => import('./SampleDiff').then((m) => ({ default: m.SampleDiff })));

export function CascadeGraph(props: ComponentProps<typeof CascadeGraphLazy>) {
  return (
    <Boundary label="cascade graph">
      <Suspense fallback={<Loading>Drawing the graph</Loading>}>
        <CascadeGraphLazy {...props} />
      </Suspense>
    </Boundary>
  );
}

export function PlanGraph(props: ComponentProps<typeof PlanGraphLazy>) {
  return (
    <Boundary label="plan graph">
      <Suspense fallback={<Loading>Drawing the graph</Loading>}>
        <PlanGraphLazy {...props} />
      </Suspense>
    </Boundary>
  );
}

export function SampleDiff(props: ComponentProps<typeof SampleDiffLazy>) {
  return (
    <Boundary label="sample rows">
      <Suspense fallback={<Loading>Loading the diff</Loading>}>
        <SampleDiffLazy {...props} />
      </Suspense>
    </Boundary>
  );
}

/** A disclosure that does not mount its contents, or fetch their code, until first opened. */
export function LazyFold({ summary, children }: { summary: ReactNode; children: () => ReactNode }) {
  const [opened, setOpened] = useState(false);
  return (
    <details
      className="fold"
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open) setOpened(true);
      }}
    >
      <summary>{summary}</summary>
      <div className="fold-body">{opened ? children() : null}</div>
    </details>
  );
}
