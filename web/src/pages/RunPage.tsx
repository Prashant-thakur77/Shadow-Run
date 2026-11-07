import './_styles';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BlastSection } from '../run/Blast';
import { BreakItPanel, type BreakResult } from '../run/BreakIt';
import { DecisionBar, DecisionSection } from '../run/Decision';
import { ExplanationSection } from '../run/Explanation';
import { FlagsSection } from '../run/Flags';
import { FooterSection } from '../run/Footer';
import { GuardrailsSection } from '../run/Guardrails';
import { handedOffRun } from '../run/handoff';
import { IncidentBanner } from '../run/IncidentBanner';
import { RaceBanner, RaceOriginBanner } from '../run/RaceBanner';
import { LearnSection } from '../run/Learn';
import { showsComparison, WithWithout } from '../run/WithWithout';
import { RunHeader, TaskBlock } from '../run/Header';
import { AttemptsSection } from '../run/Attempts';
import { PlanSection } from '../run/Plan';
import { StoppedProof, UndoRoundTrip } from '../run/ProdProof';
import { RehearsalSection } from '../run/Rehearsal';
import { RunRecordSection } from '../run/RunRecord';
import { RunRooms } from '../run/RunRooms';
import { api, notifyProdChanged } from '../api/client';
import type { Run } from '../api/types';
import { failedGuardrails, selectedAttempt, statusWord, storySteps } from '../run/derive';
import { useRun } from '../run/useRun';
import { isInProgress, runInfo, type Tone } from '../lib/status';
import { showTarget } from '../lib/target';
import { useAsync } from '../lib/useAsync';
import { Link } from '../lib/router';
import { Boundary, Loading, Mark, Notice, Section } from '../ui/bits';
import { plainNetwork } from '../ui/Figure';
import { Label } from '../ui/Label';
import { TwoRoomsEmpty } from '../ui/TwoRooms';

interface Item {
  id: string;
  title: string;
  aside?: ReactNode;
  body: ReactNode;
  /** Zone three: the record. Folded until someone asks for it. */
  record?: boolean;
  /** A failure this section found, shown as a small mark in the rail. */
  alert?: Tone;
}

/** The frames drawn empty and the run id, plus the task when Home handed it over, so its view transition has somewhere to land. */
function RunLoading({ id, error }: { id: string; error: string | null }) {
  const handed = handedOffRun(id);
  return (
    <div className="runpage">
      <div className="run-verdict">
        <header className="runhead tone-neutral">
          <div className="runhead-verdict">
            <Label>The verdict</Label>
            <p className="runhead-word t-display-l">{error ? 'Not loaded' : 'Loading'}</p>
          </div>
          <div className="runhead-facts">
            {handed && <TaskBlock text={handed.text} plan={handed.plan} />}
            <p className="mono runhead-loadingid">{id}</p>
          </div>
        </header>
        {error ? (
          <Notice tone="bad" title="Could not load this run.">
            {error}
          </Notice>
        ) : (
          <div className="run-rooms is-empty">
            <TwoRoomsEmpty loading clone={<Loading>Reading the run</Loading>} />
          </div>
        )}
      </div>
    </div>
  );
}

/** A section in zone three: one line until it's opened. It stays mounted, so typing into Learn survives being folded. */
function RecordSection({ item, index, open, onToggle }: { item: Item; index: string; open: boolean; onToggle: (id: string, open: boolean) => void }) {
  return (
    <details className="section record-section" id={item.id} open={open} onToggle={(e) => onToggle(item.id, (e.target as HTMLDetailsElement).open)}>
      <summary className="section-head">
        <span className="section-index mono">{index}</span>
        <h2 className="section-title" id={`${item.id}-title`}>
          {item.title}
        </h2>
        {item.aside && <div className="section-aside">{item.aside}</div>}
      </summary>
      <div className="section-body">
        <Boundary label={item.title}>{item.body}</Boundary>
      </div>
    </details>
  );
}

/** One pill that travels along the line to the section in view. */
function Rail({ items, activeId, info, word, onGo }: { items: Item[]; activeId: string; info: { tone: Tone }; word: string; onGo: (id: string) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const track = trackRef.current;
    const pill = pillRef.current;
    if (!track || !pill) return;
    const link = track.querySelector<HTMLElement>('a.is-on');
    pill.style.opacity = link ? '1' : '0';
    if (link) pill.style.transform = `translateY(${link.offsetTop + link.offsetHeight / 2 - 6}px)`;
  }, [activeId, items.length]);
  return (
    <aside className="rail" aria-label="Sections of this run">
      <div className={`rail-status tone-${info.tone}`}>
        <Mark tone={info.tone} size={13} />
        {word}
      </div>
      <div className="rail-track" ref={trackRef}>
        <span className="rail-pill" ref={pillRef} aria-hidden="true" />
        <ol className="rail-list">
        {items.map((it, i) => (
          <li key={it.id} className={it.record && !items[i - 1]?.record ? 'rail-break' : undefined}>
            <a href={`#${it.id}`} className={activeId === it.id ? 'is-on' : undefined} aria-current={activeId === it.id ? 'true' : undefined} onClick={() => onGo(it.id)}>
              <span className="mono rail-n">{String(i + 1).padStart(2, '0')}</span>
              <span className="rail-title">{it.title}</span>
              {it.alert && <Mark tone={it.alert} size={11} />}
            </a>
          </li>
        ))}
        </ol>
      </div>
    </aside>
  );
}

export function RunPage({ id }: { id: string }) {
  const { run, error, notFound, setRun, pollFast } = useRun(id);
  const [picked, setPicked] = useState<number | null>(null);
  const [activeId, setActiveId] = useState<string>('decision');
  const [openRecord, setOpenRecord] = useState<Record<string, boolean>>({});

  const inProgress = isInProgress(run?.status);
  const attempt = useMemo(() => (run ? selectedAttempt(run, picked) : null), [run, picked]);
  const steps = useMemo(() => (run ? storySteps(run, inProgress) : []), [run, inProgress]);
  const [breakResults, setBreakResults] = useState<Record<string, BreakResult[]>>({});
  // A race's runs refuse every approval, so the controls on this panel would say nothing useful.
  const showBreakIt = !run?.race && !run?.expired && (run?.status === 'awaiting_approval' || run?.status === 'approved' || Object.keys(breakResults).length > 0);
  // A plan from a race was written in that race, so what the agent went through is on the race's run.
  const originId = run?.from_race?.run;
  const origin = useAsync<Run | null>(() => (originId ? api.run(originId) : Promise.resolve(null)), [originId]);

  // The prod indicator follows the target this run is about.
  useEffect(() => {
    if (run?.target_id) showTarget(run.target_id);
  }, [run?.target_id]);

  // An apply can finish while the request that started it is still writing evidence, or in another tab.
  useEffect(() => {
    if (run?.status === 'applied' || run?.status === 'rolled_back' || run?.status === 'drift_detected') notifyProdChanged();
  }, [run?.status]);

  // A stopped apply can come from far down the page, and the sections shift when it does. The answer is at the top.
  const lastStatus = useRef(run?.status);
  useEffect(() => {
    const was = lastStatus.current;
    lastStatus.current = run?.status;
    const fromApply = was === 'approved' || was === 'applying';
    if (fromApply && (run?.status === 'rolled_back' || run?.status === 'drift_detected')) window.scrollTo({ top: 0 });
  }, [run?.status]);

  const toggleRecord = useCallback((itemId: string, open: boolean) => {
    setOpenRecord((prev) => (!!prev[itemId] === open ? prev : { ...prev, [itemId]: open }));
  }, []);

  // Someone who rejected a plan has a reason in hand, and this is where it turns into a guardrail.
  useEffect(() => {
    if (run?.status === 'rejected') toggleRecord('learn', true);
  }, [run?.status, toggleRecord]);

  // Arriving at a section link, such as "Try to break it" on the home page. Sections appear as the run moves, and the ones
  // above the target keep growing as they load, so this follows the target until the page settles or the person scrolls.
  const jumped = useRef(false);
  useEffect(() => {
    if (jumped.current || !location.hash) return;
    const hash = location.hash.slice(1);
    const el = document.getElementById(hash);
    if (!el) return;
    jumped.current = true;
    if (el.tagName === 'DETAILS') toggleRecord(hash, true);
    const follow = () => el.scrollIntoView({ behavior: 'instant' });
    follow();
    const grown = new ResizeObserver(follow);
    grown.observe(document.querySelector('.runpage') ?? document.body);
    const stop = () => {
      grown.disconnect();
      window.clearTimeout(timer);
      for (const type of ['wheel', 'touchstart', 'keydown']) window.removeEventListener(type, stop);
    };
    const timer = window.setTimeout(stop, 2000);
    for (const type of ['wheel', 'touchstart', 'keydown']) window.addEventListener(type, stop, { passive: true });
  }, [run?.status, toggleRecord]);

  // A section link on a page that's already here, such as going back. A closed fold has nothing to scroll to.
  useEffect(() => {
    const onHash = () => {
      const hash = location.hash.slice(1);
      const el = hash ? document.getElementById(hash) : null;
      if (el?.tagName !== 'DETAILS' || (el as HTMLDetailsElement).open) return;
      toggleRecord(hash, true);
      requestAnimationFrame(() => el.scrollIntoView());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [toggleRecord]);

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
  if (!run) return <RunLoading id={id} error={error} />;

  const info = runInfo(run);
  const needsYou = (run.status === 'awaiting_approval' && !run.expired) || run.status === 'approved';
  const selectedN = attempt?.n ?? null;
  const flags = run.data_flags ?? [];
  const waitingForAttempts = inProgress && !(run.attempts?.length);
  const failedHere = attempt ? failedGuardrails(attempt) : 0;
  const anyAttemptFailed = (run.attempts ?? []).some((a) => a.verdict && a.verdict !== 'passed' && a.verdict !== 'read_only_plan');
  const gateVerdict = attempt?.gate?.verdict;

  // Zone two is the evidence, with the decision first. Zone three is the record, folded.
  const items: Item[] = [
    {
      id: 'decision',
      title: 'Decision',
      alert: needsYou ? 'wait' : undefined,
      body: <DecisionSection run={run} origin={origin.data} setRun={setRun} pollFast={pollFast} />,
    },
  ];
  if (showsComparison(run)) {
    items.push({
      id: 'compare',
      title: 'Without and with Shadow Run',
      body: <WithWithout run={run} />,
    });
  }
  if (showBreakIt) {
    items.push({
      id: 'break',
      title: 'Try to break it',
      aside: <span className="muted">Negative controls</span>,
      body: <BreakItPanel run={run} setRun={setRun} pollFast={pollFast} results={breakResults} setResults={setBreakResults} />,
    });
  }
  items.push({
    id: 'rehearsal',
    title: 'Rehearsal',
    aside: <span className="muted">Disposable clone, microVM, network: {plainNetwork(attempt?.rehearsal?.limits?.network ?? 'none')}</span>,
    alert: attempt?.rehearsal?.sandbox_error || attempt?.rehearsal?.contained === false ? 'bad' : undefined,
    body: <RehearsalSection run={run} attempt={attempt} inProgress={inProgress} selected={selectedN} onSelect={setPicked} />,
  });
  if (steps.length > 1) {
    items.push({
      id: 'attempts',
      title: 'Attempts',
      alert: anyAttemptFailed ? 'bad' : undefined,
      body: <AttemptsSection run={run} steps={steps} selected={selectedN} onSelect={setPicked} />,
    });
  }
  if (!waitingForAttempts) {
    if (attempt?.plan || attempt?.gate) {
      items.push({
        id: 'plan',
        title: 'Plan',
        alert: gateVerdict === 'block' ? 'bad' : gateVerdict === 'review' ? 'caution' : undefined,
        body: <PlanSection attempt={attempt} />,
      });
    }
    if (attempt) {
      items.push({
        id: 'blast',
        title: 'Blast radius',
        aside: <span className="muted">Measured on the clone</span>,
        alert: (attempt.report?.capture_gaps?.length ?? 0) > 0 ? 'bad' : (attempt.report?.unlogged_changes?.length ?? 0) > 0 ? 'caution' : undefined,
        body: <BlastSection attempt={attempt} seeded={run.target_id?.startsWith('demo') ?? false} />,
      });
    }
    if (attempt || (run.guardrails?.length ?? 0) > 0) {
      items.push({ id: 'guardrails', title: 'Guardrails', alert: failedHere > 0 ? 'bad' : undefined, body: <GuardrailsSection run={run} attempt={attempt} /> });
    }
    if (attempt?.report || attempt?.explanation) {
      items.push({
        id: 'explanation',
        title: 'Explanation',
        record: true,
        aside: <span className="muted">Commentary. Decides nothing.</span>,
        body: <ExplanationSection run={run} attempt={attempt} />,
      });
    }
    if (attempt) {
      items.push({ id: 'record', title: 'Run record', record: true, alert: attempt.rehearsal?.contained === false ? 'bad' : undefined, body: <RunRecordSection attempt={attempt} /> });
    }
  }
  // Learning needs a plan of SQL statements, so a Linux host has nothing to offer here.
  if (['rejected', 'applied', 'awaiting_approval'].includes(run.status) && run.final?.report?.kind !== 'host' && run.final?.plan && !run.race) {
    items.push({
      id: 'learn',
      title: 'Turn this into a guardrail',
      record: true,
      aside: <span className="muted">Learn from a rejection</span>,
      body: <LearnSection run={run} />,
    });
  }
  if (flags.length > 0) {
    items.push({
      id: 'flags',
      title: 'Data flags',
      record: true,
      alert: 'caution',
      aside: <span className="muted">Stored text that reads like instructions</span>,
      body: <FlagsSection flags={flags} />,
    });
  }
  if (!inProgress || run.rerun) {
    items.push({ id: 'commands', title: 'Commands and evidence', record: true, body: <FooterSection run={run} /> });
  }

  const word = statusWord(run, info.label);
  const goTo = (itemId: string) => {
    if (items.find((it) => it.id === itemId)?.record) toggleRecord(itemId, true);
  };
  const number = (it: Item) => String(items.indexOf(it) + 1).padStart(2, '0');

  return (
    <div className={needsYou ? 'runpage is-waiting' : 'runpage'}>
      <div className="run-verdict">
        <Boundary label="header">
          <div className="run-fold">
            <RunHeader run={run} origin={origin.data} />
            <nav className="rail-chips" aria-label="Sections of this run, phone">
              {items.map((it) => (
                <a key={it.id} href={`#${it.id}`} onClick={() => goTo(it.id)}>
                  {it.alert && <Mark tone={it.alert} size={11} />}
                  {it.title}
                </a>
              ))}
            </nav>
            <RunRooms run={run} attempt={attempt} picked={picked} />
          </div>
          {run.incident && <IncidentBanner incident={run.incident} />}
          {run.race && <RaceBanner race={run.race} />}
          {run.from_race && <RaceOriginBanner run={run} />}
          <UndoRoundTrip run={run} />
          <StoppedProof run={run} />
        </Boundary>
        {error && (
          <Notice tone="caution" title="Lost contact with the server. Still trying.">
            {error}
          </Notice>
        )}
      </div>
      <div className="run-body">
        <Rail items={items} activeId={activeId} info={info} word={word} onGo={goTo} />
        <div className="runcol">
          <div className="run-zone-label">
            <Label>The evidence</Label>
          </div>
          {items
            .filter((it) => !it.record)
            .map((it) => (
              <Section key={it.id} id={it.id} index={number(it)} title={it.title} aside={it.aside}>
                <Boundary label={it.title}>{it.body}</Boundary>
              </Section>
            ))}
          {items.some((it) => it.record) && (
            <div className="run-zone-label run-zone-record">
              <Label>The record</Label>
            </div>
          )}
          {items
            .filter((it) => it.record)
            .map((it) => (
              <RecordSection key={it.id} item={it} index={number(it)} open={!!openRecord[it.id]} onToggle={toggleRecord} />
            ))}
        </div>
      </div>
      <DecisionBar run={run} setRun={setRun} pollFast={pollFast} />
    </div>
  );
}
