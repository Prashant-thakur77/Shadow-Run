import { useEffect, useState } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import type { SampleRow } from '../api/types';

function pretty(row: unknown): string {
  if (row === null || row === undefined) return '';
  return JSON.stringify(row, null, 2);
}

function usePhone() {
  const [phone, setPhone] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)');
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

const vars = {
  diffViewerBackground: 'var(--bg-inset)',
  diffViewerColor: 'var(--ink)',
  addedBackground: 'var(--good-bg)',
  addedColor: 'var(--ink)',
  removedBackground: 'var(--bad-bg)',
  removedColor: 'var(--ink)',
  wordAddedBackground: 'var(--good-line)',
  wordRemovedBackground: 'var(--bad-line)',
  addedGutterBackground: 'var(--good-bg)',
  removedGutterBackground: 'var(--bad-bg)',
  gutterBackground: 'var(--bg-inset)',
  gutterBackgroundDark: 'var(--bg-inset)',
  highlightBackground: 'var(--bg-2)',
  highlightGutterBackground: 'var(--bg-2)',
  codeFoldGutterBackground: 'var(--bg-1)',
  codeFoldBackground: 'var(--bg-1)',
  emptyLineBackground: 'var(--bg-inset)',
  gutterColor: 'var(--ink-3)',
  addedGutterColor: 'var(--ink-2)',
  removedGutterColor: 'var(--ink-2)',
  codeFoldContentColor: 'var(--ink-3)',
  diffViewerTitleBackground: 'var(--bg-1)',
  diffViewerTitleColor: 'var(--ink-2)',
  diffViewerTitleBorderColor: 'var(--line)',
};

const styles = {
  variables: { dark: vars, light: vars },
  contentText: { fontFamily: 'var(--font-mono)', fontSize: '12.5px', lineHeight: '1.5' },
  line: { wordBreak: 'break-word' as const },
  titleBlock: { fontFamily: 'var(--font-mono)', fontSize: '12px', padding: '6px 10px' },
};

/** Up to five rows, as JSON text. The viewer renders text nodes, so stored strings stay inert. */
export function SampleDiff({ rows, op }: { rows: SampleRow[]; op: string }) {
  const phone = usePhone();
  return (
    <div className="samples">
      {rows.map((r, i) => (
        <div className="sample" key={i}>
          <ReactDiffViewer
            oldValue={pretty(r.before)}
            newValue={pretty(r.after)}
            splitView={!phone}
            useDarkTheme
            hideLineNumbers
            showDiffOnly={op !== 'UPDATE'}
            extraLinesSurroundingDiff={1}
            compareMethod={DiffMethod.WORDS}
            leftTitle={r.before ? `Row ${i + 1}, before` : `Row ${i + 1}, did not exist`}
            rightTitle={r.after ? 'After' : 'After: row is gone'}
            styles={styles}
          />
        </div>
      ))}
    </div>
  );
}
