import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { BlastSection } from '../run/Blast';
import { BreakItPanel, type BreakResult } from '../run/BreakIt';
import { DecisionSection } from '../run/Decision';
import { ExplanationSection } from '../run/Explanation';
import { FlagsSection } from '../run/Flags';
import { FooterSection } from '../run/Footer';
import { GuardrailsSection } from '../run/Guardrails';
import { RunHeader } from '../run/Header';
import { AttemptsSection } from '../run/Attempts';
import { PlanSection } from '../run/Plan';
import { RehearsalSection } from '../run/Rehearsal';
import { RunRecordSection } from '../run/RunRecord';
import { notifyProdChanged } from '../api/client';
import { selectedAttempt, statusWord, storySteps } from '../run/derive';
import { useRun } from '../run/useRun';
import { isInProgress, statusInfo } from '../lib/status';
import { showTarget } from '../lib/target';
import { Link } from '../lib/router';
import { Boundary, Loading, Mark, Notice, Section } from '../ui/bits';

interface Item {
  id: string;
  title: string;
  aside?: ReactNode;
  body: ReactNode;
}

export function RunPage({ id }: { id: string }) {
  const { run, error, notFound, setRun, pollFast } = useRun(id);
  const [picked, setPicked] = useState<number | null>(null);
  const [activeId, setActiveId] = useState<string>('rehearsal');

  const inProgress = isInProgress(run?.status);
  const attempt = useMemo(() => (run ? selectedAttempt(run, picked) : null), [run, picked]);
  const steps = useMemo(() => (run ? storySteps(run, inProgress) : []), [run, inProgress]);
  const [breakResults, setBreakResults] = useState<Record<string, BreakResult[]>>({});
  const showBreakIt = run?.status === 'awaiting_approval' || run?.status === 'approved' || Object.keys(breakResults).length > 0;

  // The prod indicator follows the target this run is about.
  useEffect(() => {
    if (run?.target_id) showTarget(run.target_id);
  }, [run?.target_id]);

  // An apply can finish while the request that started it is still writing evidence, or in another tab.
  useEffect(() => {
    if (run?.status === 'applied' || run?.status === 'rolled_back' || run?.status === 'drift_detected') notifyProdChanged();
  }, [run?.status]);

  // Highlight the section in view in the rail.
  useEffect(() => {
    const els = [...document.querySelectorAll<HTMLElement>('.runcol .section')];
    if (!els.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (hit) setActiveId(hit.target.id);
      },
      { rootMargin: '-35% 0px -55% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [run?.status, attempt?.n]);

  if (notFound) {
    return (
      <div className="page">
        <h1 className="page-title">No such run</h1>
        <p>
          There is no run with the id <code className="mono">{id}</code>. <Link href="/">Start a new task</Link>.
        </p>
      </div>
    );
  }
  if (!run) {
    return (
      <div className="page">
        {error ? (
          <Notice tone="bad" title="Could not load this run.">
            {error}
          </Notice>
        ) : (
          <Loading>Loading the run</Loading>
        )}
      </div>
    );
  }

  const info = statusInfo(run.status);
  const selectedN = attempt?.n ?? null;
  const flags = run.data_flags ?? [];
  const waitingForAttempts = inProgress && !(run.attempts?.length);

  const items: Item[] = [
    {
      id: 'rehearsal',
      title: 'Rehearsal',
      aside: <span className="muted">Disposable clone, microVM, network: {attempt?.rehearsal?.limits?.network ?? 'none'}</span>,
      body: <RehearsalSection run={run} attempt={attempt} inProgress={inProgress} />,
    },
  ];
  if (steps.length > 1) {
    items.push({
      id: 'attempts',
      title: 'Attempts',
      body: <AttemptsSection run={run} steps={steps} selected={selectedN} onSelect={setPicked} />,
    });
  }
  if (!waitingForAttempts) {
    if (attempt?.plan || attempt?.gate) {
      items.push({ id: 'plan', title: 'Plan', body: <PlanSection attempt={attempt} /> });
    }
    if (attempt) {
      items.push({
        id: 'blast',
        title: 'Blast radius',
        aside: <span className="muted">Measured on the clone</span>,
        body: <BlastSection attempt={attempt} />,
      });
    }
    if (attempt || (run.guardrails?.length ?? 0) > 0) {
      items.push({ id: 'guardrails', title: 'Guardrails', body: <GuardrailsSection run={run} attempt={attempt} /> });
    }
    if (attempt?.report || attempt?.explanation) {
      items.push({
        id: 'explanation',
        title: 'Explanation',
        aside: <span className="muted">Commentary. Decides nothing.</span>,
        body: <ExplanationSection run={run} attempt={attempt} />,
      });
    }
    if (attempt) {
      items.push({ id: 'record', title: 'Run record', body: <RunRecordSection attempt={attempt} /> });
    }
  }
  items.push({ id: 'decision', title: 'Decision', body: <DecisionSection run={run} setRun={setRun} pollFast={pollFast} /> });
  if (showBreakIt) {
    items.push({
      id: 'break',
      title: 'Try to break it',
      aside: <span className="muted">Negative controls</span>,
      body: <BreakItPanel run={run} setRun={setRun} pollFast={pollFast} results={breakResults} setResults={setBreakResults} />,
    });
  }
  if (flags.length > 0) {
    items.push({
      id: 'flags',
      title: 'Data flags',
      aside: <span className="muted">Stored text that reads like instructions</span>,
      body: <FlagsSection flags={flags} />,
    });
  }
  if (!inProgress || run.rerun) {
    items.push({ id: 'commands', title: 'Commands and evidence', body: <FooterSection run={run} /> });
  }

  return (
    <div className="runpage">
      <aside className="rail" aria-label="Sections of this run">
        <div className={`rail-status tone-${info.tone}`}>
          <Mark tone={info.tone} size={13} />
          {statusWord(run, info.label)}
        </div>
        <ol className="rail-list">
          {items.map((it, i) => (
            <li key={it.id}>
              <a href={`#${it.id}`} className={activeId === it.id ? 'is-on' : undefined}>
                <span className="mono rail-n">{String(i + 1).padStart(2, '0')}</span>
                {it.title}
              </a>
            </li>
          ))}
        </ol>
      </aside>
      <div className="runcol">
        <Boundary label="header">
          <RunHeader run={run} />
        </Boundary>
        {error && (
          <Notice tone="caution" title="Lost contact with the server. Still trying.">
            {error}
          </Notice>
        )}
        {items.map((it, i) => (
          <Section key={it.id} id={it.id} index={String(i + 1).padStart(2, '0')} title={it.title} aside={it.aside}>
            <Boundary label={it.title}>{it.body}</Boundary>
          </Section>
        ))}
      </div>
    </div>
  );
}
